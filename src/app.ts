import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Bindings, WorkerConfig } from "./config";
import { loadConfig, LIMITS } from "./config";
import { randomId, sha256, timingSafeEqual } from "./crypto";
import {
  UploadMetadataSchema,
  PricingQuerySchema,
  UploadIdSchema,
  FeedbackSchema,
  type UploadMetadata,
} from "./schemas";
import { pricePermanent, priceTemporary, atomicToUsd } from "./pricing";
import { sendError, isHighEntropyKey } from "./http";
import { hashSource, mint, deriveUploadToken, deriveDeleteToken } from "./tokens";
import { utcDay, reserveQuota, bumpUploadCount, reserveCount } from "./quota";
import { allowPerMinute } from "./feedback-rate";
import * as rows from "./db/uploads";
import { deleteObject } from "./storage";
import { contentDisposition, SECURITY_HEADERS } from "./security";
import { isPermanentPaymentEnabled, permanentPaymentMiddleware } from "./payment";

export type Env = Bindings & Record<string, unknown>;
type EnvBindings = { Bindings: Env };
type C = Context<EnvBindings>;

const UPLOAD_CONTENT = "application/octet-stream";
const DAY = 86400;

export const app = new Hono<EnvBindings>();

type UploadRow = import("./db/uploads").UploadRow;
type UploadStatus = import("./db/uploads").UploadStatus;

class QuotaExceededError extends Error {}

function cfg(c: C): WorkerConfig {
  return loadConfig({ ...c.env });
}
function publicHost(c: C): string {
  const w = cfg(c);
  return w.STUPID_UPLOAD_FILES_HOST ?? w.STUPID_UPLOAD_BASE_URL;
}
function publicUrl(c: C, row: UploadRow): string {
  return `${publicHost(c)}/f/${row.id}/${encodeURIComponent(row.filename)}`;
}
function sourceOf(c: C): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Idempotency key for a reservation. Temporary + direct reservations require a
 * caller-supplied high-entropy `Idempotency-Key`; paid requests accepted from
 * generic x402 clients (e.g. knox) don't carry one, so we synthesize a key so
 * the (source, key) uniqueness still holds.
 */
function resolveIdempotencyKey(c: C): string {
  const key = c.req.header("idempotency-key") ?? "";
  return key.length >= 32 ? key : `x402_${randomId()}`;
}

function effectiveStatus(row: UploadRow, now: number): UploadStatus {
  if (row.status === "deleted" || row.status === "expired") return row.status;
  if (row.status === "pending" && row.upload_expires_at !== null && now >= row.upload_expires_at) {
    return "expired";
  }
  if (
    row.status === "ready" &&
    row.retention === "temporary" &&
    row.expires_at !== null &&
    now >= row.expires_at
  ) {
    return "expired";
  }
  return row.status;
}

async function persistEffectiveStatus(
  db: D1Database,
  row: UploadRow,
  now: number,
): Promise<UploadRow> {
  const status = effectiveStatus(row, now);
  if (status === "expired" && row.status !== "expired") {
    await rows.markExpired(db, row.id, now);
    return { ...row, status: "expired" };
  }
  return row;
}

async function readMetadata(
  c: C,
): Promise<{ ok: true; data: UploadMetadata } | { ok: false; msg: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, msg: "request body must be valid JSON" };
  }
  const parsed = UploadMetadataSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, msg: parsed.error.issues[0]?.message ?? "invalid metadata" };
  return { ok: true, data: parsed.data };
}

