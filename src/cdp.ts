import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";

/** Coinbase-hosted x402 facilitator. */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

type CdpCreds = { apiKeyId: string; apiKeySecret: string };

async function authHeadersFor(
  creds: CdpCreds,
  requestMethod: string,
  requestHost: string,
  requestPath: string,
): Promise<Record<string, string>> {
  const jwt = await generateJwt({
    apiKeyId: creds.apiKeyId,
    apiKeySecret: creds.apiKeySecret,
    requestMethod,
    requestHost,
    requestPath,
  });
  return {
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
  };
}

/**
 * Builds a CDP-hosted x402 facilitator client. The raw `HTTPFacilitatorClient`
 * from `@x402/core/server` cannot be pointed at CDP without auth, so we attach
 * per-endpoint Bearer JWTs (signed from the CDP API key) via `createAuthHeaders`.
 */
export function createCdpFacilitator(
  cdiKeyId: string,
  cdiKeySecret: string,
): HTTPFacilitatorClient {
  const { host, pathname } = new URL(CDP_FACILITATOR_URL);
  const basePath = pathname.replace(/\/$/, "");
  const creds: CdpCreds = { apiKeyId: cdiKeyId, apiKeySecret: cdiKeySecret };
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        authHeadersFor(creds, "POST", host, `${basePath}/verify`),
        authHeadersFor(creds, "POST", host, `${basePath}/settle`),
        authHeadersFor(creds, "GET", host, `${basePath}/supported`),
      ]);
      return { verify, settle, supported };
    },
  });
}
