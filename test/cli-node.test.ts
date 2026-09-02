import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../cli/package.json" with { type: "json" };

const execFileAsync = promisify(execFile);

describe("Node CLI package", () => {
  it("runs through an npm-style executable symlink", async () => {
    const executable = path.resolve("cli/dist/stupid-upload.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "stupid-upload-node-"));
    const command = path.join(directory, "stupid-upload");
    await symlink(executable, command);

    try {
      const { stdout, stderr } = await execFileAsync(command, ["--version"]);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        name: packageJson.name,
        version: packageJson.version,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults an upload without a retention flag to temporary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stupid-upload-default-"));
    const file = path.join(directory, "test.txt");
    await writeFile(file, "temporary");

    let usedTemporaryRoute = false;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/v1/uploads/temporary") {
        usedTemporaryRoute = true;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "temp_default",
            retention: "temporary",
            uploadUrl: `${baseUrl(server)}/content`,
            uploadToken: "upload-token",
            deleteToken: "delete-token",
            publicUrl: `${baseUrl(server)}/f/temp_default/test.txt`,
            expiresAt: 1,
          }),
        );
        return;
      }
      if (request.method === "PUT" && request.url === "/content") {
        response.writeHead(201).end();
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const executable = path.resolve("cli/dist/stupid-upload.mjs");
      const { stdout } = await execFileAsync(process.execPath, [executable, "upload", file], {
        env: {
          ...process.env,
          STUPID_UPLOAD_BASE_URL: baseUrl(server),
          STUPID_UPLOAD_STATE_FILE: path.join(directory, "uploads.json"),
        },
      });
      expect(usedTemporaryRoute).toBe(true);
      expect(JSON.parse(stdout).retention).toBe("temporary");
    } finally {
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function baseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server is not listening");
  return `http://127.0.0.1:${address.port}`;
}
