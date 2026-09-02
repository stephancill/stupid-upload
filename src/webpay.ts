/**
 * Web payment capture for the in-page (non-CLI) uploader.
 *
 * The permanent route is an x402 EIP-3009 (`exact`) payment on Base. When the
 * browser uploads a "never-expiring" file, the page can't sign with a private
 * key, so this worker derives the same canonical typed-data the CLI builds from
 * `@x402/evm` (capturing signer + substitute sentinel) and returns it as plain
 * JSON. The page requests a txlink `wallet_sign`, then splices the returned
 * signature + payer into a `PAYMENT-SIGNATURE` header and re-submits.
 *
 * Nothing here touches a network; it only shapes the EIP-712 typed data and a
 * placeholder payload that `@x402/evm` will accept for `accepted`.
 */
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { pricePermanentUsd, usdToAtomic } from "./pricing";

/** All-`a` sentinel + placeholder are used unchanged by the substitute flow. */
const SUBSTITUTE_ANY_ID = `0x${"a".repeat(40)}` as `0x${string}`;
const PLACEHOLDER_SIG = `0x${"00".repeat(65)}` as `0x${string}`;
export const MAX_TIMEOUT_SECONDS = 60 * 60;

/** Deep-clone JSON while flattening bigints to decimal strings. */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Which USDC token EIP-3009 domain to use per network (mirrors @x402/evm). */
const USDC_ASSET_DOMAIN: Record<string, { code: string; name: string; version: string }> = {
  "eip155:8453": {
    code: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    code: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
};

export interface WebAccept {
  scheme: string;
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

/** Canonical `accepts[0]` a web client feeds @x402/evm for a file size. */
export function webAccept({
  network,
  payTo,
  sizeBytes,
}: {
  network: string;
  payTo: string;
  sizeBytes: number;
}): WebAccept {
  const domain = USDC_ASSET_DOMAIN[network] ?? USDC_ASSET_DOMAIN["eip155:8453"]!;
  return {
    scheme: "exact",
    network,
    payTo,
    amount: usdToAtomic(pricePermanentUsd(sizeBytes)).toString(),
    asset: domain.code,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: domain.name, version: domain.version },
  };
}

/** The @x402 payment required container the client builds its payload from. */
export interface WebCapture {
  typedData: Record<string, unknown>;
  payload: Record<string, unknown>;
  accepted: WebAccept;
  resourceUrl: string;
}

/**
 * Return the exact typed-data (with the substitute `from` sentinel) plus the
 * placeholder payment payload for a `accepted` requirement, generated with the
 * same `@x402/evm` scheme the CLI uses. The page signs `typedData` via txlink;
 * the returned `payload` is where the signature + payer get spliced so the
 * facilitator settles the routed payment.
 */
export async function capturePayment(
  accepted: WebAccept,
  resourceUrl: string,
): Promise<WebCapture> {
  const captured: Record<string, unknown> = {};
  const capturingSigner = {
    address: SUBSTITUTE_ANY_ID,
    // Deep copy so a later mutation by the scheme doesn't change that data.
    async signTypedData(typed: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      Object.assign(captured, toPlainJson(typed));
      return PLACEHOLDER_SIG;
    },
  };

  const client = new x402Client();
  client.register(
    accepted.network as `${string}:${string}`,
    new ExactEvmScheme(capturingSigner as never),
  );
  client.setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });

  const paymentRequired = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepts: [accepted],
  };
  const payload = (await client.createPaymentPayload(paymentRequired as never)) as Record<
    string,
    unknown
  >;

  if (captured.primaryType !== "TransferWithAuthorization") {
    throw new Error("web capture requires an EIP-3009 transferWithAuthorization");
  }

  return {
    typedData: captured,
    payload,
    accepted,
    resourceUrl,
  };
}
