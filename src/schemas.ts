import { z } from "zod";

const SHA256_REGEX = /^[0-9a-f]{64}$/;
const FILENAME_MAX_BYTES = 255;
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{16,32}$/;

/** Metadata body shared by both temporary and permanent reservation routes. */
export const UploadMetadataSchema = z.object({
  filename: z
    .string()
    .min(1)
    .refine(isSafeFilename, "filename contains prohibited characters")
    .refine(
      (v) => new TextEncoder().encode(v).length <= FILENAME_MAX_BYTES,
      `filename must be ${FILENAME_MAX_BYTES} bytes or fewer`,
    ),
  contentType: z
    .string()
    .min(1)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, "invalid content type")
    .max(100),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(SHA256_REGEX, "sha256 must be 64 lowercase hex characters"),
});
export type UploadMetadata = z.infer<typeof UploadMetadataSchema>;

/** Feedback submission payload. */
export const FeedbackSchema = z.object({
  category: z.enum(["bug", "feature_request", "usability", "pricing", "other"]),
  message: z.string().min(1).max(4000),
  rating: z.number().int().min(1).max(5).optional(),
  relatedUploadId: z.string().regex(SAFE_ID_REGEX).optional(),
  requestId: z.string().max(64).optional(),
  client: z
    .object({
      name: z.string().min(1).max(32),
      version: z.string().min(1).max(32),
    })
    .optional(),
});
export type FeedbackPayload = z.infer<typeof FeedbackSchema>;

export const PricingQuerySchema = z.object({
  sizeBytes: z.coerce.number().int().min(0),
});

export const UploadIdSchema = z.object({ id: z.string().regex(SAFE_ID_REGEX) });

/** Prohibit control characters, path separators, and bidi/isolate controls. */
function isSafeFilename(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (/[\\/]/.test(name)) return false;
  if (/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) return false;
  return true;
}

export const uploadIdRegex = SAFE_ID_REGEX;
