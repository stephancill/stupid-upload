// Real client-side x402 payment: build a fetch that pays `402`s automatically.
// Used by `upload --permanent` when STUPID_UPLOAD_PRIVATE_KEY is set.
import { baseSepolia } from "viem/chains";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

const SEPOLIA_RPC = process.env.STUPID_UPLOAD_PAYMENT_RPC_URL ?? "https://sepolia.base.org";

function toPrivateKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

/**
 * Returns a `fetch` that transparently pays x402 `402` responses on Base
 * mainnet and Base Sepolia using the given private key. RPC reads/broadcast
 * use the Base Sepolia public RPC by default.
 */
export function buildX402Fetcher(opts: { privateKey: string }) {
  const account = privateKeyToAccount(toPrivateKey(opts.privateKey));
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(SEPOLIA_RPC),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(signer))
    .register("eip155:84532", new ExactEvmScheme(signer));

  return wrapFetchWithPayment(globalThis.fetch, client);
}
