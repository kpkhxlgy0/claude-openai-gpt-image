import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { build as buildModule } from "esbuild";
import { findUnapprovedEndpointLiterals } from "./endpoint-literals.mjs";
import {
  readGitBlobText,
  readGitIndexEntries,
} from "./git-index.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const failures = [];

const REQUIRED_FILES = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".gitignore",
  ".mcp.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "THIRD_PARTY_NOTICES.md",
  "commands/setup.md",
  "dist/server.mjs",
  "package-lock.json",
  "package.json",
  "scripts/build.mjs",
  "scripts/git-index.d.mts",
  "scripts/git-index.mjs",
  "skills/gpt-image-2/SKILL.md",
  "skills/gpt-image-result-handling/SKILL.md",
  "test/dist/installed-plugin.test.ts",
  "test/host/claude-host.smoke.ts",
];

const TRACKED_DISTRIBUTION_FILES = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".mcp.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "THIRD_PARTY_NOTICES.md",
  "commands/setup.md",
  "dist/server.mjs",
  "skills/gpt-image-2/SKILL.md",
  "skills/gpt-image-result-handling/SKILL.md",
];

const EXPECTED_MCP = {
  mcpServers: {
    images: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"],
      env: {
        OPENAI_API_KEY: "${user_config.openai_api_key}",
        OPENAI_BASE_URL: "${user_config.openai_base_url}",
        OPENAI_ADMIN_KEY: "",
        OPENAI_ORG_ID: "",
        OPENAI_PROJECT_ID: "",
        OPENAI_WEBHOOK_SECRET: "",
        OPENAI_CUSTOM_HEADERS: "",
        GPT_IMAGE_WORKSPACE_ROOT: "${CLAUDE_PROJECT_DIR}",
        GPT_IMAGE_PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}",
      },
    },
  },
};

const EXPECTED_RUNTIME_DEPENDENCIES = {
  "@jsquash/webp": "1.5.0",
  "@modelcontextprotocol/sdk": "1.30.0",
  openai: "6.49.0",
  zod: "4.4.3",
};

const EXPECTED_DEV_DEPENDENCIES = {
  "@types/node": "20.19.43",
  esbuild: "0.28.2",
  tsx: "4.23.12",
  typescript: "7.0.2",
};

const REQUIRED_SCRIPTS = {
  typecheck: "tsc --noEmit",
  test: "tsx --test test/**/*.test.ts",
  build: "node scripts/build.mjs",
  "test:dist": "tsx --test test/dist/**/*.test.ts",
  "test:host": "tsx --test test/host/**/*.smoke.ts",
  validate: "node scripts/validate-package.mjs",
};

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

const APPROVED_ENDPOINT_HOSTS = new Set([
  "127.0.0.1",
  "api.example.invalid",
  "api.openai.com",
  "example.test",
  "private-provider.example",
  "provider.example.invalid",
  "provider.example.test",
  "registry.npmjs.org",
  "secret-endpoint.example.invalid",
  "secret-provider.example.invalid",
]);

const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:OPENAI_API_KEY|openai_api_key)\b["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/gi;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function fail(message) {
  failures.push(message);
}

const MAX_INDEX_FILE_BYTES = 128 * 1024 * 1024;
const RELEASE_VERSION = "0.1.1";

let indexMaterializationSafe = true;
let indexEntries = [];
try {
  indexEntries = readGitIndexEntries(projectRoot);
} catch {
  fail("could not read the active Git index safely");
  indexMaterializationSafe = false;
}

const entriesByPath = new Map();
for (const entry of indexEntries) {
  const existing = entriesByPath.get(entry.path) ?? [];
  existing.push(entry);
  entriesByPath.set(entry.path, existing);
}

