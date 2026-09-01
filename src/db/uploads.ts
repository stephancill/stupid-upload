import type { D1Database } from "@cloudflare/workers-types";

export type Retention = "temporary" | "permanent";
export type UploadStatus = "pending" | "ready" | "deleted" | "expired";

export interface UploadRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  retention: Retention;
  status: UploadStatus;
  source_hash: string;
  idempotency_key: string;
  upload_token_hash: string;
  delete_token_hash: string;
  upload_expires_at: number | null;
  expires_at: number | null;
  created_at: number;
  completed_at: number | null;
  deleted_at: number | null;
  price_atomic: number | null;
  payment_network: string | null;
  payment_receipt: string | null;
}

/** Input for inserting a pending reservation row (DB column naming). */
export interface InsertUpload {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  retention: Retention;
  source_hash: string;
  idempotency_key: string;
  upload_token_hash: string;
  delete_token_hash: string;
  upload_expires_at: number | null;
  expires_at: number | null;
  created_at: number;
  price_atomic: number | null;
  payment_network: string | null;
  payment_receipt: string | null;
}

const INSERT_COLUMNS = `id, object_key, filename, content_type, size_bytes, sha256,
  retention, status, source_hash, idempotency_key, upload_token_hash, delete_token_hash,
  upload_expires_at, expires_at, created_at, price_atomic, payment_network, payment_receipt`;

/** Insert a pending reservation and return the created row. */
export async function insertReservation(db: D1Database, upload: InsertUpload): Promise<UploadRow> {
  await db
    .prepare(
      `INSERT INTO uploads (${INSERT_COLUMNS})
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    )
    .bind(
      upload.id,
      upload.object_key,
      upload.filename,
      upload.content_type,
      upload.size_bytes,
      upload.sha256,
      upload.retention,
      "pending",
      upload.source_hash,
      upload.idempotency_key,
      upload.upload_token_hash,
      upload.delete_token_hash,
      upload.upload_expires_at,
      upload.expires_at,
      upload.created_at,
      upload.price_atomic,
      upload.payment_network,
      upload.payment_receipt,
    )
    .run();
  return (await getById(db, upload.id))!;
}

/** Read an upload row by primary id. */
export function getById(db: D1Database, id: string): Promise<UploadRow | null> {
  return db.prepare("SELECT * FROM uploads WHERE id = ?1").bind(id).first<UploadRow>();
}

/** Find a reservation by idempotency key scoped to a source hash. */
export function getByIdempotencyKey(
  db: D1Database,
  sourceHash: string,
  idempotencyKey: string,
): Promise<UploadRow | null> {
  return db
    .prepare("SELECT * FROM uploads WHERE source_hash = ?1 AND idempotency_key = ?2")
    .bind(sourceHash, idempotencyKey)
    .first<UploadRow>();
}

/** Mark a reservation completed (ready) with an optional expiry. */
export async function markReady(
  db: D1Database,
  id: string,
  now: number,
  expiresAt: number | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE uploads SET status = 'ready', completed_at = ?1, expires_at = ?2
       WHERE id = ?3 AND status = 'pending'`,
    )
    .bind(now, expiresAt, id)
    .run();
  return res.meta.changes > 0;
}

/** Mark a row deleted (tombstone). */
export async function markDeleted(db: D1Database, id: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE uploads SET status = 'deleted', deleted_at = ?1 WHERE id = ?2`)
    .bind(now, id)
    .run();
}

/** Mark a row expired (tombstone). */
export async function markExpired(db: D1Database, id: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE uploads SET status = 'expired', deleted_at = ?1
       WHERE id = ?2 AND status IN ('ready', 'pending')`,
    )
    .bind(now, id)
    .run();
}
