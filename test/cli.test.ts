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
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0xUSDC",
        payTo: "0x0123456789abcdef0123456789abcdef01234567",
      },
    ],
  }),
).toString("base64");

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
    if (url.includes("/v1/uploads/permanent")) {
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

  it("returns a txlink url alongside the signature request for a paid upload without a key", async () => {
    stubFetch();
    const dir = await mkdtemp(path.join(tmpdir(), "stu2-"));
    const file = path.join(dir, "big.bin");
    await writeFile(file, "x".repeat(1024));
    const out = (await cmdPermanentUpload(file, "application/octet-stream")) as any;
    expect(out.ok).toBe(true);
    expect(out.status).toBe("awaitingSignature");
    expect(out.payment.network).toBe("eip155:84532");
    expect(out.signatureRequest.url).toBe("https://txlink.test/?id=tx_1&token=s");
    expect(out.signatureRequest.statusUrl).toBe("https://txlink.test/api/requests/tx_1");
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a payment-enabled x402 fetcher (no network touched)", () => {
    const f = buildX402Fetcher({
      privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
    });
    expect(typeof f).toBe("function");
  });
});