const indexedEntryByPath = new Map();
for (const [relativePath, entries] of entriesByPath) {
  if (entries.length !== 1 || entries[0]?.stage !== 0) {
    fail(`Git-index entry must be unique stage 0: ${relativePath}`);
    indexMaterializationSafe = false;
    continue;
  }
  const entry = entries[0];
  if (entry.mode !== "100644") {
    fail(`unsupported Git-index mode ${entry.mode}: ${relativePath}`);
    indexMaterializationSafe = false;
  }
  indexedEntryByPath.set(relativePath, entry);
}

function readIndexedText(relativePath) {
  const entry = indexedEntryByPath.get(relativePath);
  if (entry === undefined) {
    throw new Error("Indexed file is unavailable");
  }
  const text = readGitBlobText(projectRoot, entry.objectId);
  if (Buffer.byteLength(text, "utf8") > MAX_INDEX_FILE_BYTES) {
    throw new Error("Indexed file exceeds the validation limit");
  }
  return text;
}

async function readJson(relativePath) {
  try {
    return JSON.parse(readIndexedText(relativePath));
  } catch {
    fail(`missing or invalid indexed JSON file: ${relativePath}`);
    return {};
  }
}

function hasEntries(value) {
  return value !== undefined && value !== null && Object.keys(value).length > 0;
}

function isCredentialShapedAssignment(value) {
  const normalized = value.trim();
  if (
    normalized === "" ||
    normalized.startsWith("${") ||
    /^(?:test|fake|dummy|example|placeholder|redacted)(?:[-_]|$)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    normalized.length >= 16 &&
    /[A-Za-z]/.test(normalized) &&
    /[0-9_-]/.test(normalized)
  );
}

function validateLockEntry(relativePath, entry) {
  if (entry?.link === true) {
    fail(`package-lock.json must not contain linked package ${relativePath}`);
    return;
  }
  if (typeof entry?.resolved !== "string") {
    fail(`package-lock.json package is missing a resolved URL: ${relativePath}`);
  } else {
    try {
      const resolved = new URL(entry.resolved);
      if (
        resolved.protocol !== "https:" ||
        resolved.origin !== NPM_REGISTRY_ORIGIN
      ) {
        fail(`package-lock.json package must resolve from the npm registry: ${relativePath}`);
      }
    } catch {
      fail(`package-lock.json package has an invalid resolved URL: ${relativePath}`);
    }
  }
  if (
    typeof entry?.integrity !== "string" ||
    !SHA512_INTEGRITY_PATTERN.test(entry.integrity)
  ) {
    fail(`package-lock.json package must have SHA-512 integrity: ${relativePath}`);
  }
}

function dependencyLockPath(name) {
  return `node_modules/${name}`;
}

function shouldScanEndpointLiterals(relativePath) {
  return (
    relativePath === ".claude-plugin/plugin.json" ||
    relativePath === ".claude-plugin/marketplace.json" ||
    relativePath === ".mcp.json" ||
    relativePath === "CHANGELOG.md" ||
    relativePath === "README.md" ||
    relativePath === "README.zh-CN.md" ||
    relativePath.startsWith("commands/") ||
    relativePath.startsWith("scripts/") ||
    relativePath.startsWith("skills/") ||
    relativePath.startsWith("src/") ||
    relativePath.startsWith("test/")
  );
}

function allowsSourceCheckoutPath(relativePath) {
  return (
    relativePath.startsWith("docs/superpowers/plans/") ||
    relativePath.startsWith("docs/superpowers/specs/")
  );
}

const tracked = [...entriesByPath.keys()];
const trackedSet = new Set(tracked);

for (const relativePath of REQUIRED_FILES) {
  if (!trackedSet.has(relativePath)) {
    fail(`missing required indexed file: ${relativePath}`);
  }
}

for (const relativePath of TRACKED_DISTRIBUTION_FILES) {
  if (!trackedSet.has(relativePath)) {
    fail(`distribution file must be Git-tracked: ${relativePath}`);
  }
}

