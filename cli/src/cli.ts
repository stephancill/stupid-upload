#!/usr/bin/env node
// @ts-nocheck  (tool entrypoint; typechecked tests cover the contract)
// Stupid Upload CLI (Node).
// Stable JSON to stdout; structured errors to stderr; documented exit codes.
//
// Paid uploads: with a private key we sign + settle via @x402. When no key is
// set, `upload --permanent` drives the canonical @x402 payment through a
// capturing signer, asks a human wallet to sign the exact EIP-3009 transfer via
// txlink (wallet_sign / eth_signTypedData_v4), then submits the real signature
// as PAYMENT-SIGNATURE to settle. The whole no-key flow completes end-to-end in
// one command.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile, rename, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import {
  createTxlinkRequest,
  pollTxlinkRequest,
  type SignatureRequest,
  type SignatureRequestOptions,
} from "./txlink";
import {
  applyWalletSignature,
  assertWithinPriceCap,
  captureExact,
  DEFAULT_MAX_PRICE_USD,
  encodePaymentSignatureHeader,
  type WalletSignature,
} from "./submit-exact";
import {
  addRecord,
  deleteTokenFor,
  publicRecord,
  readRegistry,
  removeRecord,
  type UploadRecord,
} from "./registry";

const MIB = 1048576;
const MAX_TEMPORARY = MIB;
const MAX_PERMANENT = 100 * MIB;

function baseUrl(): string {
  return process.env.STUPID_UPLOAD_BASE_URL ?? "https://upload.stupidtech.net";
}

export const EXIT = {
  success: 0,
  usage: 1,
  validation: 2,
  quota: 3,
  payment: 4,
  network: 5,
  integrity: 6,
  server: 7,
} as const;

function fail(
  code: keyof typeof EXIT,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message, code, ...extra }) + "\n");
  return process.exit(EXIT[code] as never);
}

function emit(out: unknown): never {
  process.stdout.write(JSON.stringify(out) + "\n");
  return process.exit(EXIT.success as never);
}

function idempotencyKey(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("base64url");
}

async function toJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function api(pathname: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${baseUrl()}${pathname}`, { ...init, headers });
  if (res.status >= 500) fail("server", `upstream error ${res.status}`);
  if (res.status === 429) fail("quota", "rate or quota limit reached");
  return { res, body: await toJson(res) };
}

async function statFile(file: string): Promise<{ size: number; sha256: string }> {
  const buf = await readFile(file);
  return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

function guessContentType(file: string): string {
  const ext = (file.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
  };
  return map[ext] ?? "application/octet-stream";
}

function evmChainId(network?: string): number {
  const m = /^eip155:(\d+)$/.exec(network ?? "");
  return m ? Number(m[1]) : 84532;
}

async function putContent(file: string, reservation: any): Promise<void> {
  const buf = await readFile(file);
  const res = await fetch(reservation.uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${reservation.uploadToken}`,
      "content-type": "application/octet-stream",
      "content-length": String(buf.byteLength),
    },
    body: buf,
  });
  if (res.status !== 201) {
    const text = await res.text().catch(() => "");
    fail("integrity", "content upload failed", { http: res.status, raw: text });
  }
}

/** Persist a successful upload in the local registry (record + token). */
async function persistUpload(params: {
  id: string;
  file: string;
  retention: "temporary" | "permanent";
  sizeBytes: number;
  sha256: string;
  publicUrl: string;
  deleteToken: string;
  expiresAt: number | null;
}): Promise<UploadRecord> {
  const record: UploadRecord = {
    id: params.id,
    path: path.resolve(params.file),
    filename: path.basename(params.file),
    retention: params.retention,
    sizeBytes: params.sizeBytes,
    sha256: params.sha256,
    publicUrl: params.publicUrl,
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: params.expiresAt,
    deleteToken: params.deleteToken,
  };
  await addRecord(record);
  return record;
}

// Commands -------------------------------------------------------------

export {
  cmdPermanentUpload,
  cmdTemporaryUpload,
  cmdQuote,
  cmdStatus,
  cmdDelete,
  cmdFeedback,
  cmdList,
  valueOf,
};

