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

/**
 * Debug instrumentation: logs a structured, non-sensitive reason whenever the
 * facilitator rejects a payment, so we can diagnose settlement failures (the
 * protocol middleware otherwise swallows them into a bare `402`). Never logs
 * signatures, raw payments, or secrets.
 */
function instrumentFacilitator(f: HTTPFacilitatorClient): HTTPFacilitatorClient {
  const client = f as unknown as {
    verify: (p: unknown, r: unknown) => Promise<{ failure?: unknown; errorReason?: unknown }>;
    settle: (p: unknown, r: unknown) => Promise<{ failure?: unknown; errorReason?: unknown }>;
    [k: string]: unknown;
  };
  const verify = client.verify.bind(client);
  const settle = client.settle.bind(client);
  client.verify = async (payload, reqs) => {
    try {
      const res = await verify(payload, reqs);
      report("verify", res);
      return res;
    } catch (e) {
      reportErr("verify", e);
      throw e;
    }
  };
  client.settle = async (payload, reqs) => {
    try {
      const res = await settle(payload, reqs);
      report("settle", res);
      return res;
    } catch (e) {
      reportErr("settle", e);
      throw e;
    }
  };
  return f;
}

function report(step: string, res: { failure?: unknown; errorReason?: unknown } | undefined): void {
  const fail = res?.failure ?? res?.errorReason;
  if (fail !== undefined && fail !== null) {
    console.error(`[x402] ${step} rejected`, summarize(fail));
  }
}

function reportErr(step: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[x402] ${step} threw`, summarize(msg));
}

/** Keep rejections short + safe (truncate; no raw payloads). */
function summarize(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 2000);
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
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

  const facilitatorClient = instrumentFacilitator(buildFacilitator(cfg));

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network as `${string}:${string}`,
    new ExactEvmScheme(),
  );

  const dynamicPrice: (ctx: { adapter?: { getBody?: () => unknown } }) => Promise<string> = async (
    ctx,
  ) => {
    const raw = ctx.adapter?.getBody ? (ctx.adapter.getBody() as Promise<unknown>) : undefined;
    const body = (await raw) as { sizeBytes?: unknown } | undefined;
    const size = Number(body?.sizeBytes);
    return priceDollar(Number.isFinite(size) ? size : 0);
  };

  const routes = {
    "POST /v1/uploads/permanent": {
      // Single payer-bound EIP-3009 `exact` payment (transferWithAuthorization),
      // which needs no standing Permit2 allowance. The no-key path signs it via
      // txlink `wallet_sign` (type 0x01): txlink substitutes the connected wallet
      // for the all-`a` address placeholder and falls back to
      // `eth_signTypedData_v4` when the wallet lacks EIP-7871.
      accepts: {
        scheme: "exact",
        network: network as `${string}:${string}`,
        payTo,
        price: dynamicPrice,
        maxTimeoutSeconds: 60 * 60,
      },
      description: "Stores a file with no scheduled expiration, once paid.",
      mimeType: "application/json",
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  return paymentMiddlewareFromHTTPServer(httpServer);
}

export type { MiddlewareHandler };
