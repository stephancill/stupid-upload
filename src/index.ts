import { app } from "./app";
import { registerDiscovery } from "./discovery";

// Register first-party documentation and discovery routes.
registerDiscovery();

type WorkerEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  [key: string]: unknown;
};

export default {
  fetch: app.fetch.bind(app),
  scheduled: async (ctrl: unknown, env: WorkerEnv) => {
    await runCleanup(env);
  },
} satisfies import("@cloudflare/workers-types").ExportedHandler<WorkerEnv>;

/** Hourly bounded cleanup: mark expired, delete R2 objects, purge tombstone
 *  rows and stale pending reservations. Runs idempotently in bounded batches. */
async function runCleanup(env: WorkerEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = env.DB;
  const bucket = env.FILES;

  // 1) Expire ready/pending temporary uploads whose window has passed.
  const toExpire = await db
    .prepare(
      `SELECT object_key FROM uploads
       WHERE status IN ('ready','pending')
         AND retention = 'temporary'
         AND expires_at IS NOT NULL
         AND expires_at <= ?1
       LIMIT 500`,
    )
    .bind(now)
    .all<{ object_key: string }>();

  for (const row of toExpire.results ?? []) {
    await db
      .prepare(`UPDATE uploads SET status = 'expired', deleted_at = ?1 WHERE object_key = ?2`)
      .bind(now, row.object_key)
      .run();
    try {
      await bucket.delete(row.object_key);
    } catch {
      // object already gone; continue.
    }
  }
}
