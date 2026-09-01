import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { makeTestEnv } from "./helpers/fake";
import { resetBurstStore } from "../src/feedback-rate";

let W: ReturnType<typeof makeTestEnv>;

const feedbackBody = {
  category: "feature_request",
  message: "A 7-day temporary retention option would be useful.",
  rating: 4,
  relatedUploadId: "p_iMmZrdB5V5KUvfUH8L4BAA",
  client: { name: "opencode", version: "2.0" },
};

function post(env: typeof W, body: unknown, ip = "5.5.5.5") {
  return app.request(
    "/v1/feedback",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  resetBurstStore();
  W = makeTestEnv();
});

describe("POST /v1/feedback", () => {
  it("accepts valid feedback and returns a stable envelope", async () => {
    const res = await post(W, feedbackBody);
    expect(res.status).toBe(202);
    const data = await res.json<any>();
    expect(data.status).toBe("accepted");
    expect(data.feedbackId).toMatch(/^fb_/);
    expect(data.message).toBeUndefined();
  });

  it("rejects an invalid category", async () => {
    const res = await post(W, { ...feedbackBody, category: "spam" });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range rating", async () => {
    const res = await post(W, { ...feedbackBody, rating: 9 });
    expect(res.status).toBe(400);
  });

  it("rejects an overlong message", async () => {
    const res = await post(W, { ...feedbackBody, message: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("enforces a per-minute burst limit per source", async () => {
    // Set a tiny per-minute cap to see the limiter trip deterministically.
    W = makeTestEnv({ STUPID_UPLOAD_FEEDBACK_PER_MINUTE_LIMIT: 2 });
    const r1 = await post(W, feedbackBody);
    const r2 = await post(W, feedbackBody);
    const r3 = await post(W, feedbackBody);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(429);
  });
});
