import { app } from "./app";
import { loadConfig } from "./config";

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Stupid Upload",
    version: "0.1.0",
    description:
      "Accountless, agent-first public file uploads. Temporary files expire 24 hours after upload; permanent files have no scheduled expiration and are paid with Base USDC via x402.",
  },
  servers: [{ url: "https://upload.stupidtech.net" }],
  paths: {
    "/v1/uploads/temporary": {
      post: {
        operationId: "createTemporaryUpload",
        summary: "Create a temporary upload reservation (free, expires in 24h)",
        "x-price-formula": "free",
      },
    },
    "/v1/uploads/permanent": {
      post: {
        operationId: "createPermanentUpload",
        summary: "Create a permanent upload reservation (paid via x402)",
        "x-payment-info": {
          protocol: "x402",
          network: "eip155:8453",
          token: "USDC",
          formula: "$0.01 flat + $0.002 per started MiB after the first, up to 100 MiB",
          minUsd: "0.01",
          maxUsd: "0.208",
        },
        responses: {
          "402": { description: "Payment required. See the x402 challenge." },
        },
      },
    },
    "/v1/pricing": {
      get: {
        operationId: "getPricing",
        summary: "Advisory pricing for a size",
        parameters: [
          {
            name: "sizeBytes",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 0 },
          },
        ],
      },
    },
    "/v1/uploads/{id}/content": {
      put: { operationId: "uploadContent", summary: "Upload bytes for a reservation" },
    },
    "/v1/uploads/{id}": {
      get: { operationId: "getUploadStatus", summary: "Status of an upload" },
      delete: { operationId: "deleteUpload", summary: "Delete an upload" },
    },
    "/v1/feedback": {
      post: {
        operationId: "submitFeedback",
        summary: "Submit anonymous product feedback",
        responses: { "202": { description: "Accepted" } },
      },
    },
  },
};

function openapiJson(): unknown {
  return structuredClone(openapi);
}

const llmsTxt = `# Stupid Upload

Accountless, agent-first public file uploads on Cloudflare.

## Endpoints
- GET / appears with pricing and limits.
- POST /v1/uploads/temporary (free, <=1 MiB, expires in 24h)
- POST /v1/uploads/permanent (paid x402, <=100 MiB, no scheduled expiry)
- PUT /v1/uploads/{id}/content
- GET /f/{id}/{filename}
- DELETE /v1/uploads/{id}
- POST /v1/feedback
- GET /v1/pricing?sizeBytes=N

## Example (temporary)
1. Compute size and sha256 of your file.
2) POST /v1/uploads/temporary with {"filename","contentType","sizeBytes","sha256"} and an Idempotency-Key header (>=32 high-entropy chars).
3. PUT the bytes to uploadUrl with Authorization: Bearer <uploadToken> and matching Content-Length.
4. Download from publicUrl.
5. Delete with DELETE /v1/uploads/{id}, Bearer <deleteToken>.

## Payment
Permanent uploads are paid in Base USDC via x402. A request without payment returns a 402 challenge; pay and retry. Permanent = no scheduled expiration (subject to uploader deletion, abuse/legal removal, and service availability).`;

const x402WellKnown = {
  "resource-server": {
    id: "upload.stupidtech.net",
    name: "Stupid Upload",
    payment: { protocol: "x402", network: "eip155:8453" },
    openapi: "/openapi.json",
  },
};

export function registerDiscovery(): void {
  app.get("/", (c) => {
    const w = loadConfig({ ...c.env });
    const body = `<h1>Stupid Upload</h1>
<p>Accountless, agent-first public file uploads. Temporary files expire 24 hours after upload. Permanent files have <strong>no scheduled expiration</strong> and are paid with Base USDC via x402 (subject to uploader deletion, abuse/legal removal, and service availability).</p>
<h2>Limits</h2><ul>
<li>Temporary: free, &le;1&nbsp;MiB, 20&nbsp;MiB/day/source.</li>
<li>Permanent: $0.01 flat + $0.002 per additional started MiB after the first, &le;100&nbsp;MiB (max $0.208).</li>
</ul>
<h2>Quick start</h2><pre>curl -sS '${w.STUPID_UPLOAD_BASE_URL}/v1/pricing?sizeBytes=1234'</pre>
<p><a href="/docs">Docs</a> &middot; <a href="/openapi.json">OpenAPI</a> &middot; <a href="/llms.txt">llms.txt</a></p>`;
    return c.html(page("Stupid Upload", body));
  });

  app.get("/docs", (c) => {
    const body = `<h1>Documentation</h1>
<p>See the OpenAPI contract at <a href="/openapi.json">/openapi.json</a> and agent instructions at <a href="/llms.txt">/llms.txt</a>.</p>
<pre>temporary:
  POST /v1/uploads/temporary
permanent:
  POST /v1/uploads/permanent (x402)
pricing:
  GET /v1/pricing?sizeBytes=N
content:
  PUT /v1/uploads/{id}/content
download:
  GET /f/{id}/{filename}
status:
  GET /v1/uploads/{id}
delete:
  DELETE /v1/uploads/{id}
feedback:
  POST /v1/feedback</pre>`;
    return c.html(page("Stupid Upload — Docs", body));
  });

  app.get("/openapi.json", (c) => c.json(openapiJson()));

  app.get("/llms.txt", (c) => c.text(llmsTxt));

  app.get("/.well-known/x402", (c) => c.json(x402WellKnown));
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}code,pre{background:#f4f4f4;padding:.15rem .35rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style></head><body>${body}</body></html>`;
}
