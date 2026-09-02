// @ts-nocheck  (tool library; the CLI runs under bun)
// No-key x402 "submit" seam for `upload --permanent`.
//
// The paid route uses the `exact` scheme's payer-bound EIP-3009
// (`transferWithAuthorization`) transfer, which embeds `from` (the payer) in
// the signed EIP-712 message and needs NO standing Permit2 allowance. When the
// CLI has no `STUPID_UPLOAD_PRIVATE_KEY` it cannot sign itself, so it drives
// `@x402/evm`'s `ExactEvmScheme` with a *capturing signer*:
//
//  1. The scheme builds the full `PaymentPayload` (authorization + typed-data)
//     using the txlink substitution sentinel `0xaaaa...aaaa` as the payer.
//  2. The CLI hands that exact typed-data to txlink `wallet_sign` (type 0x01).
//     txlink replaces the all-`a` sentinel with the connected wallet's address
//     and signs (EIP-7871, or `eth_signTypedData_v4` fallback), returning
//     `{ signature, message, account }`.
//  3. We substitute the real signature + payer `account` into the captured
//     payload and re-POST it as `PAYMENT-SIGNATURE` so the facilitator settles
//     the `exact` transfer.
//
// Nothing reads, prints, or persists a private key. A rejected transfer moves
// no funds.
//
// The all-`a` sentinel is txlink's contract for account substitution (matching
// the EIP-7871 "no fixed address" idea, implemented as an explicit replace).

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";

/** txlink substitute-any-address sentinel (40 `a`s). Replaced with the payer's
 *  account by txlink before signing; the wallet's signature is then bound to `from`. */
const SUBSTITUTE_ANY_ID = `0x${"a".repeat(40)}` as `0x${string}`;
/** 65-byte placeholder signature (130 hex); replaced before submission. */
const PLACEHOLDER_SIG = `0x${"00".repeat(65)}`;
/** Documented v1 maximum (100 MiB = $0.208) plus a safe rounding ceiling. */
export const DEFAULT_MAX_PRICE_USD = 0.2085;

export interface CapturedExact {
  /** The built @x402 `PaymentPayload` (still carrying the placeholder sig). */
  payload: Record<string, unknown>;
  /** The exact EIP-3009 typed-data a wallet must sign (with sentinel `from`). */
  typedData: Record<string, unknown>;
  /** The chosen `accepted` payment requirements (amount/network/asset). */
  accepted: Record<string, unknown>;
}

export interface WalletSignature {
  /** The wallet's real signature (from txlink). */
  signature: `0x${string}`;
  /** The payer address txlink substituted for the sentinel. */
  account: `0x${string}`;
  /** The typed-data that was signed (echoed back, when present). */
  message?: unknown;
}

/** Deep-clone JSON while flattening bigints to decimal strings. */
function toPlainJson(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)),
  );
}

/**
 * Builds the `PaymentPayload` for the challenged exact route via a capturing
 * signer. The scheme derives the EIP-3009 typed-data (with the substitute
 * sentinel as `from`), which the CLU hands to txlink; the `message.from` carries
 * the sentinel so txlink replaces it. Nothing funds; no network read occurs.
 *
 * Fails closed on any non-EIP-3053 signed shape (should not happen for the
 * single exact route, but keeps the seam safe against a misconfig).
 */
export async function captureExact(paymentRequired: unknown): Promise<CapturedExact> {
  const base = (paymentRequired as { x402Version?: number } & Record<string, unknown>) ?? {};
  const pr = { x402Version: 2, ...base };

  const networks = Array.from(
    new Set(
      ((pr.accepts as Array<Record<string, unknown>> | undefined) ?? []).map(
        (a) => a.network as string,
      ),
    ),
  );
  if (networks.length === 0) {
    throw new Error("the x402 challenge carried no accepted payment requirements");
  }

  const captured: Record<string, unknown> = {};
  const capturingSigner = {
    address: SUBSTITUTE_ANY_ID,
    async signTypedData(typed: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      // Snapshot the exact typed-data the scheme wants signed (deep copy so a
      // later mutation by the scheme doesn't change what the wallet approves).
      Object.assign(captured, toPlainJson(typed));
      return PLACEHOLDER_SIG as `0x${string}`;
    },
  };

  const client = new x402Client();
  for (const network of networks) {
    client.register(network, new ExactEvmScheme(capturingSigner));
  }
  // Relax @x4default $1/default-asset controls: the CLI enforces the
  // authoritative spend cap itself via `assertWithinPriceCap`.
  client.setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });

  const payload = (await client.createPaymentPayload(pr)) as Record<string, unknown>;

  if (captured.primaryType !== "TransferWithAuthorization") {
    throw new Error(
      `unsupported x402 payment shape (${String(captured.primaryType)}); ` +
        "the no-key path requires an EIP-3009 transferWithAuthorization",
    );
  }

  return {
    payload,
    typedData: captured,
    accepted: (payload.accepted ?? {}) as Record<string, unknown>,
  };
}

/**
 * The CLI's authoritative spend cap check: fails if the quoted atomic USDC
 * `accepted.amount` exceeds `maxUsd`.
 */
export function assertWithinPriceCap(accepted: Record<string, unknown>, maxUsd: number): void {
  const raw = accepted.amount;
  const amount = typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : null;
  const cap = BigInt(Math.round(maxUsd * 1_000_000));
  if (amount !== null && amount > cap) {
    throw new Error(
      `quote amount ${accepted.amount} (${accepted.network}) exceeds the ` +
        `allowed cap of $${maxUsd.toFixed(6)}`,
    );
  }
}

/**
 * Splices the wallet's real signature + payer address into a captured payload,
 * producing the final object to encode as `PAYMENT-SIGNATURE`. Returns a deep
 * copy; the captured payload is left untouched. A `from` matching the substitute
 * sentinel is replaced with the returned `account` (txlink signs the real one in
 * the message, so the payload `from` must match).
 */
export function applyWalletSignature(
  payload: Record<string, unknown>,
  sig: WalletSignature,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const inner = (out.payload ?? {}) as Record<string, unknown>;
  inner.signature = sig.signature;
  const auth = inner.authorization as { from?: unknown; [k: string]: unknown } | undefined;
  if (auth && typeof auth === "object") {
    auth.from =
      String(auth.from).toLowerCase() === SUBSTITUTE_ANY_ID.toLowerCase() ? sig.account : auth.from;
  }
  return out;
}

/**
 * Encodes a payment payload into the wire `PAYMENT-SIGNATURE` header (base64
 * JSON) - the same header the hosted x402 decoder / our server reads.
 */
export function encodePaymentSignatureHeader(
  payload: Record<string, unknown>,
): Record<string, string> {
  return new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payload as never);
}
