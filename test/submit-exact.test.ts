import { describe, it, expect } from "vitest";
import {
  applyWalletSignature,
  assertWithinPriceCap,
  captureExact,
  DEFAULT_MAX_PRICE_USD,
  encodePaymentSignatureHeader,
} from "../cli/src/submit-exact";

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIG = `0x${"bb".repeat(65)}` as `0x${string}`;

const paymentRequired = {
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
};

describe("submit-exact seam", () => {
  it("captures an EIP-3009 transfer (with substitute sentinel) and placeholder payload", async () => {
    const { payload, typedData, accepted } = await captureExact(paymentRequired);
    expect(accepted.network).toBe("eip155:84532");
    expect(accepted.amount).toBe("10000");
    // The scheme must ask the wallet to sign a transferWithAuthorization.
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
    const sentinel = `0x${"a".repeat(40)}`;
    expect(String((typedData.message as any).from).toLowerCase()).toBe(sentinel);
    const auth = (payload.payload as any).authorization;
    expect(String(auth.from).toLowerCase()).toBe(sentinel);
    expect(String(auth.to).toLowerCase()).toBe(paymentRequired.accepts[0]!.payTo.toLowerCase());
  });

  it("splices the wallet signature + payer and encodes PAYMENT-SIGNATURE", async () => {
    const { payload } = await captureExact(paymentRequired);
    const finalized = applyWalletSignature(payload, { signature: SIG, account: PAYER });
    expect((finalized.payload as any).signature).toBe(SIG);
    expect((finalized.payload as any).authorization.from).toBe(PAYER);
    // Captured payload untouched. (applyWalletSignature skips when the from is
    // not the sentinel, so assert the sentinel was the pre-substitute value.)
    expect(String((payload.payload as any).authorization.from).toLowerCase()).toBe(
      `0x${"a".repeat(40)}`,
    );

    const headers = encodePaymentSignatureHeader(finalized);
    const decoded = JSON.parse(
      Buffer.from(headers["PAYMENT-SIGNATURE"] as string, "base64").toString("utf-8"),
    );
    expect(decoded.payload.signature).toBe(SIG);
    expect(decoded.payload.authorization.from).toBe(PAYER);
    expect(decoded.accepted.amount).toBe("10000");
  });

  it("enforces the price cap in atomic USDC", () => {
    expect(() => assertWithinPriceCap({ amount: "10000" }, DEFAULT_MAX_PRICE_USD)).not.toThrow();
    expect(() => assertWithinPriceCap({ amount: "999999999" }, 0.001)).toThrow(/exceeds/);
  });
});
