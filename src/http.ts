import type { Context } from "hono";

export type ErrorCode =
  | "invalid_request"
  | "validation_error"
  | "quota_exceeded"
  | "unauthorized"
  | "not_found"
  | "gone"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "payment_required"
  | "integrity_check"
  | "server_error";

type Status = 200 | 201 | 202 | 400 | 401 | 402 | 404 | 409 | 410 | 411 | 413 | 415 | 429 | 501;

/** Stable JSON error envelope with a machine code plus human message. */
export function sendError(c: Context, status: Status, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

/** JSON success body for a given status. */
export function okJson(c: Context, status: Status, body: unknown): Response {
  return c.json(body, status);
}

/** True when an incoming key looks like a high-entropy idempotency key. */
export function isHighEntropyKey(key: string | undefined): boolean {
  if (!key) return false;
  return key.length >= 32 && /^[A-Za-z0-9_-]+$/.test(key);
}
