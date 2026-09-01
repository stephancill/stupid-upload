import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app } from "../src/app";
import { makeTestEnv } from "./helpers/fake";
import { resetBurstStore } from "../src/feedback-rate";

let W: ReturnType<typeof makeTestEnv>;

const FACILITATOR = "https://provider.example.test";
const PAY_TO_0x = "0x0123456789abcdef0123456789abcdef01234567";

function metaBody(sizeBytes: number) {
  return {
    filename: "big.bin",
    contentType: "application/octet-stream",
    sizeBytes,
    sha256: "cd".repeat(32),
  };
}

function postPermanent(env: ReturnType<typeof makeTestEnv>, body: unknown) {
  return app.request(
    "/v1/uploads/permanent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m".repeat(40) },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  resetBurstStore();
  W = makeTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /v1/uploads/permanent (payment)", () => {
  it("returns 501 when x402 is not configured", async () => {
    const res = await postPermanent(W, metaBody(1024));
    expect(res.status).toBe(501);
  });

  it("creates a paid reservation with the settled price recorded when enabled", async () => {
    W = makeTestEnv({ STUPID_UPLOAD_ALLOW_UNPAID_PERMANENT: true });
    const res = await postPermanent(W, metaBody(10 * 1024 * 1024));
    expect(res.status).toBe(201);
    const data = await res.json<any>();
    expect(data.retention).toBe("permanent");
    expect(data.expiresAt).toBeNull();
    expect(data.priceAtomic).toBe("28000"); // $0.028 in six-decimal USDC units
  });

  it("honors idempotency so a settled slot is not recharged", async () => {
    W = makeTestEnv({ STUPID_UPLOAD_ALLOW_UNPAID_PERMANENT: true });
    const a = await postPermanent(W, metaBody(1048576));
    const b = await postPermanent(W, metaBody(1048576));
    const ja = await a.json<any>();
    const jb = await b.json<any>();
    expect(ja.id).toBe(jb.id);
  });

  it("returns an exact-size 402 challenge for an unpaid request", async () => {
    W = makeTestEnv({
      STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED: true,
      STUPID_UPLOAD_FACILITATOR_URL: FACILITATOR,
      STUPID_UPLOAD_PAYMENT_NETWORK: "eip155:84532",
      STUPID_UPLOAD_PAYMENT_ADDRESS: PAY_TO_0x,
    });
    vi.stubGlobal("fetch", async (input: any) => {
      const url = typeof input === "string" ? input : String(input.url);
      if (url.endsWith("/supported")) {
        return new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
            extensions: [],
            signers: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const res = await postPermanent(W, metaBody(1048576));
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf-8"));
    const accept = decoded.accepts?.[0];
    expect(accept?.scheme).toBe("exact");
    expect(accept?.network).toBe("eip155:84532");
    // 1 MiB → $0.01 → 10000 atomic USDC.
    expect(accept?.amount).toBe("10000");
  });
});
