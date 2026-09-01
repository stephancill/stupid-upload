import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { makeTestEnv } from "./helpers/fake";
import { uploadTemporary } from "./helpers/upload";

let W: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  W = makeTestEnv();
});

describe("GET /f/:id/:filename", () => {
  it("serves an uploaded file's bytes", async () => {
    const payload = new TextEncoder().encode("hello world");
    const { id } = await uploadTemporary(W, payload, { contentType: "text/plain" });
    const res = await app.request(`/f/${id}/note.txt`, {}, W);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).toBe("hello world");
  });

  it("supports byte ranges over uploaded content", async () => {
    const payload = new TextEncoder().encode("hello world");
    const { id } = await uploadTemporary(W, payload, { contentType: "text/plain" });
    const res = await app.request(`/f/${id}/note.txt`, { headers: { range: "bytes=6-10" } }, W);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await res.text()).toBe("world");
  });

  it("redirects a mismatched filename to the canonical URL", async () => {
    const payload = new TextEncoder().encode("hi");
    const { id, publicUrl } = await uploadTemporary(W, payload, { contentType: "text/plain" });
    const res = await app.request(`/f/${id}/wrong.txt`, {}, W);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(publicUrl);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.request(`/f/${"a".repeat(32)}/x.txt`, {}, W);
    expect(res.status).toBe(404);
  });
});

describe("HEAD /f/:id/:filename", () => {
  it("returns headers without a body", async () => {
    const payload = new TextEncoder().encode("hello world");
    const { id } = await uploadTemporary(W, payload, { contentType: "text/plain" });
    const res = await app.request(`/f/${id}/note.txt`, { method: "HEAD" }, W);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
  });
});

describe("expiry / deletion", () => {
  it("returns 410 for a deleted upload", async () => {
    const payload = new TextEncoder().encode("bye");
    const { id, deleteToken } = await uploadTemporary(W, payload);
    const del = await app.request(
      `/v1/uploads/${id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${deleteToken}` } },
      W,
    );
    expect(del.status).toBe(200);
    const get = await app.request(`/f/${id}/note.txt`, {}, W);
    expect(get.status).toBe(410);
  });

  it("delete is idempotent", async () => {
    const payload = new TextEncoder().encode("bye");
    const { id, deleteToken } = await uploadTemporary(W, payload);
    await app.request(
      `/v1/uploads/${id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${deleteToken}` } },
      W,
    );
    const again = await app.request(
      `/v1/uploads/${id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${deleteToken}` } },
      W,
    );
    expect(again.status).toBe(200);
  });

  it("rejects delete with a wrong token", async () => {
    const payload = new TextEncoder().encode("bye");
    const { id } = await uploadTemporary(W, payload);
    const res = await app.request(
      `/v1/uploads/${id}`,
      { method: "DELETE", headers: { authorization: "Bearer nope" } },
      W,
    );
    expect(res.status).toBe(401);
  });

  it("returns 410 for a logically expired temporary file", async () => {
    const payload = new TextEncoder().encode("expired");
    const { id } = await uploadTemporary(W, payload);
    // Backdate the expiry to force logical tombstone.
    await W.DB.prepare("UPDATE uploads SET expires_at = ?1, status = 'ready' WHERE id = ?2")
      .bind(Math.floor(Date.now() / 1000) - 1, id)
      .run();
    const res = await app.request(`/f/${id}/note.txt`, {}, W);
    expect(res.status).toBe(410);
  });
});
