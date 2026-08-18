import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outfile = join(projectRoot, "dist", "server.mjs");
const require = createRequire(import.meta.url);

await mkdir(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: projectRoot,
  stdin: {
    contents: [
      'import "./src/index.ts";',
      'export { inspectImage } from "./src/images/inspect-image.ts";',
    ].join("\n"),
    loader: "ts",
    resolveDir: projectRoot,
    sourcefile: "src/bundle-entry.ts",
  },
  outfile,
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: true,
  packages: "bundle",
  define: {
    __BUNDLED_WEBP_WASM__: "true",
  },
  sourcemap: false,
  loader: {
    ".wasm": "base64",
  },
});

const decoderWasmPath = require.resolve(
  "@jsquash/webp/codec/dec/webp_dec.wasm",
);
const decoderWasm = await readFile(decoderWasmPath);
const decoderBase64 = decoderWasm.toString("base64");
const bundleText = await readFile(outfile, "utf8");
const normalizedBundle = bundleText.replace(/^[\t ]+$/gm, "");
if (normalizedBundle !== bundleText) {
  await writeFile(outfile, normalizedBundle, "utf8");
}

if (!normalizedBundle.includes(decoderBase64)) {
  throw new Error("built server is missing the complete embedded WebP decoder WASM");
}

console.error(`built ${outfile}`);
