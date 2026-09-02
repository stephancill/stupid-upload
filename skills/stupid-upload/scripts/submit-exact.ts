// @ts-nocheck  (tool library; the CLI runs under bun)
// No-key x402 "submit" seam for `upload --permanent`.
//
// When the CLI has no `STUPID_UPLOAD_PRIVATE_KEY`, it cannot sign the Permit2
// witness itself. Instead it drives `@x402/evm`'s `ExactEvmScheme` with a
// *capturing signer*: the scheme builds the full exact `PaymentPayload`
// (including the Permit2 typed-data with the correct nonce/deadline/spender and
// the PAYMENT-SIGNATURE-encoding shape). We hand that exact typed-data to a
// wallet via txlink EIP-7871 `wallet_sign`, then substitute the wallet's real
// 65-byte signature + payer `account` into the placeholder payload and re-POST
// it as the `PAYMENT-SIGNATURE` header, turning it into a CDP `exact`
// settlement the server already accepts.
//
// Nothing here ever reads, prints, or persists a private key. A rejected permit
// moves no funds.

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";

/** Placeholder payer used while capturing. Permit2 witnesses are address-free, so
 *  the payer only rides in `permit2Authorization.from`, which we overwrite with the
 *  wallet's returned `account` after signing. */
const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000";
/** 65-byte (130 hex) placeholder signature; replaced before submission. */
const PLACEHOLDER_SIG = `0x${"00".repeat(65)}`;
/** Documented v1 maximum (100 MiB = $0.208) plus a safe rounding ceiling. */
export const DEFAULT_MAX_PRICE_USD = 0.2085;

export interface CapturedExact {
  /** The built @x402 `PaymentPayload` (still carrying the placeholder sig). */
  payload: Record<string, unknown>;
  /** The exact Permit2 witness typed-data a wallet must sign (EIP-712). */
  typedData: Record<string, unknown>;
  /** The chosen `accepted` payment requirements (amount/network/asset). */
  accepted: Record<string, unknown>;
}

export interface WalletSignature {
  /** The wallet's real 65-byte signature, e.g. from txlink. */
  signature: `0x${string}`;
  /** The payer address the wallet substituted for `address`. */
  account: `0x${string}`;
  /** The typed-data that was signed (echoed back by the signer, if present). */
  message?: unknown;
}

/** Deep-clone JSON while flattening bigints to decimal strings. */
function toPlainJson(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)),
  );
}

/**
 * Builds the x402 `PaymentPayload` for the server's challenged route using a
 * capturing signer. The scheme derives the exact asset transfer method and
 * typed-data, records what it would sign (so the CLI can hand it to txlink),
 * and returns a placeholder signature. Nothing funds; no network read occurs.
 *
 * Fails closed if the route wants an EIP-3009 (payer-bound) payment, which
 * cannot be built without a known payer via `wallet_sign`.
 */
export async function captureExact(paymentRequired: unknown): Promise<CapturedExact> {
  const pr = {
    x402Version: 2,
    ...(paymentRequired as { x402Version?: number } & Record<string, unknown>),
  };
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
    address: PLACEHOLDER_ADDRESS as `0x${string}`,
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
  // Relax @x402's default $1/default-asset-only controls: the CLI enforces the
  // authoritative spend cap itself via `assertWithinPriceCap`. This keeps the
  // seam decoupled from a hardcoded USDC asset table (Base mainnet vs Sepolia).
  client.setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });

  const payload = (await client.createPaymentPayload(pr)) as Record<string, unknown>;

  if (
    captured.primaryType !== "PermitWitnessTransferFrom" ||
    (captured.domain as { name?: string } | undefined)?.name !== "Permit2"
  ) {
    throw new Error(
      `unsupported x402 payment shape (${String(captured.primaryType)}); ` +
        "the no-key path requires an address-free Permit2 witness",
    );
  }

  return {
    payload,
    typedData: captured,
    accepted: (payload.accepted ?? {}) as Record<string, unknown>,
  };
}

/**
 * The CLI's authoritative spend cap check (independent of x402's USD heuristics):
 * fails if the quoted atomic USDC `accepted.amount` exceeds `maxUsd`.
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
 * copy; the captured payload is left untouched.
 */
export function applyWalletSignature(
  payload: Record<string, unknown>,
  sig: WalletSignature,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const inner = (out.payload ?? {}) as Record<string, unknown>;
  inner.signature = sig.signature;
  const auth = inner.permit2Authorization as { from?: unknown; [k: string]: unknown } | undefined;
  if (auth && typeof auth === "object") {
    auth.from = sig.account;
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
