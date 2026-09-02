import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addRecord,
  deleteTokenFor,
  publicRecord,
  readRegistry,
  registryFile,
  removeRecord,
  type UploadRecord,
} from "../skills/stupid-upload/scripts/registry";

let dir = "";
const base: UploadRecord = {
  id: "v_a03x",
  path: "/tmp/some/file.txt",
  filename: "file.txt",
  retention: "temporary",
  sizeBytes: 42,
  sha256: "abcd",
  publicUrl: "https://upload.stupidtech.net/f/v_a03x/file.txt",
  createdAt: 1,
  expiresAt: 86401,
  deleteToken: "SECRET_tok",
};

describe("local upload registry", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "stu-reg-"));
    process.env.STUPID_UPLOAD_STATE_FILE = path.join(dir, "uploads.json");
    await rm(process.env.STUPID_UPLOAD_STATE_FILE, { force: true });
  });
  afterEach(async () => {
    delete process.env.STUPID_UPLOAD_STATE_FILE;
    await rm(dir, { recursive: true, force: true });
  });

  it("persists and reads a record, and returns its delete token", async () => {
    await addRecord(base);
    const records = await readRegistry();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(base.id);
    expect(await deleteTokenFor(base.id)).toBe("SECRET_tok");
  });

  it("writes the state file with 0600 permissions", async () => {
    await addRecord(base);
    const st = await readFile(registryFile());
    expect(st.toString()).toContain(base.id);
    const mode = (await import("node:fs/promises"))
      .stat(registryFile())
      .then((s) => s.mode & 0o777);
    expect(await mode).toBe(0o600);
  });

  it("upserts by id", async () => {
    await addRecord(base);
    await addRecord({ ...base, sha256: "zzzz" });
    const records = await readRegistry();
    expect(records).toHaveLength(1);
    expect(records[0]!.sha256).toBe("zzzz");
  });

  it("removes a record", async () => {
    await addRecord(base);
    await removeRecord(base.id);
    expect(await readRegistry()).toHaveLength(0);
    expect(await deleteTokenFor(base.id)).toBeUndefined();
  });

  it("public projection does not leak tokens", async () => {
    const pub: any = publicRecord(base);
    expect(pub.deleteToken).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("SECRET_tok");
  });
});
