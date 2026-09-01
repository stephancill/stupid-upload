import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * Stream an upload body into R2. Passes the expected SHA-256 through
 * `R2PutOptions.sha256` so R2 verifies integrity on the fly. Avoids buffering
 * the whole body in Worker memory.
 */
export async function putObject(args: {
  bucket: R2Bucket;
  objectKey: string;
  body: ReadableStream | ArrayBuffer | null;
  sha256: string;
  size: number;
  contentType: string;
  retention: "temporary" | "permanent";
}): Promise<R2Object> {
  return args.bucket.put(args.objectKey, args.body!, {
    httpMetadata: { contentType: args.contentType },
    customMetadata: {
      retention: args.retention,
      sha256: args.sha256,
    },
    sha256: args.sha256,
  });
}

/** Fetch an object head (metadata only) or body by key. */
export function getObject(bucket: R2Bucket, objectKey: string): Promise<R2Object | null> {
  return bucket.get(objectKey);
}

/** Delete an object from R2, ignoring "not found" errors. */
export async function deleteObject(bucket: R2Bucket, objectKey: string): Promise<void> {
  try {
    await bucket.delete(objectKey);
  } catch (err) {
    // Tolerance: the object may already be gone. Callers handle tombstones.
    void err;
  }
}

/** Delete a known R2 object and ignore not-found outcomes. */
export async function deleteObjectStrict(bucket: R2Bucket, objectKey: string): Promise<void> {
  await bucket.delete(objectKey);
}
