/** In-process per-minute throttles for feedback submission. Used both as a
 *  defense-in-depth layer next to D1 daily caps and as a test-friendly knob.
 *  Not a substitute for Cloudflare's location-aware Rate Limiting binding. */

type Bucket = { minute: string; count: number };

const buckets = new Map<string, Bucket>();

/** Reset all throttles (used by tests between cases). */
export function resetBurstStore(): void {
  buckets.clear();
}

function minuteKey(): string {
  return new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

/** Returns true when `key` has remaining allowance within the current minute. */
export function allowPerMinute(key: string, limit: number): boolean {
  const minute = minuteKey();
  const existing = buckets.get(key);
  if (!existing || existing.minute !== minute) {
    buckets.set(key, { minute, count: 1 });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}