async function cmdQuote(file: string): Promise<unknown> {
  const { size, sha256 } = await statFile(file);
  const { res, body } = await api(`/v1/pricing?sizeBytes=${size}`);
  if (!res.ok) fail("server", body?.error?.message ?? "pricing failed");
  return { ok: true, command: "quote", file, sizeBytes: size, sha256, pricing: body };
}

async function cmdTemporaryUpload(file: string, contentType?: string): Promise<unknown> {
  const { size, sha256 } = await statFile(file);
  if (size > MAX_TEMPORARY)
    fail("validation", `file is ${size} bytes; temporary limit is ${MAX_TEMPORARY}`);
  const ct = contentType ?? guessContentType(file);
  const { res, body } = await api("/v1/uploads/temporary", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey() },
    body: JSON.stringify({
      filename: path.basename(file),
      contentType: ct,
      sizeBytes: size,
      sha256,
    }),
  });
  if (res.status !== 201) fail("validation", body?.error?.message ?? "reserve failed");
  await putContent(file, body);
  await persistUpload({
    id: body.id,
    file,
    retention: "temporary",
    sizeBytes: size,
    sha256,
    publicUrl: body.publicUrl,
    deleteToken: body.deleteToken,
    expiresAt: body.expiresAt ?? null,
  });
  return { ok: true, command: "upload", retention: "temporary", ...body };
}

async function cmdPermanentUpload(
  file: string,
  contentType?: string,
  maxPriceUsdArg?: string,
): Promise<unknown> {
  const { size, sha256 } = await statFile(file);
  if (size > MAX_PERMANENT) fail("validation", `file is ${size} bytes; max is 100 MiB`);
  const ct = contentType ?? guessContentType(file);
  const idem = idempotencyKey();
  const meta = { filename: path.basename(file), contentType: ct, sizeBytes: size, sha256 };

  // Signed path: `wrapFetchWithPayment` auto-pays the server's x402 challenge.
  if (process.env.STUPID_UPLOAD_PRIVATE_KEY) {
    const { buildX402Fetcher } = await import("./pay");
    const payFetch = buildX402Fetcher({ privateKey: process.env.STUPID_UPLOAD_PRIVATE_KEY });
    const paid = await payFetch(`${baseUrl()}/v1/uploads/permanent`, {
      method: "POST",
      headers: { "idempotency-key": idem, "content-type": "application/json" },
      body: JSON.stringify(meta),
    });
    const paidBody: any = await toJson(paid);
    if (paid.status === 201 && paidBody?.id) {
      await putContent(file, paidBody);
      await persistUpload({
        id: paidBody.id,
        file,
        retention: "permanent",
        sizeBytes: size,
        sha256,
        publicUrl: paidBody.publicUrl,
        deleteToken: paidBody.deleteToken,
        expiresAt: null,
      });
      return { ok: true, command: "upload", retention: "permanent", ...paidBody };
    }
    fail("payment", paidBody?.error?.message ?? `payment failed (${paid.status})`, {
      http: paid.status,
    });
  }

  const { res, body } = await api("/v1/uploads/permanent", {
    method: "POST",
    headers: { "idempotency-key": idem },
    body: JSON.stringify(meta),
  });

  if (res.status !== 402) {
    if (res.ok && body?.id) {
      await putContent(file, body);
      return { ok: true, command: "upload", retention: "permanent", ...body };
    }
    fail("payment", body?.error?.message ?? "permanent request failed", { http: res.status });
  }

  const header = res.headers.get("payment-required");
  const paymentRequired = header
    ? JSON.parse(Buffer.from(header, "base64").toString("utf-8"))
    : null;
  const accept = paymentRequired?.accepts?.[0];
  const chainId = evmChainId(accept?.network);

  // Build the exact x402 payment via the submit seam: @x402 derives the payload
  // and captures the exact Permit2 witness typed-data it wants the wallet to
  // sign, plus a placeholder payment (no funds move yet).
  let captured;
  try {
    captured = await captureExact(paymentRequired);
  } catch (e) {
    fail("payment", e instanceof Error ? e.message : String(e));
  }
  const maxUsd = resolveMaxUsd(maxPriceUsdArg);
  assertWithinPriceCap(captured.accepted, maxUsd);

  const sigOptions: SignatureRequestOptions = {
    method: "wallet_sign",
    chainId,
    // EIP-7871 wallet_sign: no address pre-committed; txlink substitutes the
    // payer. `captured.typedData` is the exact @x402 Permit2 witness
    // (nonce/deadline/spender/domain) the server/CDP expects, so the later
    // `exact` settlement is canonical.
    params: { version: "1.0", request: { type: "0x01", data: captured.typedData } },
  };
  const sig: SignatureRequest = await createTxlinkRequest(sigOptions);

  // Single structured diagnostic to stderr (never stdout) so a human can approve
  // the payment signature; the machine-readable result goes to stdout below.
  process.stderr.write(
    JSON.stringify({
      ok: true,
      kind: "approvalRequired",
      message: "approve the payment in your wallet",
      url: sig.url,
      idempotencyKey: idem,
    }) + "\n",
  );

  const walletSig = await waitForSignature(sig);
  const finalized = applyWalletSignature(captured.payload, walletSig);
  const paymentHeaders = encodePaymentSignatureHeader(finalized);

  const submit = await api("/v1/uploads/permanent", {
    method: "POST",
    headers: { "idempotency-key": idem, ...paymentHeaders },
    body: JSON.stringify(meta),
  });
  if (submit.res.status === 201 && submit.body?.id) {
    await putContent(file, submit.body);
    await persistUpload({
      id: submit.body.id,
      file,
      retention: "permanent",
      sizeBytes: size,
      sha256,
      publicUrl: submit.body.publicUrl,
      deleteToken: submit.body.deleteToken,
      expiresAt: null,
    });
    return {
      ok: true,
      command: "upload",
      retention: "permanent",
      payer: walletSig.account,
      ...submit.body,
    };
  }
  const reason = submit.res.status === 402 ? decodePaymentReason(submit) : undefined;
  fail("payment", reason ?? submit.body?.error?.message ?? "permanent request failed", {
    http: submit.res.status,
  });
}

