// @ts-nocheck  (tool library; the CLI runs under bun)
// Thin client for txlink.stupidtech.net stored signature/transaction requests.
// Lets the CLI hand a wallet action (a typed-data signature or an approval tx)
// to a human when it has no private key of its own, and poll for the result.

export function txlinkBase(): string {
  return process.env.TXLINK_BASE_URL ?? "https://txlink.stupidtech.net";
}

export interface SignatureRequest {
  id: string;
  /** Send this to a human wallet to approve (includes a private completion token). */
  url: string;
  /** Poll this for the result. */
  statusUrl: string;
  expiresAt?: string;
}

export interface SignatureRequestOptions {
  /** The wallet that must approve (optional; the method fills `from`). */
  address?: string;
  method: string;
  chainId: number;
  params: Record<string, unknown>;
}

export type RequestStatus =
  | { status: "pending" }
  | { status: "completed"; resultType: string; result: string }
  | { status: "failed"; error?: string };

/** Create a stored signature/transaction request on txlink. */
export async function createTxlinkRequest(
  options: SignatureRequestOptions,
): Promise<SignatureRequest> {
  const res = await fetch(`${txlinkBase()}/api/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`txlink request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as SignatureRequest;
}

/** Resolve the current status of a stored txlink request from its statusUrl. */
export async function pollTxlinkRequest(statusUrl: string): Promise<RequestStatus> {
  const url = /^https?:\/\//.test(statusUrl)
    ? statusUrl
    : `${txlinkBase()}${statusUrl.startsWith("/") ? statusUrl : `/${statusUrl}`}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`txlink status fetch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as RequestStatus;
}

/** Human-readable line describing what the request asks the wallet to do. */
export function describeRequest(options: SignatureRequestOptions): string {
  const what =
    options.method === "wallet_sign"
      ? "an EIP-712 x402 Permit2 payment signature (no fixed address)"
      : options.method.startsWith("eth_signTypedData")
        ? "a typed-data payment signature"
        : options.method.startsWith("eth_sendTransaction")
          ? "a payment approval/transaction"
          : options.method;
  return `${what} on chain ${options.chainId}.`;
}
