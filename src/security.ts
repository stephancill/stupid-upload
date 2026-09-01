/** Textual content types that may be rendered or executed and are therefore
 *  always served as attachments from the file host. */
const ACTIVE_CONTENT_TYPES = new Set([
  "text/html",
  "text/xhtml+xml",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/x-js",
]);

/** Content types safe to serve inline (plain text, images, common data). */
const SERVABLE_INLINE = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/json-seq",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/ogg",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "font/woff",
  "font/woff2",
]);

/** True when an object's declared content type may be rendered inline safely. */
export function isInlineSafe(contentType: string): boolean {
  const ck = contentType.trim().toLowerCase();
  if (ACTIVE_CONTENT_TYPES.has(ck)) return false;
  if (SERVABLE_INLINE.has(ck)) return true;
  if (ck.startsWith("text/")) return false;
  if (ck.startsWith("image/")) return true;
  return false;
}

/** Build a Content-Disposition header for a stored object. */
export function contentDisposition(contentType: string, filename: string, inline = false): string {
  const safe = safeDispositionFilename(filename);
  if (inline && isInlineSafe(contentType)) {
    return `inline; filename="${safe}"`;
  }
  return `attachment; filename="${safe}"`;
}

function safeDispositionFilename(name: string): string {
  return name.replace(/[\\"]/g, "") || "file";
}

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; img-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
} as const;
