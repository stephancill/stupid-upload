import { hmac, randomId, sha256 } from "./crypto";

/** Hashing a raw client IP so D1 never stores it. */
export async function hashSource(secret: string, rawSource: string): Promise<string> {
  return hmac(secret, `source:${rawSource}`);
}

/** Deterministic upload bearer token derived from the id + server secret. */
export async function deriveUploadToken(secret: string, id: string): Promise<string> {
  return hmac(secret, `upload:${id}`);
}

/** Deterministic delete bearer token derived from the id + server secret. */
export async function deriveDeleteToken(secret: string, id: string): Promise<string> {
  return hmac(secret, `delete:${id}`);
}

export const hashToken = sha256;

/** Generate a new upload id and two derived bearer tokens plus their hashes. */
export async function mint(
  id: string,
  secret: string,
): Promise<{
  uploadToken: string;
  deleteToken: string;
  uploadTokenHash: string;
  deleteTokenHash: string;
}> {
  const uploadToken = await deriveUploadToken(secret, id);
  const deleteToken = await deriveDeleteToken(secret, id);
  const uploadTokenHash = await sha256(uploadToken);
  const deleteTokenHash = await sha256(deleteToken);
  return { uploadToken, deleteToken, uploadTokenHash, deleteTokenHash };
}

export { randomId };