/** Default (v1 maximum) spend cap; allow a lower `--max-price-usd`. */
function resolveMaxUsd(arg?: string): number {
  if (!arg) return DEFAULT_MAX_PRICE_USD;
  const v = Number(arg);
  if (!Number.isFinite(v) || v <= 0) fail("usage", `invalid --max-price-usd: ${arg}`);
  return v;
}

const SIGN_TIMEOUT_MS: number = Number(process.env.STUPID_UPLOAD_SIGN_TIMEOUT_MS ?? 5 * 60_000);
const WALLET_POLL_MS = 2000;

/** Poll the txlink signature request until a wallet signs (or times out). */
async function waitForSignature(request: SignatureRequest): Promise<WalletSignature> {
  const deadline = Date.now() + SIGN_TIMEOUT_MS;
  for (;;) {
    const current = await pollTxlinkRequest(request.statusUrl);
    if (current.status === "completed") {
      return parseWalletSignature(request, current.result);
    }
    if (current.status === "failed") {
      fail("payment", current.error ?? "the wallet signature request failed");
    }
    if (Date.now() >= deadline) {
      fail("payment", `timed out waiting for the wallet signature; approve ${request.url}`, {
        statusUrl: request.statusUrl,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, WALLET_POLL_MS));
  }
}

function parseWalletSignature(request: SignatureRequest, raw: string): WalletSignature {
  let data: any = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      /* txlink may return a bare hex signature */
    }
  }
  const nested = data?.result as Record<string, unknown> | undefined;
  const sig = (data?.signature ?? nested?.signature ?? data) as `0x${string}` | undefined;
  const account = (data?.account ?? nested?.account ?? data?.signer) as `0x${string}` | undefined;
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(sig ?? ""))) {
    fail("payment", "wallet returned an invalid signature", {
      statusUrl: request.statusUrl,
    });
  }
  if (!account) {
    fail("payment", "wallet signature did not include the payer account", {
      statusUrl: request.statusUrl,
    });
  }
  return { signature: sig as `0x${string}`, account, message: data?.message };
}