async function reserve(
  c: C,
  meta: UploadMetadata,
  retention: "temporary" | "permanent",
  opts: {
    uploadExpiresAt: number;
    expiresAt: number | null;
    priceAtomic: number | null;
    paymentNetwork: string | null;
  },
): Promise<UploadRow> {
  const w = cfg(c);
  const sourceHash = await hashSource(w.STUPID_UPLOAD_HMAC_SECRET, sourceOf(c));
  const idemKey = resolveIdempotencyKey(c);
  const existing = await rows.getByIdempotencyKey(c.env.DB, sourceHash, idemKey);
  if (existing) return existing;
  if (retention === "temporary") {
    const day = utcDay();
    const srcOk = await reserveQuota(
      c.env.DB,
      "source",
      sourceHash,
      day,
      meta.sizeBytes,
      w.STUPID_UPLOAD_SOURCE_DAILY_QUOTA_BYTES,
    );
    const globOk = await reserveQuota(
      c.env.DB,
      "global",
      "all",
      day,
      meta.sizeBytes,
      w.STUPID_UPLOAD_GLOBAL_DAILY_QUOTA_BYTES,
    );
    if (!srcOk || !globOk) throw new QuotaExceededError();
  }
  const id = await randomId();
  const tokens = await mint(id, w.STUPID_UPLOAD_HMAC_SECRET);
  const now = nowSec();
  await rows.insertReservation(c.env.DB, {
    id,
    object_key: `${retention}/${id}`,
    filename: meta.filename,
    content_type: meta.contentType,
    size_bytes: meta.sizeBytes,
    sha256: meta.sha256,
    retention,
    source_hash: sourceHash,
    idempotency_key: idemKey,
    upload_token_hash: tokens.uploadTokenHash,
    delete_token_hash: tokens.deleteTokenHash,
    upload_expires_at: opts.uploadExpiresAt,
    expires_at: opts.expiresAt,
    created_at: now,
    price_atomic: opts.priceAtomic,
    payment_network: opts.paymentNetwork,
    payment_receipt: null,
  });
  return (await rows.getById(c.env.DB, id))!;
}

async function reservationJson(c: C, row: UploadRow, includeTokens: boolean) {
  const w = cfg(c);
  const [uploadToken, deleteToken] = await Promise.all([
    deriveUploadToken(w.STUPID_UPLOAD_HMAC_SECRET, row.id),
    deriveDeleteToken(w.STUPID_UPLOAD_HMAC_SECRET, row.id),
  ]);
  return {
    id: row.id,
    retention: row.retention,
    status: row.status,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    uploadToken: includeTokens ? uploadToken : null,
    deleteToken: includeTokens ? deleteToken : null,
    uploadUrl: `${w.STUPID_UPLOAD_BASE_URL}/v1/uploads/${row.id}/content`,
    contentHeaders: { "content-type": UPLOAD_CONTENT, "content-length": String(row.size_bytes) },
    publicUrl: publicUrl(c, row),
    uploadDeadline: row.upload_expires_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    priceAtomic: row.price_atomic != null ? String(row.price_atomic) : null,
    priceUsd: row.price_atomic != null ? atomicToUsd(BigInt(row.price_atomic)) : null,
    paymentNetwork: row.payment_network,
    createdAt: row.created_at,
  };
}

// --------------------------------------------------------------------------
// GET /health
// --------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok" }));

// --------------------------------------------------------------------------
// GET /v1/pricing  (advisory)
// --------------------------------------------------------------------------
app.get("/v1/pricing", (c) => {
  const parsed = PricingQuerySchema.safeParse(c.req.query());
  if (!parsed.success || parsed.data.sizeBytes > LIMITS.maxPermanentBytes) {
    return sendError(c, 400, "validation_error", "sizeBytes must be an integer within limits");
  }
  const { sizeBytes } = parsed.data;
  if (sizeBytes <= LIMITS.maxTemporaryBytes) {
    return c.json({ ...priceTemporary(sizeBytes), permanent: pricePermanent(sizeBytes) });
  }
  return c.json(pricePermanent(sizeBytes));
});

