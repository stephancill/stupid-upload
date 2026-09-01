import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { registerDiscovery } from "../src/discovery";
import { makeTestEnv } from "./helpers/fake";

// Register documentation/discovery routes once (normally done by src/index.ts).
registerDiscovery();

let W: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  W = makeTestEnv();
});

describe("discovery endpoints", () => {
  it("serves a landing page", async () => {
    const res = await app.request("/", {}, W);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
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
});
