import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { app } from "../src/app";
import { registerDiscovery } from "../src/discovery";
import { makeTestEnv } from "./helpers/fake";

// Register documentation/discovery routes once (normally done by src/index.ts).
registerDiscovery();

/** Assert every machine-contract path is documented in docs/api.md. */
async function loadOpenapiPaths(): Promise<string[]> {
  const res = await app.request("/openapi.json", {}, W);
  const doc = await res.json<any>();
  return Object.keys(doc.paths);
}

let W: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  W = makeTestEnv();
});

describe("discovery endpoints", () => {
  it("serves a landing page", async () => {
    const res = await app.request("/", {}, W);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>stupid upload</title>");
    expect(html).toContain("<h1>stupid upload</h1>");
    expect(html).toContain('id="upload-form"');
    expect(html).toContain('fetch("/v1/uploads/temporary"');
    expect(html).toContain("npx --yes stupid-upload upload ./file");
    expect(html).not.toContain("stupid-upload@0.0.2");
    expect(html).toContain("/tree/main/skills/stupid-upload");
    expect(html).toContain('property="og:image"');
    expect(html).toContain('href="/favicon.png"');
  });

  it("serves /docs", async () => {
    const res = await app.request("/docs", {}, W);
    expect(res.status).toBe(200);
  });

  it("serves valid OpenAPI 3.1 with a 402 response and x-payment-info", async () => {
    const res = await app.request("/openapi.json", {}, W);
    expect(res.status).toBe(200);
    const doc = await res.json<any>();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/uploads/permanent"].post["x-payment-info"]).toBeTruthy();
    expect(doc.paths["/v1/uploads/permanent"].post.responses["402"]).toBeTruthy();
  });

  it("OpenAPI declares every operation with a stable operationId and responses", async () => {
    const res = await app.request("/openapi.json", {}, W);
    const doc = await res.json<any>();
    const expected: [string, string][] = [
      ["/health", "get"],
      ["/v1/pricing", "get"],
      ["/v1/uploads/temporary", "post"],
      ["/v1/uploads/permanent", "post"],
      ["/v1/uploads/{id}/content", "put"],
      ["/v1/uploads/{id}", "get"],
      ["/v1/uploads/{id}", "delete"],
      ["/f/{id}/{filename}", "get"],
      ["/f/{id}/{filename}", "head"],
      ["/v1/feedback", "post"],
    ];
    for (const [path, method] of expected) {
      expect(doc.paths[path]).toBeTruthy();
      const op = doc.paths[path][method];
      expect(op).toBeTruthy();
      expect(op.operationId).toBeTruthy();
      expect(op.responses).toBeTruthy();
    }
  });

  it("OpenAPI ships typical component schemas and Bazaar example extensions", async () => {
    const res = await app.request("/openapi.json", {}, W);
    const doc = await res.json<any>();
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      "UploadMetadata",
      "Error",
      "Reservation",
      "UploadComplete",
      "Feedback",
      "FeedbackResponse",
      "Pricing",
    ]) {
      expect(schemas[name]).toBeTruthy();
    }
    expect(schemas.UploadMetadata.additionalProperties).toBe(false);
    expect(schemas.UploadMetadata.required).toContain("sha256");
    const perm = doc.paths["/v1/uploads/permanent"].post;
    expect(perm["x-payment-info"].minUsd).toBe("0.01");
    expect(perm["x-payment-info"].maxUsd).toBe("0.208");
    expect(perm["x-bazaar"]?.payable).toBe(true);
    expect(perm["x-bazaar"]["request-example"]).toBeTruthy();
    expect(perm["x-bazaar"]["response-example"]["expiresAt"]).toBeNull();
  });

  it("OpenAPI 402 declares the PAYMENT-REQUIRED header", async () => {
    const res = await app.request("/openapi.json", {}, W);
    const doc = await res.json<any>();
    const r402 = doc.paths["/v1/uploads/permanent"].post.responses["402"];
    expect(r402.headers?.["PAYMENT-REQUIRED"]).toBeTruthy();
  });

  it("serves llms.txt", async () => {
    const res = await app.request("/llms.txt", {}, W);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("/v1/uploads/temporary");
  });

  it("serves the x402 well-known discovery", async () => {
    const res = await app.request("/.well-known/x402", {}, W);
    expect(res.status).toBe(200);
    const json = await res.json<any>();
    expect(json["resource-server"].payment.protocol).toBe("x402");
    expect(json["resource-server"]).toBeTruthy();
  });

  it("returns 404 for unknown paths", async () => {
    const res = await app.request("/nope", {}, W);
    expect(res.status).toBe(404);
  });

  it("docs/api.md documents every OpenAPI path (contract drift guard)", async () => {
    const paths = await loadOpenapiPaths();
    const apiDoc = readFileSync(new URL("../docs/api.md", import.meta.url).pathname, "utf8");
    for (const p of paths) {
      // Contract routes appear as literals in the doc (e.g. /v1/uploads/temporary).
      expect(apiDoc).toContain(p);
    }
  });
});
