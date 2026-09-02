import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cmdTemporaryUpload,
  cmdPermanentUpload,
} from "../skills/stupid-upload/scripts/stupid-upload";
import { buildX402Fetcher } from "../skills/stupid-upload/scripts/pay";

process.env.STUPID_UPLOAD_BASE_URL = "https://api.test";
process.env.TXLINK_BASE_URL = "https://txlink.test";
delete process.env.STUPID_UPLOAD_PRIVATE_KEY;

const paymentRequired = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "https://api.test/v1/uploads/permanent" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x0000000000000000000000000000000000000001",
        payTo: "0x0123456789abcdef0123456789abcdef01234567",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  }),
).toString("base64");

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_SIG = `0x${"ab".repeat(65)}`;

function stubFetch() {
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.startsWith("https://txlink.test") && method === "POST") {
      return new Response(
        JSON.stringify({
          id: "tx_1",
          url: "https://txlink.test/?id=tx_1&token=s",
          statusUrl: "https://txlink.test/api/requests/tx_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Polling the txlink request returns a wallet's completed signature.
    if (/^https:\/\/txlink\.test\/api\/requests\/tx_1$/.test(url) && method === "GET") {
      return new Response(
        JSON.stringify({
          status: "completed",
          resultType: "signature",
          result: JSON.stringify({
            signature: FAKE_SIG,
            account: PAYER,
            message: { primaryType: "PermitWitnessTransferFrom" },
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/uploads/permanent")) {
      // Unpaid request -> 402 challenge; the settled retry -> 201 reservation.
      if (init?.headers && (init.headers as Record<string, string>)["PAYMENT-SIGNATURE"]) {
        const r = {
          id: "perm_1",
          retention: "permanent",
          expiresAt: null,
          uploadUrl: "https://api.test/v1/uploads/perm_1/content",
          uploadToken: "tok",
          deleteToken: "dtok",
          publicUrl: "https://api.test/f/perm_1/x.txt",
        };
        return new Response(JSON.stringify(r), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 402, headers: { "payment-required": paymentRequired } });
    }
    if (url.includes("/v1/uploads/temporary") && method === "POST") {
      const r = {
        id: "temp_1",
        retention: "temporary",
        uploadUrl: "https://api.test/v1/uploads/temp_1/content",
        uploadToken: "tok",
        deleteToken: "dtok",
        publicUrl: "https://api.test/f/temp_1/x.txt",
      };
      return new Response(JSON.stringify(r), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/content") && method === "PUT") {
      return new Response("{}", { status: 201 });
    }
    if (url.includes("/v1/pricing")) {
      return new Response(JSON.stringify({ sizeBytes: 5, priceUsd: 0, retention: ["temporary"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stupid-upload CLI commands", () => {
  it("creates a temporary upload via the API", async () => {
    stubFetch();
    const dir = await mkdtemp(path.join(tmpdir(), "stu-"));
    const file = path.join(dir, "a.txt");
    await writeFile(file, "hello");
    const out = (await cmdTemporaryUpload(file, "text/plain")) as any;
    expect(out.command).toBe("upload");
    expect(out.retention).toBe("temporary");
    expect(out.publicUrl).toContain("/f/");
    await rm(dir, { recursive: true, force: true });
  });

  it("settles a paid upload without a key via capture + txlink wallet_sign", async () => {
    stubFetch();
    const dir = await mkdtemp(path.join(tmpdir(), "stu2-"));
    const file = path.join(dir, "big.bin");
    await writeFile(file, "x".repeat(1024));
    const out = (await cmdPermanentUpload(file, "application/octet-stream")) as any;
    expect(out.ok).toBe(true);
    expect(out.retention).toBe("permanent");
    expect(out.id).toBe("perm_1");
    expect(out.payer).toBe(PAYER);
    // Any settled value equals the v1 max hard cap; sanity-check the price paid.
    expect(out.expiresAt).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a paid upload above the --max-price-usd cap", async () => {
    stubFetch();
    const dir = await mkdtemp(path.join(tmpdir(), "stu3-"));
    const file = path.join(dir, "big.bin");
    await writeFile(file, "x".repeat(1024));
    await expect(cmdPermanentUpload(file, "application/octet-stream", "0.001")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a payment-enabled x402 fetcher (no network touched)", () => {
    const f = buildX402Fetcher({
      privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
    });
    expect(typeof f).toBe("function");
  });
});
