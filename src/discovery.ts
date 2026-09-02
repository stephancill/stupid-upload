import { app } from "./app";
import type { WorkerConfig } from "./config";
import { loadConfig } from "./config";

/**
 * First-party discovery + documentation routes. The machine contract lives in
 * `openapi` below and is mirrored by `docs/api.md`. Keep this object and the
 * API documentation in sync; the OpenAPI document is the canonical contract.
 */

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Stupid Upload",
    version: "0.1.0",
    description:
      "Accountless, agent-first public file uploads. Temporary files expire 24 hours after upload; permanent files have no scheduled expiration and are paid with Base USDC via x402 (subject to uploader deletion, abuse/legal removal, and service availability).",
  },
  servers: [{ url: "https://upload.stupidtech.net" }],
  paths: {
    "/v1/uploads/temporary": {
      post: {
        operationId: "createTemporaryUpload",
        summary: "Create a temporary upload reservation (free, expires in 24h)",
        description:
          "Reserves a free upload slot. The returned uploadToken authorizes streaming bytes to /v1/uploads/{id}/content. Requires a high-entropy Idempotency-Key header.",
        "x-price-formula": "free",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadMetadata" },
              example: {
                filename: "result.json",
                contentType: "application/json",
                sizeBytes: 1234,
                sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Reservation created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Reservation" },
              },
            },
          },
          "400": { $ref: "#/components/responses/ValidationError" },
          "413": {
            description: "Payload exceeds the 1 MiB temporary limit",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": { $ref: "#/components/responses/QuotaError" },
        },
      },
    },
    "/v1/uploads/permanent": {
      post: {
        operationId: "createPermanentUpload",
        summary: "Create a permanent upload reservation (paid via x402)",
        description:
          "An unpaid request returns an exact Base USDC 402 challenge computed from sizeBytes. After the client pays and the facilitator settles, a reservation with expiresAt: null is returned. Retrying with the same Idempotency-Key returns the settled reservation without charging again.",
        "x-payment-info": {
          protocol: "x402",
          network: "eip155:8453",
          token: "USDC",
          formula: "$0.01 flat + $0.002 per started MiB after the first, up to 100 MiB",
          minUsd: "0.01",
          maxUsd: "0.208",
          settlement: "Base USDC via facilitator",
        },
        "x-bazaar": {
          payable: true,
          scheme: "exact",
          "request-example": {
            filename: "report.pdf",
            contentType: "application/pdf",
            sizeBytes: 10485760,
            sha256: "40ff7b6b5d3c2ce0d4854d0e9d0b1c2a8c63e1c05e17e7d2e4d0e0c5a5a4b3c2",
          },
          "response-example": {
            id: "p_iMmZrdB5V5KUvfUH8L4BAA",
            retention: "permanent",
            status: "pending",
            expiresAt: null,
            priceAtomic: "28000",
            priceUsd: "0.028000",
            paymentNetwork: "eip155:8453",
          },
        },
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadMetadata" },
              example: {
                filename: "report.pdf",
                contentType: "application/pdf",
                sizeBytes: 10485760,
                sha256: "012f84360120b8f0d7d5f9e6a9d56d0f8aa5c6f5d4a0b7e2f9b1c0a9e7d6c5b4a3",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Reservation created after payment",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Reservation" },
              },
            },
          },
          "402": {
            description: "Payment required. Exact Base USDC amount in the PAYMENT-REQUIRED header.",
            headers: {
              "PAYMENT-REQUIRED": {
                description:
                  "Exact JSON string with { chainId, scheme, network, asset, amount, payTo, method }.",
                schema: { type: "string" },
              },
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "400": { $ref: "#/components/responses/ValidationError" },
          "413": {
            description: "Payload exceeds the 100 MiB permanent limit",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "501": {
            description: "Permanent (paid) tier is not yet enabled in an environment",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/v1/pricing": {
      get: {
        operationId: "getPricing",
        summary: "Advisory pricing for a size",
        description:
          "Returns advisory pricing. The runtime x402 402 challenge is authoritative for the exact amount owed.",
        parameters: [
          {
            name: "sizeBytes",
            in: "query",
            required: true,
            description: "File size in bytes, 0..104857600",
            schema: { type: "integer", minimum: 0, maximum: 104857600 },
          },
        ],
        responses: {
          "200": {
            description: "Pricing information",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pricing" },
                examples: {
                  permanent: {
                    value: {
                      sizeBytes: 10485760,
                      billableMiB: 10,
                      priceUsd: 0.028,
                      priceAtomic: 28000,
                      priceAtomicString: "28000",
                      limits: { maxTemporaryBytes: 1048576, maxPermanentBytes: 104857600 },
                      network: "eip155:8453",
                      retention: [{ type: "permanent", label: "no scheduled expiry" }],
                    },
                  },
                  temporary: {
                    value: {
                      sizeBytes: 512,
                      priceUsd: 0,
                      priceAtomic: 0,
                      limits: { maxTemporaryBytes: 1048576, maxPermanentBytes: 104857600 },
                      network: "eip155:8453",
                      retention: [{ type: "temporary", expiresAfterSeconds: 86400 }],
                    },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/ValidationError" },
        },
      },
    },
    "/v1/uploads/{id}/content": {
      put: {
        operationId: "uploadContent",
        summary: "Upload bytes for a reservation",
        description:
          "Stream the file body. Requires Authorization: Bearer <uploadToken>, exact Content-Length matching the reservation, and Content-Type: application/octet-stream. R2 verifies the SHA-256 while streaming.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,32}$" },
          },
        ],
        responses: {
          "201": {
            description: "Upload stored and ready",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UploadComplete" },
              },
            },
          },
          "401": {
            description: "Missing or invalid upload token",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "409": { $ref: "#/components/responses/ConflictError" },
          "410": {
            description: "Slot expired or deleted",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "411": {
            description: "Content-Length missing or mismatched",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "415": {
            description: "Content-Type not application/octet-stream",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/v1/uploads/{id}": {
      get: {
        operationId: "getUploadStatus",
        summary: "Status of an upload",
        responses: {
          "200": {
            description: "Reservation or file metadata (no secrets)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Reservation" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "410": { $ref: "#/components/responses/Gone" },
        },
      },
      delete: {
        operationId: "deleteUpload",
        summary: "Delete an upload (idempotent)",
        description: "Requires Authorization: Bearer <deleteToken>.",
        responses: {
          "200": {
            description: "Deleted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    status: { const: "deleted" },
                    deletedAt: { type: "integer" },
                  },
                  required: ["id", "status", "deletedAt"],
                },
              },
            },
          },
          "401": {
            description: "Missing or invalid delete token",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/f/{id}/{filename}": {
      get: {
        operationId: "getFile",
        summary: "Download a file or request a byte range",
        responses: {
          "200": { description: "File bytes with safe headers" },
          "206": { description: "Partial content (byte range)" },
          "301": { description: "Mismatched filename; redirect to the canonical URL" },
          "304": { description: "Not modified (If-None-Match)" },
          "404": { $ref: "#/components/responses/NotFound" },
          "410": { $ref: "#/components/responses/Gone" },
        },
      },
      head: {
        operationId: "headFile",
        summary: "File metadata without a body",
        responses: {
          "200": { description: "Same metadata headers as GET without a body" },
          "301": { description: "Mismatched filename; redirect to canonical URL" },
          "404": { $ref: "#/components/responses/NotFound" },
          "410": { $ref: "#/components/responses/Gone" },
        },
      },
    },
    "/v1/feedback": {
      post: {
        operationId: "submitFeedback",
        summary: "Submit anonymous product feedback",
        description:
          "Does not store or echo the sender's identity, and never accepts secrets or personal information. Rate-limited per source and per day.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Feedback" },
              example: {
                category: "feature_request",
                message: "A 7-day temporary retention option would be useful.",
                rating: 4,
                relatedUploadId: "p_iMmZrdB5d5KUvfUH8L4BAA",
                requestId: "req_01Jab2",
                client: { name: "opencode", version: "2.0" },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Accepted (does not echo the message)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FeedbackResponse" },
              },
            },
          },
          "400": { $ref: "#/components/responses/ValidationError" },
          "429": { $ref: "#/components/responses/RateLimitError" },
        },
      },
    },
    "/health": {
      get: {
        operationId: "health",
        summary: "Process health check",
        responses: { "200": { description: "Healthy" } },
      },
    },
  },
  components: {
    schemas: {
      UploadMetadata: {
        type: "object",
        additionalProperties: false,
        properties: {
          filename: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description: "Display name. Never used as the storage key.",
          },
          contentType: { type: "string", maxLength: 100, description: "Declared MIME type." },
          sizeBytes: { type: "integer", minimum: 0, description: "Exact payload size in bytes." },
          sha256: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
            description: "Lowercase hex SHA-256 of the payload; verified during upload.",
          },
        },
        required: ["filename", "contentType", "sizeBytes", "sha256"],
      },
      Error: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
        },
        required: ["error"],
      },
      Reservation: {
        type: "object",
        description:
          "Reservation/file metadata. Tokens and uploadUrl are only included where the caller may use them.",
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          retention: { type: "string", enum: ["temporary", "permanent"] },
          status: { type: "string", enum: ["pending", "ready", "deleted", "expired"] },
          filename: { type: "string" },
          contentType: { type: "string" },
          sizeBytes: { type: "integer" },
          sha256: { type: "string" },
          uploadToken: { type: ["string", "null"] },
          deleteToken: { type: ["string", "null"] },
          uploadUrl: { type: ["string", "null"] },
          publicUrl: { type: "string" },
          uploadDeadline: { type: ["integer", "null"] },
          expiresAt: { type: ["integer", "null"], description: "null means no scheduled expiry" },
          priceAtomic: { type: ["string", "null"] },
          priceUsd: { type: ["string", "null"] },
          paymentNetwork: { type: ["string", "null"] },
          createdAt: { type: "integer" },
        },
        required: ["id", "retention", "status", "filename", "contentType", "sizeBytes", "sha256"],
      },
      UploadComplete: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          publicUrl: { type: "string" },
          sizeBytes: { type: "integer" },
          sha256: { type: "string" },
          retention: { type: "string" },
          expiresAt: { type: ["integer", "null"] },
          createdAt: { type: "integer" },
          etag: { type: ["string", "undefined"] },
        },
        required: ["id", "publicUrl", "sizeBytes", "sha256", "retention", "createdAt"],
      },
      Feedback: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["bug", "feature_request", "usability", "pricing", "other"],
          },
          message: { type: "string", minLength: 1, maxLength: 4000 },
          rating: { type: "integer", minimum: 1, maximum: 5 },
          relatedUploadId: { type: "string", pattern: "^[A-Za-z0-9_-]{16,32}$" },
          requestId: { type: "string", maxLength: 64 },
          client: {
            type: "object",
            properties: {
              name: { type: "string", maxLength: 32 },
              version: { type: "string", maxLength: 32 },
            },
            required: ["name", "version"],
          },
        },
        required: ["category", "message"],
      },
      FeedbackResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          feedbackId: { type: "string" },
          status: { const: "accepted" },
          receivedAt: { type: "string", format: "date-time" },
        },
        required: ["feedbackId", "status", "receivedAt"],
      },
      Pricing: {
        type: "object",
        additionalProperties: false,
        properties: {
          sizeBytes: { type: "integer" },
          billableMiB: { type: "integer" },
          priceUsd: { type: "number" },
          priceAtomic: { type: "integer" },
          priceAtomicString: { type: "string" },
          limits: {
            type: "object",
            properties: {
              maxTemporaryBytes: { type: "integer" },
              maxPermanentBytes: { type: "integer" },
            },
            required: ["maxTemporaryBytes", "maxPermanentBytes"],
          },
          network: { type: "string" },
          retention: { type: "array", items: { type: "object" } },
        },
        required: ["sizeBytes", "priceUsd", "priceAtomic"],
      },
    },
    responses: {
      ValidationError: {
        description: "Input validation failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      QuotaError: {
        description: "Daily quota exhausted",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      RateLimitError: {
        description: "Rate limited",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ConflictError: {
        description: "Conflict (e.g. already completed)",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Upload not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Gone: {
        description: "Upload expired or deleted",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
};

function openapiJson(w: WorkerConfig): unknown {
  return structuredClone({ ...openapi, servers: [{ url: w.STUPID_UPLOAD_BASE_URL }] });
}

function llmsBody(w: WorkerConfig): string {
  return `# Stupid Upload

Accountless, agent-first public file uploads on Cloudflare. Temporary files
expire 24h after a successful upload; permanent files have **no scheduled
expiration** and are paid with Base USDC via x402 (subject to uploadable
deletion, abuse/legal removal, and service availability).

Base: ${w.STUPID_UPLOAD_BASE_URL}

## Endpoints
- GET /                 — landing page with pricing + limits
- GET /docs             — documentation hub
- GET /openapi.json     — OpenAPI 3.1 contract (canonical machine spec)
- GET /health           — process health
- POST /v1/uploads/temporary   — free, <= 1 MiB, expires in 24h
- POST /v1/uploads/permanent   — paid x402, <= 100 MiB, no scheduled expiry
- PUT /v1/uploads/{id}/content — stream bytes
- GET /f/{id}/{filename}        — download (ranges, conditional)
- HEAD /f/{id}/{filename}       — metadata only
- GET /v1/uploads/{id}          — status (no secrets)
- DELETE /v1/uploads/{id}       — delete
- POST /v1/feedback             — anonymous feedback
- GET /v1/pricing?sizeBytes=N   — advisory pricing

## Example (temporary upload)
1. Compute size and lowercase hex sha256 of your file.
2. POST ${w.STUPID_UPLOAD_BASE_URL}/v1/uploads/temporary
   with header "Idempotency-Key: <random >= 32 chars>" and JSON body
   {"filename","contentType","sizeBytes","sha256"}.
3. PUT the bytes to uploadUrl with "Authorization: Bearer <uploadToken>",
   exact Content-Length, and Content-Type: application/octet-stream.
4. Download from publicUrl. It is deleted/unavailable 24h after step 3.
5. Delete with DELETE /v1/uploads/{id} + "Authorization: Bearer <deleteToken>",
   or the CLI: delete --token <delete-token>.

## Payment
Permanent uploads are paid in Base USDC via x402. An unpaid request returns a
402 challenge with an exact amount for the file size. Pay it, resend; on
success the reservation has expiresAt: null. Retry with the same
Idempotency-Key to recover the funded slot without paying twice.

## Privacy & retention
Temporary files are unavailable exactly 24h after upload (no cache survives
the expiry). "Permanent" means no scheduled expiration, subject to uploader
deletion, abuse/legal removal, and service availability. Public URLs are
bearer-like: never upload secrets.`;
}

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
    const body = `<h1>stupid upload</h1>
<p>An agent-friendly interface for free temporary uploads and paid long-term uploads.</p>
<h2>Upload a file</h2>
<p>Browser uploads are free up to 1 MiB and expire after 24 hours.</p>
<form id="upload-form"><input id="file" name="file" type="file" required><button type="submit">Upload</button></form>
<p id="upload-status" role="status" aria-live="polite"></p>
<p id="upload-result" hidden>Uploaded: <a id="upload-link"></a></p>
<h2>From the terminal</h2>
<pre><code>npx --yes stupid-upload upload ./file</code></pre>
<h2>Long-term from the terminal</h2>
<p>Paid with Base USDC via x402. Up to 100 MiB, with no scheduled expiration.</p>
<pre><code>npx --yes stupid-upload upload ./file --permanent</code></pre>
<p><a href="https://github.com/stephancill/stupid-upload">github</a> - <a href="https://x.com/stephancill">twitter</a> - <a href="https://stupidtech.net">stupidtech.net</a> - <a href="https://github.com/stephancill/stupid-upload/tree/main/skills/stupid-upload">skill</a></p>
<script type="module">
const form = document.querySelector("#upload-form");
const input = document.querySelector("#file");
const status = document.querySelector("#upload-status");
const result = document.querySelector("#upload-result");
const link = document.querySelector("#upload-link");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 1048576) {
    status.textContent = "Temporary uploads are limited to 1 MiB.";
    return;
  }

  form.querySelector("button").disabled = true;
  result.hidden = true;
  status.textContent = "Uploading...";

  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const reserved = await fetch("/v1/uploads/temporary", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID().replaceAll("-", ""),
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        sha256,
      }),
    });
    const reservation = await reserved.json();
    if (!reserved.ok) throw new Error(reservation.error?.message || "Could not reserve upload.");

    const uploaded = await fetch(reservation.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: "Bearer " + reservation.uploadToken,
        "content-type": "application/octet-stream",
      },
      body: file,
    });
    if (uploaded.status !== 201) throw new Error("Could not upload file.");

    link.href = reservation.publicUrl;
    link.textContent = reservation.publicUrl;
    result.hidden = false;
    status.textContent = "Upload complete. This link expires 24 hours after upload.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Upload failed.";
  } finally {
    form.querySelector("button").disabled = false;
  }
});
</script>`;
    return c.html(page("stupid upload", body));
  });

  app.get("/docs", (c) => {
    const body = `<h1>Documentation</h1>
<p>The canonical machine contract is <a href="/openapi.json">/openapi.json</a>. The intent/format of the same contract is mirrored in the repository <code>docs/api.md</code>.</p>
<h2>Quick reference</h2><pre>
temporary:  POST /v1/uploads/temporary          (free, &le;1 MiB, 24h)
permanent:  POST /v1/uploads/permanent          (x402, &le;100 MiB, no scheduled expiry)
pricing:    GET  /v1/pricing?sizeBytes=N
content:    PUT  /v1/uploads/{id}/content
download:   GET  /f/{id}/{filename}             (ranges, conditional)
status:     GET  /v1/uploads/{id}
delete:     DELETE /v1/uploads/{id}             (Bearer &lt;deleteToken&gt;)
feedback:   POST /v1/feedback
health:     GET  /health
</pre>
<h2>Payment</h2><pre>
An unpaid POST /v1/uploads/permanent returns 402 with an exact Base USDC
PAYMENT-REQUIRED amount. Pay it, retry; 201 has expiresAt: null.
Same Idempotency-Key &rarr; funded slot returned without a re-pay.
</pre>
<h2>Errors</h2><pre>
Envelope: {"error":{"code","message"}}
validation_error, invalid_request, quota_exceeded, unauthorized,
not_found, gone, conflict, payload_too_large, rate_limited,
payment_required, integrity_check, server_error
</pre>
<h2>Deletion & retention</h2><pre>
DELETE /v1/uploads/{id} requires a delete token. Temporary files are
logically gone exactly 24h after a successful upload. Public URLs are
bearer-like; a deleted/expired object returns 410 Gone.
</pre>`;
    return c.html(page("Stupid Upload — Docs", body));
  });

  app.get("/openapi.json", (c) => {
    const w = loadConfig({ ...c.env });
    return c.json(openapiJson(w));
  });

  app.get("/llms.txt", (c) => c.text(llmsBody(loadConfig({ ...c.env }))));

  app.get("/.well-known/x402", (c) => c.json(x402WellKnown));
}

function page(title: string, body: string): string {
  const description =
    "An agent-friendly interface for free temporary uploads and paid long-term uploads.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="https://upload.stupidtech.net"><meta property="og:image" content="https://upload.stupidtech.net/og.png"><meta name="twitter:card" content="summary_large_image"><link rel="icon" type="image/png" href="/favicon.png">
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}code,pre{background:#f4f4f4;padding:.15rem .35rem;border-radius:4px}pre{padding:1rem;overflow:auto}form{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}input,button{font:inherit}button{padding:.25rem .75rem}</style></head><body>${body}</body></html>`;
}
