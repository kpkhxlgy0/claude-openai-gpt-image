import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const smokePluginName = "gpt-image-2-host-smoke";
const alternateSmokePluginName = "gpt-image-2-host-smoke-alternate";

function copyCandidateIndex(targetRoot: string): void {
  const prefix = `${path.resolve(targetRoot).replaceAll("\\", "/")}/`;
  execFileSync("git", ["checkout-index", "--all", `--prefix=${prefix}`], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function copyEnvironmentValue(
  target: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = process.env[name];
  if (typeof value === "string") {
    target[name] = value;
  }
}

function isolatedClaudeEnvironment(
  configRoot: string,
  homeRoot: string,
  tempRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: configRoot,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    APPDATA: path.join(homeRoot, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeRoot, "AppData", "Local"),
    XDG_CACHE_HOME: path.join(homeRoot, ".cache"),
    XDG_CONFIG_HOME: path.join(homeRoot, ".config"),
    OPENAI_ADMIN_KEY: "host-smoke-sentinel",
    OPENAI_ORG_ID: "host-smoke-sentinel",
    OPENAI_PROJECT_ID: "host-smoke-sentinel",
    OPENAI_WEBHOOK_SECRET: "host-smoke-sentinel",
    OPENAI_CUSTOM_HEADERS: "host-smoke-sentinel",
    NO_COLOR: "1",
  };
  env[["OPENAI", "API", "KEY"].join("_")] = "host-smoke-sentinel";

  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
  ]) {
    copyEnvironmentValue(env, name);
  }
  return env;
}

async function setSmokePluginIdentity(
  pluginRoot: string,
  pluginName: string,
): Promise<void> {
  const manifestPath = path.join(
    pluginRoot,
    ".claude-plugin",
    "plugin.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = pluginName;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const marketplacePath = path.join(
    pluginRoot,
    ".claude-plugin",
    "marketplace.json",
  );
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  marketplace.plugins[0].name = pluginName;
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
}

