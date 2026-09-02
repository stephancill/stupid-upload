import { describe, it, expect } from "vitest";
import {
  applyWalletSignature,
  assertWithinPriceCap,
  captureExact,
  DEFAULT_MAX_PRICE_USD,
  encodePaymentSignatureHeader,
} from "../skills/stupid-upload/scripts/submit-exact";

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIG = `0x${"ab".repeat(65)}` as `0x${string}`;

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
      maxTimeoutSeconds: 900,
      extra: { assetTransferMethod: "permit2" },
    },
  ],
};

describe("submit-exact seam", () => {
  it("captures the canonical Permit2 witness and a placeholder payload", async () => {
    const { payload, typedData, accepted } = await captureExact(paymentRequired);
    expect(accepted.network).toBe("eip155:84532");
    expect(accepted.amount).toBe("10000");
    // The scheme must ask the wallet to sign an address-free Permit2 witness.
    expect(typedData.primaryType).toBe("PermitWitnessTransferFrom");
    expect((typedData.domain as any).name).toBe("Permit2");
    const inner = (payload.payload as any).permit2Authorization;
    expect(typeof inner.spender).toBe("string");
    expect((payload.payload as any).signature.startsWith("0x")).toBe(true);
  });

  it("prefers the Permit2 option when the route advertises both methods", async () => {
    const both = {
      ...paymentRequired,
      accepts: [
        { ...paymentRequired.accepts[0], extra: { name: "USD Coin", version: "2" } },
        { ...paymentRequired.accepts[0], extra: { assetTransferMethod: "permit2" } },
      ],
    };
    const { typedData, accepted } = await captureExact(both);
    expect(typedData.primaryType).toBe("PermitWitnessTransferFrom");
    expect(accepted.network).toBe("eip155:84532");
  });

  it("splices the wallet signature + payer and encodes PAYMENT-SIGNATURE", async () => {
    const { payload } = await captureExact(paymentRequired);
    const finalized = applyWalletSignature(payload, { signature: SIG, account: PAYER });
    expect((finalized.payload as any).signature).toBe(SIG);
    expect((finalized.payload as any).permit2Authorization.from).toBe(PAYER);
    // Captured payload untouched.
    expect((payload.payload as any).permit2Authorization.from).not.toBe(PAYER);

    const headers = encodePaymentSignatureHeader(finalized);
    const raw = Object.keys(headers).find((k) => k === "PAYMENT-SIGNATURE");
    expect(raw).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(headers["PAYMENT-SIGNATURE"] as string, "base64").toString("utf-8"),
    );
    expect(decoded.payload.signature).toBe(SIG);
    expect(decoded.payload.permit2Authorization.from).toBe(PAYER);
    expect(decoded.accepted.amount).toBe("10000");
  });

  it("fails loud on non-Permit2 (payer-bound) routes for the no-key path", async () => {
    const pr = {
      ...paymentRequired,
      accepts: [{ ...paymentRequired.accepts[0], extra: { assetTransferMethod: "eip3009" } }],
    };
    // A payer-bound (EIP-3009) payment cannot be exact-settled for the no-key
    // path, so the seam rejects it rather than minting an insecure frame.
    await expect(captureExact(pr)).rejects.toThrow();
  });

  it("enforces the price cap in atomic USDC", () => {
    expect(() => assertWithinPriceCap({ amount: "10000" }, DEFAULT_MAX_PRICE_USD)).not.toThrow();
    expect(() => assertWithinPriceCap({ amount: "999999999" }, 0.001)).toThrow(/exceeds/);
  });
});