for (const relativePath of tracked) {
  if (/(^|\/)node_modules(?:\/|$)/i.test(relativePath)) {
    fail(`node_modules must not be tracked: ${relativePath}`);
  }
  if (/(^|\/)\.env(?:\.[^/]*)?(?:\/|$)/i.test(relativePath)) {
    fail(`environment files must not be tracked: ${relativePath}`);
  }
  if (/(^|\/)\.claude(?:\/|$)/i.test(relativePath)) {
    fail(`temporary Claude workspace files must not be tracked: ${relativePath}`);
  }
  if (/(^|\/)(?:tmp|temp)(?:\/|$)/i.test(relativePath)) {
    fail(`temporary files must not be tracked: ${relativePath}`);
  }
  if (/(^|\/)generated-images(?:\/|$)/i.test(relativePath)) {
    fail(`generated images must not be tracked: ${relativePath}`);
  }
  if (
    relativePath.startsWith("dist/") &&
    relativePath !== "dist/server.mjs"
  ) {
    fail(`unexpected tracked dist file: ${relativePath}`);
  }
}

if (!trackedSet.has("dist/server.mjs")) {
  fail("dist/server.mjs must be tracked so Git marketplace installs include the runtime entry point");
}

try {
  const ignoreLines = readIndexedText(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!ignoreLines.includes("dist/*")) {
    fail(".gitignore must ignore other dist contents with dist/*");
  }
  if (!ignoreLines.includes("!dist/server.mjs")) {
    fail(".gitignore must explicitly allow dist/server.mjs");
  }
} catch {
  fail("missing or unreadable indexed file: .gitignore");
}

const [plugin, marketplace, pkg, lock, mcp] = await Promise.all([
  readJson(".claude-plugin/plugin.json"),
  readJson(".claude-plugin/marketplace.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson(".mcp.json"),
]);

if (!isDeepStrictEqual(mcp, EXPECTED_MCP)) {
  fail(".mcp.json must exactly match the supported plugin substitution contract");
}

if (pkg.engines?.node !== ">=20") {
  fail(`package.json Node engine must be exactly ">=20"`);
}

if (!isDeepStrictEqual(pkg.dependencies, EXPECTED_RUNTIME_DEPENDENCIES)) {
  fail("package.json runtime dependencies must exactly match the pinned release set");
}
if (!isDeepStrictEqual(pkg.devDependencies, EXPECTED_DEV_DEPENDENCIES)) {
  fail("package.json development dependencies must exactly match the pinned build set");
}

for (const section of [
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]) {
  if (hasEntries(pkg[section])) {
    fail(`package.json must not declare additional runtime dependencies in ${section}`);
  }
}

if (!isDeepStrictEqual(pkg.scripts, REQUIRED_SCRIPTS)) {
  fail("package.json scripts must exactly match the approved command set");
}

const lockRoot = lock.packages?.[""];
if (pkg.version !== RELEASE_VERSION) {
  fail(`package.json version must be exactly ${RELEASE_VERSION}`);
}
if (lock.version !== pkg.version) {
  fail("package-lock.json version must match package.json");
}
if (lockRoot?.version !== pkg.version) {
  fail("package-lock.json root package version must match package.json");
}
if (lockRoot?.engines?.node !== ">=20") {
  fail(`package-lock.json root Node engine must be exactly ">=20"`);
}
if (!isDeepStrictEqual(lockRoot?.dependencies, EXPECTED_RUNTIME_DEPENDENCIES)) {
  fail("package-lock.json root runtime dependencies must match package.json exactly");
}
if (!isDeepStrictEqual(lockRoot?.devDependencies, EXPECTED_DEV_DEPENDENCIES)) {
  fail("package-lock.json root development dependencies must match package.json exactly");
}

for (const [relativePath, entry] of Object.entries(lock.packages ?? {})) {
  if (relativePath === "") continue;
  validateLockEntry(relativePath, entry);
}
for (const [name, expectedVersion] of Object.entries({
  ...EXPECTED_RUNTIME_DEPENDENCIES,
  ...EXPECTED_DEV_DEPENDENCIES,
})) {
  const entry = lock.packages?.[dependencyLockPath(name)];
  if (entry?.version !== expectedVersion) {
    fail(`package-lock.json must pin ${name} to ${expectedVersion}`);
  }
}

if (plugin.name !== "gpt-image-2") {
  fail("plugin.json name must be gpt-image-2");
}
if (plugin.version !== pkg.version) {
  fail("plugin.json version must match package.json");
}
if (plugin.author?.name !== "KPK") {
  fail("plugin.json author must be KPK");
}
if (plugin.license !== "MIT") {
  fail("plugin.json license must be MIT");
}
if (
  !isDeepStrictEqual(plugin.userConfig?.openai_api_key, {
    type: "string",
    title: "OpenAI API key",
    description:
      "API key used only by the local GPT Image 2 MCP server. Stored in Claude's sensitive plugin configuration.",
    sensitive: true,
    required: false,
  })
) {
  fail("plugin.json must define the exact optional-at-startup sensitive API-key configuration");
}
if (
  !isDeepStrictEqual(plugin.userConfig?.openai_base_url, {
    type: "string",
    title: "OpenAI Base URL",
    description:
      "OpenAI or trusted OpenAI-compatible endpoint base URL. The chosen endpoint receives the API key, image prompt, and edit input images. Default: https://api.openai.com/v1",
    required: false,
    default: "https://api.openai.com/v1",
  })
) {
  fail("plugin.json must define the exact optional Base URL configuration");
}

if (marketplace.name !== "kpk-plugins") {
  fail("marketplace.json name must be kpk-plugins");
}
if (marketplace.owner?.name !== "KPK") {
  fail("marketplace.json owner must be KPK");
}
if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
  fail("marketplace.json must contain exactly one plugin");
}

