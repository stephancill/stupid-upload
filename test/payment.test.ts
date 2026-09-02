import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app } from "../src/app";
import { registerDiscovery } from "../src/discovery";
import { makeTestEnv } from "./helpers/fake";
import { resetBurstStore } from "../src/feedback-rate";
import { webAccept, capturePayment } from "../src/webpay";

// Register first-party routes (normally done for the Worker in src/index.ts).
registerDiscovery();

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
    // Single EIP-3009 exact method (payer-bound; the no-key path signs it via
    // txlink wallet_sign with account substitution).
    const accept = decoded.accepts?.[0];
    expect(decoded.accepts).toHaveLength(1);
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:84532");
    expect(accept.maxTimeoutSeconds).toBe(3600);
    // 1 MiB → $0.01 → 10000 atomic USDC.
    expect(accept.amount).toBe("10000");
  });

  it("builds a web payment capture the x402 scheme can sign", async () => {
    const accepted = webAccept({
      network: "eip155:8453",
      payTo: PAY_TO_0x,
      sizeBytes: 10485760, // 10 MiB → $0.028 → 28000
    });
    expect(accepted.scheme).toBe("exact");
    expect(accepted.amount).toBe("28000");
    expect(accepted.asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(accepted.maxTimeoutSeconds).toBe(3600);

    const capture = await capturePayment(
      accepted,
      "https://upload.stupidtech.net/v1/uploads/permanent",
    );
    expect(capture.accepted.amount).toBe("28000");
    expect(capture.typedData.primaryType).toBe("TransferWithAuthorization");
    // The placeholder payload carries the substitute sentinel as `from`.
    const auth = (capture.payload as any).payload.authorization;
    expect(String(auth.from).toLowerCase()).toBe(`0x${"a".repeat(40)}`);
  });

  it("serves the canonical web capture over HTTP when payment is enabled", async () => {
    W = makeTestEnv({
      STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED: true,
      STUPID_UPLOAD_FACILITATOR_URL: FACILITATOR,
      STUPID_UPLOAD_PAYMENT_NETWORK: "eip155:84532",
      STUPID_UPLOAD_PAYMENT_ADDRESS: PAY_TO_0x,
    });
    const res = await app.request(
      "/v1/payments/captured",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sizeBytes: 1048576 }),
      },
      W,
    );
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.typedData.primaryType).toBe("TransferWithAuthorization");
    // eip155:84532 → Base USDC @ $0.01 → 10000 atomic.
    expect(data.accepted.amount).toBe("10000");
  });
});