/** The server's CDP rejection reason rides on the 402 `payment-required` (v2). */
function decodePaymentReason(submit: { res: Response; body: any }): string | undefined {
  const h = submit.res.headers.get("payment-required");
  if (h) {
    try {
      const pr = JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
      if (pr?.error) return pr.error;
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

async function cmdStatus(id: string): Promise<unknown> {
  const { res, body } = await api(`/v1/uploads/${id}`);
  return { ok: res.ok, command: "status", id, http: res.status, body };
}

async function cmdDelete(id: string, token?: string): Promise<unknown> {
  const bearer = token ?? process.env.STUPID_UPLOAD_DELETE_TOKEN ?? (await deleteTokenFor(id));
  if (!bearer)
    fail("validation", "provide --token, STUPID_UPLOAD_DELETE_TOKEN, or a recorded upload id");
  const { res, body } = await api(`/v1/uploads/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (res.ok) await removeRecord(id);
  return { ok: res.ok, command: "delete", id, http: res.status, body };
}

async function cmdList(): Promise<unknown> {
  const records = await readRegistry();
  return {
    ok: true,
    command: "list",
    count: records.length,
    uploads: records.map(publicRecord),
  };
}

async function cmdFeedback(category: string, message: string, flag: string): Promise<unknown> {
  if (!category || !message) fail("usage", "feedback needs --category and --message");
  const rating = /^\d+$/.test(flag) ? Number(flag) : undefined;
  const { res, body } = await api("/v1/feedback", {
    method: "POST",
    body: JSON.stringify({ category, message, rating }),
  });
  return { ok: res.ok, command: "feedback", http: res.status, body };
}

// Dispatch -------------------------------------------------------------

const HELP = `Usage: stupid-upload <command> [args]

Commands:
  quote <path>                      Advisory pricing for a file
  upload <path>                     Upload (free, <=1 MiB, 24h expiry; default)
  upload <path> --permanent [--max-price-usd 0.20]
                       Pay via x402 + upload (<=100 MiB; lower spend cap optional)
  status <id>                       Upload status
  list                              List locally-recorded uploads
  delete <id> [--token <token>]     Delete (token auto-loaded from local list)
  feedback --category <c> --message <m> [--rating 1-5]
`;

function valueOf(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : "";
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "--version") {
    return emit({ ok: true, name: packageJson.name, version: packageJson.version });
  }

  switch (cmd) {
    case "quote":
      return emit(await cmdQuote(rest[0]));
    case "upload": {
      const file = rest.find((a) => !a.startsWith("-"));
      if (!file) fail("usage", "upload needs a path");
      const ct = valueOf(rest, "--content-type") || undefined;
      if (rest.includes("--permanent"))
        return emit(
          await cmdPermanentUpload(file, ct, valueOf(rest, "--max-price-usd") || undefined),
        );
      return emit(await cmdTemporaryUpload(file, ct));
    }
    case "status":
      return emit(await cmdStatus(rest[0]));
    case "list":
      return emit(await cmdList());
    case "delete":
      return emit(await cmdDelete(rest[0], valueOf(rest, "--token") || undefined));
    case "download":
      return emit(
        await cmdDownload(
          rest.find((a) => !a.startsWith("-")) ?? "",
          valueOf(rest, "--output"),
          rest.includes("--force"),
        ),
      );
    case "feedback":
      return emit(
        await cmdFeedback(
          valueOf(rest, "--category"),
          valueOf(rest, "--message"),
          valueOf(rest, "--rating"),
        ),
      );
    default:
      return fail("usage", `unknown command: ${cmd}`);
  }
}

async function cmdDownload(url: string, output: string, force: boolean): Promise<unknown> {
  if (!url || !output) fail("usage", "download needs a url and --output <path>");

  const res = await fetch(url);
  if (!res.ok) fail("network", `download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!force) {
    try {
      await access(output);
      fail("validation", `output exists; use --force to overwrite`);
    } catch {
      /* ok */
    }
  }
  const tmp = `${output}.tmp-${process.pid}`;
  await writeFile(tmp, buf);
  await rename(tmp, output);
  return { ok: true, command: "download", wrote: output, bytes: buf.byteLength };
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((e) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n",
    );
    process.exit(EXIT.server);
  });
}