const marketplacePlugin = marketplace.plugins?.[0];
if (marketplacePlugin) {
  if (marketplacePlugin.name !== plugin.name) {
    fail("marketplace plugin name must match plugin.json");
  }
  if (marketplacePlugin.version !== pkg.version) {
    fail("marketplace plugin version must match package.json");
  }
  if (marketplacePlugin.source !== "./") {
    fail(`marketplace plugin source must be "./"`);
  }
  if (marketplacePlugin.author?.name !== "KPK") {
    fail("marketplace plugin author must be KPK");
  }
  if (marketplacePlugin.license !== "MIT") {
    fail("marketplace plugin license must be MIT");
  }
  if (marketplacePlugin.strict !== true) {
    fail("marketplace plugin must enable strict validation");
  }
}

let distContents;
try {
  distContents = readIndexedText("dist/server.mjs");
} catch {
  fail("could not read indexed dist/server.mjs");
}

if (distContents !== undefined) {
  if (Buffer.byteLength(distContents, "utf8") === 0) {
    fail("dist/server.mjs must not be empty");
  } else {
    let distValidationRoot;
    try {
      distValidationRoot = await mkdtemp(
        path.join(os.tmpdir(), "gpt-image-index-dist-"),
      );
      const distPath = path.join(distValidationRoot, "server.mjs");
      await writeFile(distPath, distContents);

      try {
        execFileSync(process.execPath, ["--check", distPath], {
          cwd: distValidationRoot,
          stdio: "ignore",
        });
      } catch {
        fail("dist/server.mjs must pass node --check");
      }

      try {
        const analysis = await buildModule({
          entryPoints: [distPath],
          bundle: false,
          write: false,
          metafile: true,
          platform: "node",
          format: "esm",
          target: "node20",
          logLevel: "silent",
        });
        for (const input of Object.values(analysis.metafile.inputs)) {
          for (const imported of input.imports) {
            if (!imported.path.startsWith("node:")) {
              fail(
                `dist/server.mjs contains a non-builtin runtime import: ${imported.path}`,
              );
            }
          }
        }
      } catch {
        fail("dist/server.mjs must be parseable by esbuild");
      }

      if (indexMaterializationSafe) {
        let indexedSourceRoot;
        try {
          indexedSourceRoot = await mkdtemp(
            path.join(os.tmpdir(), "gpt-image-index-source-"),
          );
          const prefix = `${path.resolve(indexedSourceRoot).replaceAll("\\", "/")}/`;
          execFileSync(
            "git",
            ["checkout-index", "--all", `--prefix=${prefix}`],
            {
              cwd: projectRoot,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          await symlink(
            path.join(projectRoot, "node_modules"),
            path.join(indexedSourceRoot, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
          );
          const rebuilt = await buildModule({
            absWorkingDir: indexedSourceRoot,
            stdin: {
              contents: [
                'import "./src/index.ts";',
                'export { inspectImage } from "./src/images/inspect-image.ts";',
              ].join("\n"),
              loader: "ts",
              resolveDir: indexedSourceRoot,
              sourcefile: "src/bundle-entry.ts",
            },
            outfile: path.join(indexedSourceRoot, "dist", "server.mjs"),
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
            preserveSymlinks: true,
            write: false,
            logLevel: "silent",
          });
          const rebuiltBundle = rebuilt.outputFiles?.[0]?.text.replace(
            /^[\t ]+$/gm,
            "",
          );
          if (rebuiltBundle === undefined || rebuiltBundle !== distContents) {
            fail(
              "dist/server.mjs must match the deterministic build from indexed sources",
            );
          }
        } catch {
          fail("could not rebuild dist/server.mjs from indexed sources");
        } finally {
          if (indexedSourceRoot !== undefined) {
            await rm(indexedSourceRoot, { recursive: true, force: true });
          }
        }
      }

      try {
        const decoderPath = require.resolve(
          "@jsquash/webp/codec/dec/webp_dec.wasm",
        );
        const decoderBase64 = (await readFile(decoderPath)).toString("base64");
        if (!distContents.includes(decoderBase64)) {
          fail("dist/server.mjs is missing the complete embedded WebP decoder WASM");
        }
      } catch {
        fail("could not verify the complete embedded WebP decoder WASM");
      }
    } catch {
      fail("could not materialize indexed dist/server.mjs for validation");
    } finally {
      if (distValidationRoot !== undefined) {
        await rm(distValidationRoot, { recursive: true, force: true });
      }
    }
  }
}

const normalizedRoot = projectRoot
  .replace(/\\+/g, "/")
  .replace(/\/+$/, "")
  .toLowerCase();
for (const relativePath of tracked) {
  let text;
  try {
    text = readIndexedText(relativePath);
  } catch {
    fail(`could not read tracked Git-index file: ${relativePath}`);
    continue;
  }

  if (API_KEY_PATTERN.test(text)) {
    fail(`tracked file contains an API-key-shaped value: ${relativePath}`);
  }
  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SENSITIVE_ASSIGNMENT_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (isCredentialShapedAssignment(value)) {
      fail(`tracked file contains a credential-shaped assignment: ${relativePath}`);
    }
  }

  const normalizedText = text.replace(/\\+/g, "/").toLowerCase();
  if (
    !allowsSourceCheckoutPath(relativePath) &&
    normalizedText.includes(normalizedRoot)
  ) {
    fail(`runtime or release file contains the absolute source checkout path: ${relativePath}`);
  }

  if (shouldScanEndpointLiterals(relativePath)) {
    if (
      findUnapprovedEndpointLiterals(text, APPROVED_ENDPOINT_HOSTS).length > 0
    ) {
      fail(`application file contains an unapproved endpoint URL literal: ${relativePath}`);
    }
  }
}

if (failures.length > 0) {
  for (const message of [...new Set(failures)]) {
    console.error(`validate: ${message}`);
  }
  process.exitCode = 1;
} else {
  console.error("validate: package ok");
}
