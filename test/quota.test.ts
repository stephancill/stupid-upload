import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { makeTestEnv } from "./helpers/fake";

let W: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  W = makeTestEnv();
});

function reserveTemporary(env: typeof W, size: number, key: string, ip = "3.3.3.3") {
  return app.request(
    "/v1/uploads/temporary",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({
        filename: "f.bin",
        contentType: "application/octet-stream",
        sizeBytes: size,
        sha256: "ab".repeat(32),
      }),
    },
    env,
  );
}

describe("quota enforcement", () => {
  it("fails closed when the per-source daily budget is exhausted", async () => {
    W = makeTestEnv({ STUPID_UPLOAD_SOURCE_DAILY_QUOTA_BYTES: 120 });
    expect((await reserveTemporary(W, 60, "q".repeat(40) + "1")).status).toBe(201);
    expect((await reserveTemporary(W, 60, "q".repeat(40) + "2")).status).toBe(201);
    expect((await reserveTemporary(W, 60, "q".repeat(40) + "3")).status).toBe(429);
  });

  it("does not share quota across sources", async () => {
    W = makeTestEnv({ STUPID_UPLOAD_SOURCE_DAILY_QUOTA_BYTES: 120 });
    // Source A exhausts its budget.
    await reserveTemporary(W, 100, "a".repeat(40) + "1", "3.3.3.3");
    // Source B with a fresh budget still succeeds.
    const res = await reserveTemporary(W, 60, "b".repeat(40) + "1", "4.4.4.4");
    expect(res.status).toBe(201);
  });
});
