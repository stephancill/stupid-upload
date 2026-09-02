#!/usr/bin/env bun
// @ts-nocheck  (tool entrypoint; typechecked tests cover the contract)
// Stupid Upload CLI.
// Stable JSON to stdout; structured errors to stderr; documented exit codes.
//
// Paid uploads: with a private key we intend to sign + settle via @x402 (that
// funded local path needs a live facilitator and is a later E2E). When no key
// is set, upload --permanent creates a txlink stored request and returns its
// url + statusUrl so a human can approve the payment signature.
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, access } from "node:fs/promises";
import path from "node:path";
import {
  createTxlinkRequest,
  describeRequest,
  type SignatureRequest,
  type SignatureRequestOptions,
} from "./txlink";

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

// Commands -------------------------------------------------------------

export {
  cmdPermanentUpload,
  cmdTemporaryUpload,
  cmdQuote,
  cmdStatus,
  cmdDelete,
  cmdFeedback,
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
  return { ok: true, command: "upload", retention: "temporary", ...body };
}

async function cmdPermanentUpload(file: string, contentType?: string): Promise<unknown> {
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

  const sigOptions: SignatureRequestOptions = {
    method: "wallet_sign",
    chainId,
    // EIP-7871 wallet_sign: no address is pre-committed; txlink substitutes the
    // connected wallet. The typed-data is the exact Perm2 payment (address-free).
    params: { version: "1.0", request: { type: "0x01", data: permit2TypedData(accept, chainId) } },
  };
  const sig: SignatureRequest = await createTxlinkRequest(sigOptions);
  return {
    ok: true,
    command: "upload",
    retention: "permanent",
    status: "awaitingSignature",
    sizeBytes: size,
    sha256,
    idempotencyKey: idem,
    payment: { network: accept?.network, amount: accept?.amount, payTo: accept?.payTo },
    signatureRequest: { id: sig.id, url: sig.url, statusUrl: sig.statusUrl },
    note: describeRequest(sigOptions),
  };
}

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * EIP-712 signed data for the x402 exact (Permit2) payment. The signature
 * commits to `{ permitted, nonce, deadline }` — deliberately no payer address,
 * so it pairs with EIP-7871 wallet_sign whose connected wallet is substituted.
 */
function permit2TypedData(accept: any, chainId: number): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + (Number(accept?.maxTimeoutSeconds) || 900);
  const nonce = "0x" + randomBytes(32).toString("hex");
  return {
    domain: { name: "PERMIT2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: accept?.asset, amount: accept?.amount ?? "0" },
      nonce,
      deadline,
    },
  };
}

async function cmdStatus(id: string): Promise<unknown> {
  const { res, body } = await api(`/v1/uploads/${id}`);
  return { ok: res.ok, command: "status", id, http: res.status, body };
}

async function cmdDelete(id: string, token?: string): Promise<unknown> {
  const bearer = token ?? process.env.STUPID_UPLOAD_DELETE_TOKEN;
  if (!bearer) fail("validation", "provide --token or STUPID_UPLOAD_DELETE_TOKEN");
  const { res, body } = await api(`/v1/uploads/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}` },
  });
  return { ok: res.ok, command: "delete", id, http: res.status, body };
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
  upload <path> --temporary         Upload (free, <=1 MiB, 24h expiry)
  upload <path> --permanent         Pay via x402 + upload (<=100 MiB)
  status <id>                       Upload status
  delete <id> --token <token>       Delete (or STUPID_UPLOAD_DELETE_TOKEN)
  feedback --category <c> --message <m> [--rating 1-9]
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
  if (cmd === "--version") return emit({ ok: true, name: "stupid-upload", version: "0.7.0" });

  switch (cmd) {
    case "quote":
      return emit(await cmdQuote(rest[0]));
    case "upload": {
      const file = rest.find((a) => !a.startsWith("-"));
      if (!file) fail("usage", "upload needs a path");
      const ct = valueOf(rest, "--content-type") || undefined;
      if (rest.includes("--permanent")) return emit(await cmdPermanentUpload(file, ct));
      if (rest.includes("--temporary")) return emit(await cmdTemporaryUpload(file, ct));
      return fail("usage", "choose --temporary or --permanent");
    }
    case "status":
      return emit(await cmdStatus(rest[0]));
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

declare global {
  interface ImportMeta {
    readonly main?: boolean;
  }
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n",
    );
    process.exit(EXIT.server);
  });
}
