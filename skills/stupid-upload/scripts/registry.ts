// @ts-nocheck  (tool library; the CLI runs under bun)
// Local upload registry so the CLI can list recorded uploads and delete them
// without the user re-supplying a delete token.
//
// Stored data includes bearer delete tokens (delete credentials), so the state
// file is created mode 0600 and we never echo tokens back in `list` output.
// The path defaults to ~/.stupid-upload/uploads.json and can be overridden with
// STUPID_UPLOAD_STATE_FILE (e.g. for tests / ephemeral sandboxes).

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface UploadRecord {
  id: string;
  path: string; // resolved local source path
  filename: string;
  retention: "temporary" | "permanent";
  sizeBytes: number;
  sha256: string;
  publicUrl: string;
  createdAt: number; // epoch seconds
  expiresAt: number | null; // temporary only
  deleteToken: string; // never echoed by `list`
}

export function registryFile(): string {
  return (
    process.env.STUPID_UPLOAD_STATE_FILE ?? path.join(homedir(), ".stupid-upload", "uploads.json")
  );
}

export async function readRegistry(): Promise<UploadRecord[]> {
  try {
    const raw = await readFile(registryFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UploadRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeRegistry(records: UploadRecord[]): Promise<void> {
  const file = registryFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await import("node:fs/promises").then(({ rename }) => rename(tmp, file));
}

/** Upsert a record by id, preserving any extra records. */
export async function addRecord(record: UploadRecord): Promise<void> {
  const records = await readRegistry();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  await writeRegistry(records);
}

/** The stored delete token for an id, if any. */
export async function deleteTokenFor(id: string): Promise<string | undefined> {
  const records = await readRegistry();
  return records.find((r) => r.id === id)?.deleteToken;
}

/** Remove a record (e.g. after a successful server delete). */
export async function removeRecord(id: string): Promise<void> {
  const records = await readRegistry();
  const next = records.filter((r) => r.id !== id);
  if (next.length !== records.length) await writeRegistry(next);
}

/** Public-safe projection for `list` (never includes tokens). */
export function publicRecord(r: UploadRecord) {
  return {
    id: r.id,
    path: r.path,
    filename: r.filename,
    retention: r.retention,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    publicUrl: r.publicUrl,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}
