import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { sha256 } from "../src/crypto";
import { resetBurstStore } from "../src/feedback-rate";
import { makeTestEnv } from "./helpers/fake";

const MIB = 1048576;
let W: ReturnType<typeof makeTestEnv>;

interface ReserveOptions {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

function metaBody(opts: ReserveOptions, payloadHash: string) {
  return {
    filename: opts.filename ?? "result.json",
    contentType: opts.contentType ?? "application/json",
    sizeBytes: opts.sizeBytes ?? payloadHash.length,
    sha256: payloadHash,
  };
}

async function reserve(
  payloadHash: string,
  opts: ReserveOptions = {},
): Promise<{ status: number; data: any }> {
  const res = await app.request(
    "/v1/uploads/temporary",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "k".repeat(40),
        "cf-connecting-ip": "1.2.3.4",
      },
      body: JSON.stringify(metaBody(opts, payloadHash)),
    },
    W,
  );
  return { status: res.status, data: await res.json() };
}

async function uploadContent(
  id: string,
  uploadToken: string,
  bytes: Uint8Array,
): Promise<Response> {
  return app.request(
    `/v1/uploads/${id}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${uploadToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
    },
    W,
  );
}

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    W,
  );

beforeEach(async () => {
  resetBurstStore();
  W = makeTestEnv();
});

describe("POST /v1/uploads/temporary", () => {
  it("reserves a temporary upload and returns tokens and URLs", async () => {
    const hash = await sha256(new TextEncoder().encode("hello world"));
    const { status, data } = await reserve(hash);
    expect(status).toBe(201);
    expect(data.retention).toBe("temporary");
    expect(data.uploadToken).toBeTruthy();
    expect(data.deleteToken).toBeTruthy();
    expect(data.publicUrl).toContain("/f/");
    expect(data.uploadUrl).toMatch(/\/content$/);
    expect(data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns the same reservation for a repeated idempotency key", async () => {
    const payload = new TextEncoder().encode("hello world");
    const hash = await sha256(payload);
    const a = await reserve(hash);
    const b = await reserve(hash, { sizeBytes: payload.length });
    expect(a.data.id).toBe(b.data.id);
    expect(a.data.uploadToken).toBe(b.data.uploadToken);
  });

  it("rejects oversized temporary files", async () => {
    const hash = "e".repeat(64);
    const { status } = await reserve(hash, { sizeBytes: 2 * MIB });
    expect(status).toBe(413);
  });

  it("rejects a low-entropy idempotency key", async () => {
    const res = await postJson("/v1/uploads/temporary", metaBody({}, "e".repeat(64)), {
      "idempotency-key": "short",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid sha256 metadata", async () => {
    const { status } = await reserve("zzz");
    expect(status).toBe(400);
  });
});

describe("PUT /v1/uploads/:id/content", () => {
  it("uploads bytes and verifies integrity", async () => {
    const payload = new TextEncoder().encode("hello world");
    const hash = await sha256(payload);
    const { data } = await reserve(hash, { sizeBytes: payload.length });
    const up = await uploadContent(data.id, data.uploadToken, payload);
    expect(up.status).toBe(201);
    const st = await app.request(`/v1/uploads/${data.id}`, {}, W);
    const stJson = await st.json<any>();
    expect(stJson.status).toBe("ready");
  });

  it("rejects an invalid upload token", async () => {
    const payload = new TextEncoder().encode("x");
    const hash = await sha256(payload);
    const { data } = await reserve(hash);
    const up = await uploadContent(data.id, "wrong-token", payload);
    expect(up.status).toBe(401);
  });

  it("rejects a content-length mismatch", async () => {
    const payload = new TextEncoder().encode("hello");
    const hash = await sha256(payload);
    const { data } = await reserve(hash);
    const res = await app.request(
      `/v1/uploads/${data.id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${data.uploadToken}`,
          "content-type": "application/octet-stream",
          "content-length": "3",
        },
        body: payload.subarray(0, 3),
      },
      W,
    );
    expect(res.status).toBe(411);
  });

  it("rejects a non-octet-stream content type", async () => {
    const payload = new TextEncoder().encode("hello");
    const hash = await sha256(payload);
    const { data } = await reserve(hash, { sizeBytes: payload.length });
    const res = await app.request(
      `/v1/uploads/${data.id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${data.uploadToken}`,
          "content-type": "text/plain",
          "content-length": "5",
        },
        body: payload,
      },
      W,
    );
    expect(res.status).toBe(415);
  });

  it("rejects an unknown upload id", async () => {
    const payload = new TextEncoder().encode("hello");
    const bad = await app.request(
      `/v1/uploads/${"z".repeat(32)}/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": "5" },
        body: payload,
      },
      W,
    );
    expect(bad.status).toBe(404);
  });
});
