#!/usr/bin/env node
// Builds the distributable single-file Node CLI to ./dist/stupid-upload.mjs.
// Internal source is bundled; @x402/* and viem stay external node module deps.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.resolve(root, "../src/cli.ts")],
  outfile: path.resolve(root, "../dist/stupid-upload.mjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: [
    "@x402/core",
    "@x402/core/*",
    "@x402/evm",
    "@x402/evm/*",
    "@x402/fetch",
    "viem",
    "viem/*",
  ],
  sourcemap: false,
  logLevel: "info",
});
