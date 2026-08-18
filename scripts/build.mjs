import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outfile = join(projectRoot, "dist", "server.mjs");

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

const decoderWasmPath = fileURLToPath(
  import.meta.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"),
);
const decoderWasm = await readFile(decoderWasmPath);
const decoderFingerprint = Buffer.from(
  decoderWasm.subarray(0, 96).toString("base64"),
);
const bundleText = await readFile(outfile, "utf8");
const normalizedBundle = bundleText.replace(/^[\t ]+$/gm, "");
if (normalizedBundle !== bundleText) {
  await writeFile(outfile, normalizedBundle, "utf8");
}

const bundle = Buffer.from(normalizedBundle);
if (!bundle.includes(decoderFingerprint)) {
  throw new Error("built server is missing the embedded WebP decoder WASM");
}

console.error(`built ${outfile}`);
