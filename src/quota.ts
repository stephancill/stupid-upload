/** D1 daily byte/count quota reservation using atomic guarded UPSERTs. */

export type QuotaScope = "source" | "global";

/** YYYY-MM-DD UTC day key for quota rows. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomically reserve `bytes` against a daily budget in a transaction. Returns
 * whether the reservation fit within `limit`. Fails closed on exhaustion.
 */
export async function reserveQuota(
  db: D1Database,
  scope: QuotaScope,
  subjectHash: string,
  day: string,
  bytes: number,
  limit: number,
): Promise<boolean> {
  const insert = db
    .prepare(
      "INSERT OR IGNORE INTO daily_usage (scope, subject_hash, utc_day, reserved_bytes) VALUES (?1, ?2, ?3, 0)",
    )
    .bind(scope, subjectHash, day);
  const update = db
    .prepare(
      `UPDATE daily_usage
         SET reserved_bytes = reserved_bytes + ?1
       WHERE scope = ?2 AND subject_hash = ?3 AND utc_day = ?4
         AND reserved_bytes + ?1 <= ?5
       RETURNING reserved_bytes`,
    )
    .bind(bytes, scope, subjectHash, day, limit);
  const results = await db.batch([insert, update]);
  const row = results[1]?.results?.[0] as { reserved_bytes?: number } | undefined;
  return Boolean(row);
}

/** Atomically reserve a count submission against a daily cap. */
export async function reserveCount(
  db: D1Database,
  scope: QuotaScope,
  subjectHash: string,
  day: string,
  limit: number,
): Promise<boolean> {
  const insert = db
    .prepare(
      "INSERT OR IGNORE INTO daily_usage (scope, subject_hash, utc_day, reserved_bytes, upload_count) VALUES (?1, ?2, ?3, 0, 0)",
    )
    .bind(scope, subjectHash, day);
  const update = db
    .prepare(
      `UPDATE daily_usage
         SET upload_count = upload_count + 1
       WHERE scope = ?1 AND subject_hash = ?2 AND utc_day = ?3
         AND upload_count + 1 <= ?4
       RETURNING upload_count`,
    )
    .bind(scope, subjectHash, day, limit);
  const results = await db.batch([insert, update]);
  const row = results[1]?.results?.[0] as { upload_count?: number } | undefined;
  return Boolean(row);
}

/** Increment the successful-upload count for a usage row. */
export async function bumpUploadCount(
  db: D1Database,
  scope: QuotaScope,
  subjectHash: string,
  day: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_usage SET upload_count = upload_count + 1
       WHERE scope = ?1 AND subject_hash = ?2 AND utc_day = ?3`,
    )
    .bind(scope, subjectHash, day)
    .run();
}
