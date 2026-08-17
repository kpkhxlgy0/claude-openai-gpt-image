import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outfile = join(projectRoot, "dist", "server.mjs");

await mkdir(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/index.ts"],
  outfile,
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: true,
  packages: "bundle",
  sourcemap: false,
  loader: {
    ".wasm": "base64",
  },
});

console.error(`built ${outfile}`);
