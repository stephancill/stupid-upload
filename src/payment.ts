import type { MiddlewareHandler } from "hono";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCdpFacilitator } from "./cdp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { WorkerConfig } from "./config";
import { pricePermanentUsd } from "./pricing";

/** Whether the paid permanent path is fully configured and enabled. */
export function isPermanentPaymentEnabled(cfg: WorkerConfig): boolean {
  if (!cfg.STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED || !cfg.STUPID_UPLOAD_PAYMENT_ADDRESS)
    return false;
  const hasCdp = Boolean(cfg.CDP_API_KEY_ID && cfg.CDP_API_KEY_SECRET);
  return Boolean(cfg.STUPID_UPLOAD_FACILITATOR_URL || hasCdp);
}

/** Exact dollar string a client must pay for a permanent upload of a size. */
export function priceDollar(sizeBytes: number): string {
  return `${pricePermanentUsd(Math.max(0, Math.floor(sizeBytes)))}`;
}

/**
 * Builds the x402 facilitator client. Prefer the CDP hosted facilitator (Base
 * mainnet is a CDP default network) when credentials are present; otherwise
 * fall back to a generic HTTP facilitator URL (tests, self-hosted facilitator).
 */
function buildFacilitator(cfg: WorkerConfig): HTTPFacilitatorClient {
  if (cfg.CDP_API_KEY_ID && cfg.CDP_API_KEY_SECRET) {
    return createCdpFacilitator(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET);
  }
  return new HTTPFacilitatorClient({ url: cfg.STUPID_UPLOAD_FACILITATOR_URL ?? "" });
}

/**
 * Builds the x402 payment middleware for the permanent upload route. The price
 * is dynamic: it reads the request's JSON body (`sizeBytes`) through the Hono
 * adapter, so an unpaid request yields an exact Base USDC `402`. After a client
 * pays, the middleware verifies+settles via the configured facilitator and only
 * then lets the route handler run (see app.ts).
 */
export function permanentPaymentMiddleware(cfg: WorkerConfig): MiddlewareHandler {
  const network = cfg.STUPID_UPLOAD_PAYMENT_NETWORK;
  const payTo = cfg.STUPID_UPLOAD_PAYMENT_ADDRESS ?? "";

  const facilitatorClient = buildFacilitator(cfg);

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network as `${string}:${string}`,
    new ExactEvmScheme(),
  );

  const routes = {
    "POST /v1/uploads/permanent": {
      accepts: {
        scheme: "exact",
        network: network as `${string}:${string}`,
        payTo,
        price: async (ctx: { adapter?: { getBody?: () => unknown } }) => {
          const raw = ctx.adapter?.getBody
            ? (ctx.adapter.getBody() as Promise<unknown>)
            : undefined;
          const body = (await raw) as { sizeBytes?: unknown } | undefined;
          const size = Number(body?.sizeBytes);
          return priceDollar(Number.isFinite(size) ? size : 0);
        },
      },
      description: "Stores a file with no scheduled expiration, once paid.",
      mimeType: "application/json",
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  return paymentMiddlewareFromHTTPServer(httpServer);
}

export type { MiddlewareHandler };