// --------------------------------------------------------------------------
// POST /v1/uploads/temporary
// --------------------------------------------------------------------------
app.post("/v1/uploads/temporary", async (c) => {
  const key = c.req.header("idempotency-key");
  if (!isHighEntropyKey(key))
    return sendError(
      c,
      400,
      "invalid_request",
      "Idempotency-Key header required (>= 32 high-entropy chars)",
    );
  const meta = await readMetadata(c);
  if (!meta.ok) return sendError(c, 400, "validation_error", meta.msg);
  if (meta.data.sizeBytes > LIMITS.maxTemporaryBytes) {
    return sendError(
      c,
      413,
      "payload_too_large",
      `temporary uploads are limited to ${LIMITS.maxTemporaryBytes} bytes`,
    );
  }
  const w = cfg(c);
  const now = nowSec();
  let row: UploadRow;
  try {
    row = await reserve(c, meta.data, "temporary", {
      uploadExpiresAt: now + w.STUPID_UPLOAD_PENDING_LIFETIME_SECONDS,
      expiresAt: now + DAY,
      priceAtomic: null,
      paymentNetwork: null,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError)
      return sendError(
        c,
        429,
        "quota_exceeded",
        "daily upload quota exhausted; retry after midnight UTC",
      );
    throw err;
  }
  return c.json(await reservationJson(c, row, true), 201);
});

// --------------------------------------------------------------------------
// POST /v1/uploads/permanent  (phase 4: x402 payment)
// --------------------------------------------------------------------------
// POST /v1/uploads/permanent  (x402-gated, dynamic Base USDC pricing)
// --------------------------------------------------------------------------

/** If the requester already holds a permanent reservation for this key, hand it
 *  back WITHOUT invoking payment again (idempotent recovery of a funded slot). */
async function findExistingPermanent(c: C): Promise<UploadRow | null> {
  const key = c.req.header("idempotency-key") ?? "";
  if (!isHighEntropyKey(key)) return null;
  const w = cfg(c);
  const sourceHash = await hashSource(w.STUPID_UPLOAD_HMAC_SECRET, sourceOf(c));
  const row = await rows.getByIdempotencyKey(c.env.DB, sourceHash, key);
  if (!row || row.retention !== "permanent") return null;
  const status = effectiveStatus(row, nowSec());
  return status === "pending" || status === "ready" ? row : null;
}

let permMiddleware: MiddlewareHandler | null = null;
let permMiddlewareKey = "";

app.use("/v1/uploads/permanent", async (c, next) => {
  const w = cfg(c);
  const existing = await findExistingPermanent(c);
  if (existing) return c.json(await reservationJson(c, existing, true), 201);

  if (isPermanentPaymentEnabled(w)) {
    const key = `${w.STUPID_UPLOAD_FACILITATOR_URL}|${w.STUPID_UPLOAD_PAYMENT_NETWORK}|${w.STUPID_UPLOAD_PAYMENT_ADDRESS}`;
    if (!permMiddleware || permMiddlewareKey !== key) {
      permMiddleware = permanentPaymentMiddleware(w);
      permMiddlewareKey = key;
    }
    return permMiddleware(c, next);
  }
  return next();
});

app.post("/v1/uploads/permanent", async (c) => {
  const meta = await readMetadata(c);
  if (!meta.ok) return sendError(c, 400, "validation_error", meta.msg);
  if (meta.data.sizeBytes > LIMITS.maxPermanentBytes) {
    return sendError(
      c,
      413,
      "payload_too_large",
      `permanent uploads are limited to ${LIMITS.maxPermanentBytes} bytes`,
    );
  }
  const w = cfg(c);
  const paidAllowed = w.STUPID_UPLOAD_ALLOW_UNPAID_PERMANENT || isPermanentPaymentEnabled(w);
  if (!paidAllowed) {
    return sendError(
      c,
      501,
      "server_error",
      "permanent uploads require x402 payment integration (not yet enabled)",
    );
  }
  const now = nowSec();
  const price = pricePermanent(meta.data.sizeBytes);
  let row: UploadRow;
  try {
    row = await reserve(c, meta.data, "permanent", {
      uploadExpiresAt: now + w.STUPID_UPLOAD_PENDING_LIFETIME_SECONDS,
      expiresAt: null,
      priceAtomic: Number(price.priceAtomic),
      paymentNetwork: w.STUPID_UPLOAD_PAYMENT_NETWORK,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError)
      return sendError(c, 429, "quota_exceeded", "daily upload quota exhausted");
    throw err;
  }
  return c.json(await reservationJson(c, row, true), 201);
});

// --------------------------------------------------------------------------
// GET /v1/uploads/:id  (status; no secrets)
// --------------------------------------------------------------------------
app.get("/v1/uploads/:id", async (c) => {
  const p = UploadIdSchema.safeParse(c.req.param());
  if (!p.success) return sendError(c, 400, "validation_error", "invalid upload id");
  const row = await rows.getById(c.env.DB, p.data.id);
  if (!row) return sendError(c, 404, "not_found", "unknown upload");
  const now = nowSec();
  const live = await persistEffectiveStatus(c.env.DB, row, now);
  const status = effectiveStatus(row, now);
  if (status === "expired" || status === "deleted")
    return sendError(c, 410, "gone", "upload is no longer available");
  if (status === "pending")
    return c.json({ ...(await reservationJson(c, live, false)), status: "pending" }, 200);
  return c.json(await reservationJson(c, live, false), 200);
});

// --------------------------------------------------------------------------
// PUT /v1/uploads/:id/content  (stream upload)
// --------------------------------------------------------------------------
app.put("/v1/uploads/:id/content", async (c) => {
  const p = UploadIdSchema.safeParse(c.req.param());
  if (!p.success) return sendError(c, 400, "validation_error", "invalid upload id");
  const row = await rows.getById(c.env.DB, p.data.id);
  if (!row) return sendError(c, 404, "not_found", "unknown upload");

  const now = nowSec();
  const status = effectiveStatus(row, now);
  if (status === "expired") return sendError(c, 410, "gone", "upload slot expired");
  if (status === "deleted") return sendError(c, 410, "gone", "upload deleted");
  if (status === "ready") return sendError(c, 409, "conflict", "upload already completed");

  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const presentedHash = await sha256(bearer);
  if (bearer.length === 0 || !timingSafeEqual(presentedHash, row.upload_token_hash)) {
    return sendError(c, 401, "unauthorized", "invalid upload token");
  }

  const contentLengthRaw = c.req.header("content-length");
  if (contentLengthRaw === null)
    return sendError(c, 411, "invalid_request", "Content-Length header required");
  const contentLength = Number(contentLengthRaw);
  if (!Number.isInteger(contentLength) || contentLength !== row.size_bytes) {
    return sendError(
      c,
      411,
      "invalid_request",
      "Content-Length must exactly match the reservation",
    );
  }
  const bodyCType = c.req.header("content-type") ?? "";
  if (!bodyCType.startsWith(UPLOAD_CONTENT)) {
    return sendError(c, 415, "invalid_request", "Content-Type must be application/octet-stream");
  }

  const bucket = c.env.FILES;
  try {
    await bucket.put(row.object_key, c.req.raw.body, {
      httpMetadata: { contentType: row.content_type },
      customMetadata: { retention: row.retention, sha256: row.sha256 },
      sha256: row.sha256,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "integrity verification failed";
    if (/checksum|sha|hash|integrity/i.test(detail)) {
      return sendError(
        c,
        400,
        "integrity_check",
        "SHA-256 mismatch: uploaded bytes do not match the reservation",
      );
    }
    throw err;
  }

  const ready = await rows.markReady(c.env.DB, row.id, now, row.expires_at);
  if (!ready) {
    await deleteObject(bucket, row.object_key);
    return sendError(c, 409, "conflict", "upload slot was already completed; object compensated");
  }
  await bumpUploadCount(c.env.DB, "source", row.source_hash, utcDay());
  void bumpUploadCount(c.env.DB, "global", "all", utcDay());

  const obj = await bucket.get(row.object_key);
  return c.json(
    {
      id: row.id,
      publicUrl: publicUrl(c, row),
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      retention: row.retention,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      etag: obj?.httpEtag ?? undefined,
    },
    201,
  );
});

// --------------------------------------------------------------------------
// DELETE /v1/uploads/:id  (idempotent)
// --------------------------------------------------------------------------
app.delete("/v1/uploads/:id", async (c) => {
  const p = UploadIdSchema.safeParse(c.req.param());
  if (!p.success) return sendError(c, 400, "validation_error", "invalid upload id");
  const row = await rows.getById(c.env.DB, p.data.id);
  if (!row) return sendError(c, 404, "not_found", "unknown upload");

  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const presentedHash = await sha256(bearer);
  if (bearer.length === 0 || !timingSafeEqual(presentedHash, row.delete_token_hash)) {
    return sendError(c, 401, "unauthorized", "invalid delete token");
  }

  const now = nowSec();
  if (row.status !== "deleted" && row.status !== "expired") {
    await deleteObject(c.env.FILES, row.object_key);
    await rows.markDeleted(c.env.DB, row.id, now);
  }
  return c.json({ id: row.id, status: "deleted", deletedAt: now }, 200);
});

// --------------------------------------------------------------------------
// /f/:id/:filename  (download / HEAD, ranges, conditional)
// --------------------------------------------------------------------------

type RangeSpec = { offset: number; length: number } | { suffix: number };

function parseRange(header: string, size: number): RangeSpec | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  if (s === "") {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { suffix: Math.min(n, size) };
  }
  const start = Number(s);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  if (e === "") return { offset: start, length: size - start };
  const end = Number(e);
  if (!Number.isFinite(end) || end < start) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function applySecurity(h: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
}

function resolveRange(range: RangeSpec, size: number): { start: number; end: number } {
  if ("offset" in range) return { start: range.offset, end: range.offset + range.length - 1 };
  return { start: Math.max(0, size - range.suffix), end: size - 1 };
}

function cacheControlFor(row: UploadRow): string {
  return row.retention === "temporary"
    ? "private, no-store"
    : "public, max-age=31536000, immutable";
}

async function serveFile(c: C, method: "GET" | "HEAD"): Promise<Response> {
  const p = UploadIdSchema.safeParse(c.req.param());
  if (!p.success) return sendError(c, 404, "not_found", "invalid upload id");
  const row = await rows.getById(c.env.DB, p.data.id);
  if (!row) return sendError(c, 404, "not_found", "unknown upload");

  const now = nowSec();
  const status = effectiveStatus(row, now);
  if (status === "expired" || status === "deleted")
    return sendError(c, 410, "gone", "upload is no longer available");
  if (status !== "ready") return sendError(c, 404, "not_found", "upload content not available yet");

  const requested = decodeURIComponent(c.req.param("filename") ?? "");
  if (requested !== row.filename) {
    return new Response(null, {
      status: 301,
      headers: { location: publicUrl(c, row), "cache-control": "no-store" },
    });
  }

  const bucket = c.env.FILES;
  const head = await bucket.head(row.object_key);
  if (!head) return sendError(c, 404, "not_found", "content missing");

  const etag = head.httpEtag;
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch) {
    if (ifNoneMatch === "*" || ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
      const h = new Headers({ etag });
      applySecurity(h);
      return new Response(null, { status: 304, headers: h });
    }
  }

  const rangeHeader = c.req.header("range");
  if (method === "GET" && rangeHeader) {
    const spec = parseRange(rangeHeader, head.size);
    if (spec) {
      const obj = await bucket.get(row.object_key, { range: spec });
      const resolved = obj ? resolveRange(spec, head.size) : null;
      if (obj && resolved) {
        const h = buildFileResponse(
          row,
          head,
          { start: resolved.start, end: resolved.end },
          206,
          etag,
        );
        return new Response(obj.body, { status: 206, headers: h });
      }
    }
  }

  const full = await bucket.get(row.object_key);
  if (!full) return sendError(c, 404, "not_found", "content missing");
  return new Response(method === "HEAD" ? null : full.body, {
    status: 200,
    headers: buildFileResponse(row, head, null, 200, etag),
  });
}

function buildFileResponse(
  row: UploadRow,
  head: R2Object,
  range: { start: number; end: number } | null,
  status: number,
  etag: string,
): Headers {
  const h = new Headers();
  h.set("etag", etag);
  h.set("content-type", row.content_type);
  h.set("content-disposition", contentDisposition(row.content_type, row.filename));
  h.set("accept-ranges", "bytes");
  h.set("cache-control", cacheControlFor(row));
  applySecurity(h);
  if (status === 206 && range) {
    h.set("content-length", String(range.end - range.start + 1));
    h.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
  } else {
    h.set("content-length", String(head.size));
  }
  return h;
}

app.get("/f/:id/:filename", (c) => serveFile(c, "GET"));
app.on("HEAD", "/f/:id/:filename", (c) => serveFile(c, "HEAD"));

// --------------------------------------------------------------------------
// POST /v1/feedback
// --------------------------------------------------------------------------
app.post("/v1/feedback", async (c) => {
  const w = cfg(c);
  const sourceHash = await hashSource(w.STUPID_UPLOAD_HMAC_SECRET, sourceOf(c));

  // Per-minute burst throttle (in-process; D1 daily counters are authoritative
  // for long windows). When a Rate Limiting binding is configured we also blur
  // it below.
  if (!allowPerMinute(sourceHash, w.STUPID_UPLOAD_FEEDBACK_PER_MINUTE_LIMIT)) {
    return sendError(c, 429, "rate_limited", "too many submissions; slow down");
  }
  if (c.env.LIMITER) {
    try {
      await c.env.LIMITER.limit({ key: sourceHash });
    } catch {
      return sendError(c, 429, "rate_limited", "rate limit exceeded");
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return sendError(c, 400, "validation_error", "request body must be valid JSON");
  }
  const parsed = FeedbackSchema.safeParse(rawBody);
  if (!parsed.success)
    return sendError(
      c,
      400,
      "validation_error",
      parsed.error.issues[0]?.message ?? "invalid feedback",
    );

  const day = utcDay();
  const srcOk = await reserveCount(
    c.env.DB,
    "source",
    sourceHash,
    day,
    w.STUPID_UPLOAD_FEEDBACK_SOURCE_DAILY_LIMIT,
  );
  const globOk = await reserveCount(
    c.env.DB,
    "global",
    "-feedback-",
    day,
    w.STUPID_UPLOAD_FEEDBACK_GLOBAL_DAILY_LIMIT,
  );
  if (!srcOk || !globOk)
    return sendError(c, 429, "rate_limited", "feedback limit reached for today");

  const id = "fb_" + (await randomId());
  const now = nowSec();
  const d = parsed.data;
  await c.env.DB.prepare(
    `INSERT INTO feedback
       (id, category, message, rating, related_upload_id, request_id, client_name, client_version, source_hash, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'new',?10,?10)`,
  )
    .bind(
      id,
      d.category,
      d.message,
      d.rating ?? null,
      d.relatedUploadId ?? null,
      d.requestId ?? null,
      d.client?.name ?? null,
      d.client?.version ?? null,
      sourceHash,
      now,
    )
    .run();

  return c.json(
    { feedbackId: id, status: "accepted", receivedAt: new Date(now * 1000).toISOString() },
    202,
  );
});

// --------------------------------------------------------------------------
// Admin abuse/legal takedown
// --------------------------------------------------------------------------
app.delete("/_admin/uploads/:id", async (c) => {
  const w = cfg(c);
  const secret = c.req.header("x-admin-secret") ?? "";
  if (secret.length === 0 || secret !== w.STUPID_UPLOAD_ADMIN_SECRET) {
    return sendError(c, 401, "unauthorized", "invalid admin secret");
  }
  const p = UploadIdSchema.safeParse(c.req.param());
  if (!p.success) return sendError(c, 400, "validation_error", "invalid upload id");
  const row = await rows.getById(c.env.DB, p.data.id);
  if (!row) return sendError(c, 404, "not_found", "unknown upload");

  const now = nowSec();
  if (row.status !== "deleted" && row.status !== "expired") {
    await deleteObject(c.env.FILES, row.object_key);
    await rows.markDeleted(c.env.DB, row.id, now);
  }
  return c.json({ id: row.id, status: "deleted", deletedAt: now }, 200);
});