async function prepareSmokePlugin(
  pluginRoot: string,
  workspaceRoot: string,
  configRoot: string,
): Promise<void> {
  copyCandidateIndex(pluginRoot);
  await setSmokePluginIdentity(pluginRoot, smokePluginName);

  const distRoot = path.join(pluginRoot, "dist");
  const serverPath = path.join(distRoot, "server.mjs");
  await rename(serverPath, path.join(distRoot, "actual-server.mjs"));

  const wrapper = `import { existsSync, mkdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function canonical(value) {
  try {
    const resolved = realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return "";
  }
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(\`..\${path.sep}\`) &&
    !path.isAbsolute(relative)
  );
}

function fail(code) {
  globalThis.process.exit(code);
}

const key = process.env.OPENAI_API_KEY;
if ((key ?? "") !== "") fail(70);
if (process.env.OPENAI_BASE_URL !== "https://api.openai.com/v1") fail(71);
for (const name of [
  "OPENAI_ADMIN_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_CUSTOM_HEADERS",
]) {
  if (process.env[name] !== "") fail(76);
}
if (canonical(process.env.GPT_IMAGE_WORKSPACE_ROOT ?? "") !== canonical(${JSON.stringify(workspaceRoot)})) fail(72);
const pluginData = process.env.GPT_IMAGE_PLUGIN_DATA ?? "";
const configuredConfigRoot =
  process.platform === "win32"
    ? path.resolve(${JSON.stringify(configRoot)}).toLowerCase()
    : path.resolve(${JSON.stringify(configRoot)});
const configuredDataRoot = path.join(
  configuredConfigRoot,
  "plugins",
  "data",
);
const resolvedPluginData =
  process.platform === "win32"
    ? path.resolve(pluginData).toLowerCase()
    : path.resolve(pluginData);
if (
  !path.isAbsolute(pluginData) ||
  pluginData.startsWith("\${") ||
  !isStrictDescendant(configuredDataRoot, resolvedPluginData)
) fail(73);
try {
  mkdirSync(pluginData, { recursive: true, mode: 0o700 });
} catch {
  fail(73);
}
const canonicalDataRoot = canonical(
  path.join(${JSON.stringify(configRoot)}, "plugins", "data"),
);
const canonicalPluginData = canonical(pluginData);
const relativeDataId = path.relative(
  canonicalDataRoot,
  canonicalPluginData,
);
if (
  canonicalDataRoot === "" ||
  canonicalPluginData === "" ||
  !isStrictDescendant(canonicalDataRoot, canonicalPluginData) ||
  relativeDataId.includes(path.sep)
) fail(73);
const identityMarker = path.join(
  canonicalPluginData,
  ".claude-host-identity-marker",
);
const markerMode = process.env.GPT_IMAGE_HOST_SMOKE_MARKER_MODE;
if (markerMode === "seed") {
  try {
    writeFileSync(identityMarker, "", { flag: "wx", mode: 0o600 });
  } catch {
    fail(74);
  }
} else if (markerMode === "same") {
  if (!existsSync(identityMarker)) fail(74);
} else if (markerMode === "different") {
  if (existsSync(identityMarker)) fail(74);
} else {
  fail(74);
}
const pathRecord = process.env.GPT_IMAGE_HOST_SMOKE_PATH_RECORD ?? "";
const resolvedPathRecord =
  process.platform === "win32"
    ? path.resolve(pathRecord).toLowerCase()
    : path.resolve(pathRecord);
if (
  !path.isAbsolute(pathRecord) ||
  !isStrictDescendant(configuredConfigRoot, resolvedPathRecord)
) fail(77);
try {
  writeFileSync(pathRecord, canonicalPluginData, {
    flag: "wx",
    mode: 0o600,
  });
} catch {
  fail(77);
}
const probe = path.join(
  canonicalPluginData,
  \`.claude-host-write-probe-\${process.pid}\`,
);
let probeCreated = false;
try {
  mkdirSync(probe, { recursive: false, mode: 0o700 });
  probeCreated = true;
  if (
    process.platform !== "win32" &&
    (statSync(probe).mode & 0o077) !== 0
  ) fail(75);
  rmdirSync(probe);
  probeCreated = false;
} catch {
  if (probeCreated) {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {}
  }
  fail(75);
}
await import("./actual-server.mjs");
`;
  await writeFile(serverPath, wrapper);
  execFileSync(process.execPath, ["--check", serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function reportsConnected(output: string): boolean {
  const statuses = output
    .split(/\r?\n/)
    .map((line) => /^\s*Status:\s*(.*?)\s*$/i.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  return (
    statuses.length === 1 &&
    /^(?:[√✓✔]\s*)?connected$/i.test(statuses[0] ?? "")
  );
}

test("MCP status parser accepts only an exact Connected status", () => {
  assert.equal(reportsConnected("Status: Connected\n"), true);
  assert.equal(reportsConnected("Status: √ Connected\n"), true);
  assert.equal(reportsConnected("Status: ✓ Connected\n"), true);
  assert.equal(reportsConnected("Status: ✔ Connected\n"), true);
  assert.equal(reportsConnected("Status: Disconnected\n"), false);
  assert.equal(reportsConnected("Status: Not Connected\n"), false);
});

test(
  "Claude host resolves optional plugin configuration and starts the indexed bundle",
  { timeout: 120_000 },
  async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), "gpt-image-host-smoke-"));
    const pluginRoot = path.join(testRoot, "plugin");
    const workspaceRoot = path.join(testRoot, "workspace");
    const configRoot = path.join(testRoot, "claude-config");
    const homeRoot = path.join(testRoot, "home");
    const childTempRoot = path.join(testRoot, "temp");
    const unrelatedDataRoot = path.join(testRoot, "unrelated-plugin-data");

    try {
      await Promise.all(
        [
          pluginRoot,
          workspaceRoot,
          configRoot,
          homeRoot,
          childTempRoot,
          unrelatedDataRoot,
        ].map((directory) => mkdir(directory, { recursive: true })),
      );
      await prepareSmokePlugin(
        pluginRoot,
        workspaceRoot,
        configRoot,
      );

      const mcpPath = path.join(pluginRoot, ".mcp.json");
      const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
      const pluginDataSubstitution =
        mcp.mcpServers.images.env.GPT_IMAGE_PLUGIN_DATA;
      const rejectedPathRecord = path.join(
        configRoot,
        "host-smoke-path-rejected.txt",
      );
      const seedPathRecord = path.join(
        configRoot,
        "host-smoke-path-seed.txt",
      );
      const samePathRecord = path.join(
        configRoot,
        "host-smoke-path-same.txt",
      );
      const alternatePathRecord = path.join(
        configRoot,
        "host-smoke-path-alternate.txt",
      );
      assert.equal(pluginDataSubstitution, "${CLAUDE_PLUGIN_DATA}");
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_MARKER_MODE =
        "seed";
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_PATH_RECORD =
        rejectedPathRecord;

      const command = process.platform === "win32" ? "claude.exe" : "claude";
      const args = [
        "--plugin-dir",
        pluginRoot,
        "mcp",
        "get",
        `plugin:${smokePluginName}:images`,
      ];
      const options = {
        cwd: workspaceRoot,
        env: isolatedClaudeEnvironment(
          configRoot,
          homeRoot,
          childTempRoot,
        ),
        encoding: "utf8" as const,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 90_000,
        windowsHide: true,
      };

      mcp.mcpServers.images.env.GPT_IMAGE_PLUGIN_DATA = unrelatedDataRoot;
      await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      const rejected = spawnSync(command, args, options);
      assert.equal(
        rejected.error,
        undefined,
        "Claude Code CLI could not start for the negative control",
      );
      const rejectedOutput = `${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`;
      assert.equal(
        reportsConnected(rejectedOutput),
        false,
        "Host smoke wrapper accepted an unrelated absolute plugin-data directory",
      );

      mcp.mcpServers.images.env.GPT_IMAGE_PLUGIN_DATA =
        pluginDataSubstitution;
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_PATH_RECORD =
        seedPathRecord;
      await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      const result = spawnSync(command, args, options);

      assert.equal(result.error, undefined, "Claude Code CLI could not start");
      assert.equal(result.status, 0, "Claude host MCP health check failed");
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(
        reportsConnected(output),
        true,
        "Claude host did not report the smoke plugin as connected",
      );
      assert.equal(
        /Failed to connect/i.test(output),
        false,
        "Claude host reported an MCP connection failure",
      );
      const seedPluginDataPath = await readFile(seedPathRecord, "utf8");

      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_MARKER_MODE =
        "same";
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_PATH_RECORD =
        samePathRecord;
      await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      const sameIdentityResult = spawnSync(command, args, options);
      assert.equal(
        sameIdentityResult.error,
        undefined,
        "Claude Code CLI could not restart the same smoke identity",
      );
      assert.equal(
        sameIdentityResult.status,
        0,
        "Claude host failed to reconnect the same smoke identity",
      );
      const sameIdentityOutput = `${sameIdentityResult.stdout ?? ""}\n${sameIdentityResult.stderr ?? ""}`;
      assert.equal(
        reportsConnected(sameIdentityOutput),
        true,
        "Claude host did not preserve the plugin-data directory for the same identity",
      );
      assert.equal(
        /Failed to connect/i.test(sameIdentityOutput),
        false,
        "Claude host reported an MCP connection failure for the same identity",
      );
      const samePluginDataPath = await readFile(samePathRecord, "utf8");
      assert.equal(
        samePluginDataPath,
        seedPluginDataPath,
        "Claude host changed the canonical plugin-data path for the same identity",
      );

      await setSmokePluginIdentity(
        pluginRoot,
        alternateSmokePluginName,
      );
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_MARKER_MODE =
        "different";
      mcp.mcpServers.images.env.GPT_IMAGE_HOST_SMOKE_PATH_RECORD =
        alternatePathRecord;
      await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      const alternateArgs = [
        ...args.slice(0, -1),
        `plugin:${alternateSmokePluginName}:images`,
      ];
      const alternateIdentityResult = spawnSync(
        command,
        alternateArgs,
        options,
      );
      assert.equal(
        alternateIdentityResult.error,
        undefined,
        "Claude Code CLI could not start the alternate smoke identity",
      );
      assert.equal(
        alternateIdentityResult.status,
        0,
        "Claude host failed to connect the alternate smoke identity",
      );
      const alternateIdentityOutput = `${alternateIdentityResult.stdout ?? ""}\n${alternateIdentityResult.stderr ?? ""}`;
      assert.equal(
        reportsConnected(alternateIdentityOutput),
        true,
        "Claude host did not isolate plugin data after the manifest identity changed",
      );
      assert.equal(
        /Failed to connect/i.test(alternateIdentityOutput),
        false,
        "Claude host reported an MCP connection failure for the alternate identity",
      );
      const alternatePluginDataPath = await readFile(
        alternatePathRecord,
        "utf8",
      );
      assert.notEqual(
        alternatePluginDataPath,
        seedPluginDataPath,
        "Claude host reused the canonical plugin-data path after the manifest identity changed",
      );
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);
