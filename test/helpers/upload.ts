// Shared helpers for exercising the app against the in-memory fake bindings.
import { app } from "../../src/app";
import { sha256 } from "../../src/crypto";
import type { makeTestEnv } from "./fake";

type Env = ReturnType<typeof makeTestEnv>;

/** Reserve + upload a temporary file via the API, returning its row/response. */
export async function uploadTemporary(
  env: Env,
  payload: Uint8Array,
  opts: { filename?: string; contentType?: string } = {},
): Promise<{
  id: string;
  uploadToken: string;
  deleteToken: string;
  publicUrl: string;
  expiresAt: number | null;
  body: any;
}> {
  const hash = await sha256(payload);
  const res = await app.request(
    "/v1/uploads/temporary",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "k".repeat(40),
        "cf-connecting-ip": "9.9.9.9",
      },
      body: JSON.stringify({
        filename: opts.filename ?? "note.txt",
        contentType: opts.contentType ?? "text/plain",
        sizeBytes: payload.length,
        sha256: hash,
      }),
    },
    env,
  );
  const data = await res.json<any>();
  const up = await app.request(
    `/v1/uploads/${data.id}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${data.uploadToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
      },
      body: payload,
    },
    env,
  );
  if (up.status !== 201) throw new Error(`upload failed: ${up.status}`);
  return {
    id: data.id,
    uploadToken: data.uploadToken,
    deleteToken: data.deleteToken,
    publicUrl: data.publicUrl,
    expiresAt: data.expiresAt,
    body: data,
  };
}
