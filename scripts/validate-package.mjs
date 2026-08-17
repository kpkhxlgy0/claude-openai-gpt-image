import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function fail(message) {
  failures.push(message);
}

async function readJson(relativePath) {
  const absolute = path.join(projectRoot, relativePath);
  return JSON.parse(await readFile(absolute, "utf8"));
}

async function mustExist(relativePath) {
  const absolute = path.join(projectRoot, relativePath);
  try {
    await access(absolute, constants.F_OK);
  } catch {
    fail(`missing required file: ${relativePath}`);
  }
}

function collectTrackedTextFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--", "."],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => {
      if (file.startsWith("dist/")) return false;
      if (file === "package-lock.json") return false;
      return /\.(ts|tsx|js|mjs|cjs|json|md|txt|yml|yaml)$/i.test(file)
        || file === ".mcp.json"
        || file === ".gitignore";
    });
}

const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]{16,}/g;

await mustExist("dist/server.mjs");
await mustExist(".claude-plugin/plugin.json");
await mustExist(".claude-plugin/marketplace.json");
await mustExist(".mcp.json");
await mustExist("package.json");

const plugin = await readJson(".claude-plugin/plugin.json");
const marketplace = await readJson(".claude-plugin/marketplace.json");
const pkg = await readJson("package.json");
const mcp = await readJson(".mcp.json");

if (plugin.version !== pkg.version) {
  fail(
    `plugin.json version ${plugin.version} does not match package.json version ${pkg.version}`,
  );
}

const marketplacePlugin = marketplace.plugins?.[0];
if (!marketplacePlugin) {
  fail("marketplace.json has no plugins");
} else {
  if (marketplacePlugin.version !== pkg.version) {
    fail(
      `marketplace plugin version ${marketplacePlugin.version} does not match package.json version ${pkg.version}`,
    );
  }
  if (marketplacePlugin.source !== "./") {
    fail(`marketplace source must be "./", got ${JSON.stringify(marketplacePlugin.source)}`);
  }
  if (marketplacePlugin.name !== "gpt-image-2") {
    fail(`marketplace plugin name must be gpt-image-2, got ${marketplacePlugin.name}`);
  }
}

if (marketplace.name !== "kpk-plugins") {
  fail(`marketplace name must be kpk-plugins, got ${marketplace.name}`);
}

const serverArg = mcp.mcpServers?.images?.args?.[0];
if (typeof serverArg !== "string" || !serverArg.startsWith("${CLAUDE_PLUGIN_ROOT}/")) {
  fail(
    `.mcp.json images server must point under \${CLAUDE_PLUGIN_ROOT}, got ${JSON.stringify(serverArg)}`,
  );
}

if (serverArg?.includes("..")) {
  fail(`.mcp.json images server path must not escape plugin root: ${serverArg}`);
}

const normalizedRoot = path.resolve(projectRoot).replaceAll("\\", "/");
const rootVariants = new Set([
  normalizedRoot,
  normalizedRoot.toLowerCase(),
  projectRoot.replaceAll("\\", "/"),
  projectRoot.replaceAll("/", "\\"),
  path.resolve(projectRoot),
]);

let distContents = "";
try {
  distContents = await readFile(path.join(projectRoot, "dist", "server.mjs"), "utf8");
} catch {
  // already recorded as missing
}

for (const variant of rootVariants) {
  if (variant && distContents.includes(variant)) {
    fail("built server contains absolute source checkout path");
    break;
  }
}

const tracked = collectTrackedTextFiles();
for (const relativePath of tracked) {
  const absolute = path.join(projectRoot, relativePath);
  let text;
  try {
    text = await readFile(absolute, "utf8");
  } catch {
    continue;
  }
  if (API_KEY_PATTERN.test(text)) {
    fail(`tracked text contains API-key-shaped value: ${relativePath}`);
  }
  API_KEY_PATTERN.lastIndex = 0;
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`validate: ${message}`);
  }
  process.exitCode = 1;
} else {
  console.error("validate: package ok");
}
