import { z } from "zod";

/** Limits and pricing constants shared across the codebase. */
export const LIMITS = {
  /** Maximum size for temporary (free) files: 1 MiB. */
  maxTemporaryBytes: 1048576,
  /** Maximum size for permanent (paid) files: 100 MiB. */
  maxPermanentBytes: 104857600,
  /** Default per-source daily reserved quota for temporary uploads: 20 MiB. */
  sourceDailyQuotaBytes: 20971520,
  /** Pending reservation lifetime: 15 minutes. */
  pendingLifetimeSeconds: 900,
  /** Tombstone retention for deleted/expired rows before metadata purge: 7 days. */
  tombstoneRetentionSeconds: 604800,
  /** Feedback retention before scheduled purge: 365 days. */
  feedbackRetentionSeconds: 31536000,
  /** Feedback per-source daily limit. */
  feedbackSourceDailyLimit: 20,
  /** Feedback per-minute burst limit per source. */
  feedbackPerMinuteLimit: 5,
  /** Feedback global daily circuit breaker. */
  feedbackGlobalDailyLimit: 1000,
} as const;

/** Validated plain configuration values (variables, not bindings). */
export type WorkerConfig = z.infer<typeof ConfigSchema>;

/**
 * Boolean coercion that is string-safe. z.coerce.boolean() maps any non-empty
 * string (including "false") to `true` via JS Boolean(). This helper treats
 * "true"/"1"/"1" and "false"/"0" explicitly and returns `def` otherwise, so
 * operators can reliably flip a flag with a string without a surprise.
 */
function boolField(def: boolean) {
  return z.preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return def;
    const s = String(v).trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return def;
  }, z.boolean());
}

const ConfigSchema = z.object({
  STUPID_UPLOAD_BASE_URL: z.string().url().default("https://upload.stupidtech.net"),
  STUPID_UPLOAD_FILES_HOST: z.string().url().optional(),
  STUPID_UPLOAD_HMAC_SECRET: z.string().min(32),
  STUPID_UPLOAD_ADMIN_SECRET: z.string().min(16),
  STUPID_UPLOAD_GLOBAL_DAILY_QUOTA_BYTES: z.coerce.number().int().positive().default(10737418240),
  STUPID_UPLOAD_SOURCE_DAILY_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.sourceDailyQuotaBytes),
  STUPID_UPLOAD_FEEDBACK_GLOBAL_DAILY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.feedbackGlobalDailyLimit),
  STUPID_UPLOAD_FEEDBACK_SOURCE_DAILY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.feedbackSourceDailyLimit),
  STUPID_UPLOAD_FEEDBACK_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.feedbackRetentionSeconds),
  STUPID_UPLOAD_TOMBSTONE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.tombstoneRetentionSeconds),
  STUPID_UPLOAD_PENDING_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.pendingLifetimeSeconds),
  /** Testing escape hatch: allow permanent reservations without x402. */
  STUPID_UPLOAD_ALLOW_UNPAID_PERMANENT: boolField(false),
  /** Per-source per-minute feedback burst cap. */
  STUPID_UPLOAD_FEEDBACK_PER_MINUTE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.feedbackPerMinuteLimit),
  // --- x402 permanent pricing -------------------------------------------------
  /** Enable the x402 payment middleware on the permanent upload route. */
  STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED: boolField(false),
  /** x402 facilitator base URL (its /verify /settle /supported endpoints). */
  STUPID_UPLOAD_FACILITATOR_URL: z.string().url().optional(),
  /** Payment network, e.g. Base Sepolia eip155:84532 (test) or Base eip155:8453. */
  STUPID_UPLOAD_PAYMENT_NETWORK: z
    .string()
    .regex(/^eip155:8453(2)?$/)
    .default("eip155:84532"),
  /** Recipient address of settled permanent payments. */
  STUPID_UPLOAD_PAYMENT_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

/** Cloudflare bindings injected by Wrangler. */
export type Bindings = {
  FILES: R2Bucket;
  DB: D1Database;
  LIMITER?: RateLimit;
};

/**
 * Validates the plain-text variable portion of a Worker environment.
 * Bindings are typed separately via {@link Bindings} and are not run through
 * the Z od schema.
 */
export function loadConfig(vars: Record<string, unknown>): WorkerConfig {
  return ConfigSchema.parse(vars);
}
