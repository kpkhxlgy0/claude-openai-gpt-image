import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const LOSSLESS_WEBP_BASE64 =
  "UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAEAfQ/4gCBiKi/wEA";

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function parseJsonRpcLine(line: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(line);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  const message = parsed as JsonRpcMessage;
  assert.equal(message.jsonrpc, "2.0");
  assert.ok(
    message.id !== undefined ||
      typeof message.method === "string" ||
      message.error !== undefined,
  );
  return message;
}

function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

async function copyTrackedPlugin(targetRoot: string): Promise<readonly string[]> {
  const files = trackedFiles();
  assert.ok(files.includes("dist/server.mjs"));
  assert.ok(files.includes(".mcp.json"));
  assert.equal(
    files.some((file) => /(^|\/)node_modules(?:\/|$)/i.test(file)),
    false,
  );

  const prefix = `${path.resolve(targetRoot).replaceAll("\\", "/")}/`;
  execFileSync("git", ["checkout-index", "--all", `--prefix=${prefix}`], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return files;
}

function sanitizedEnvironment(
  workspaceRoot: string,
  pluginDataRoot: string,
  homeRoot: string,
  tempRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    GPT_IMAGE_WORKSPACE_ROOT: workspaceRoot,
    GPT_IMAGE_PLUGIN_DATA: pluginDataRoot,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  for (const name of ["PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function inspectBundledWebP(
  installedRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const bundleUrl = pathToFileURL(
    path.join(installedRoot, "dist", "server.mjs"),
  ).href;
  const script = [
    `const { inspectImage } = await import(${JSON.stringify(bundleUrl)});`,
    `const bytes = Buffer.from(${JSON.stringify(LOSSLESS_WEBP_BASE64)}, "base64");`,
    "const info = await inspectImage(bytes, \"webp\");",
    "await new Promise((resolve) => process.stdout.write(JSON.stringify(info), resolve));",
    "process.exit(0);",
  ].join("\n");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: installedRoot,
      env,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );

  assert.deepEqual(JSON.parse(stdout), {
    format: "webp",
    mimeType: "image/webp",
    width: 3,
    height: 2,
    hasAlpha: true,
  });
  assert.equal(stderr.includes("OPENAI_API_KEY"), false);
  assert.equal(stderr.includes(installedRoot), false);
}

test("Git-index marketplace copy decodes WebP and serves free status without node_modules", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-installed-plugin-"),
  );
  const installedRoot = path.join(temporaryRoot, "plugin");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const pluginDataRoot = path.join(temporaryRoot, "plugin-data");
  const homeRoot = path.join(temporaryRoot, "home");
  const tempRoot = path.join(temporaryRoot, "temp");
  await Promise.all([
    mkdir(installedRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(pluginDataRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
    mkdir(tempRoot, { recursive: true }),
  ]);

  try {
    const canonicalProject = await realpath(projectRoot);
    const canonicalTemporary = await realpath(temporaryRoot);
    const temporaryRelative = path.relative(
      canonicalProject,
      canonicalTemporary,
    );
    assert.ok(
      path.isAbsolute(temporaryRelative) ||
        temporaryRelative === ".." ||
        temporaryRelative.startsWith(`..${path.sep}`),
      "installed-copy fixture must be outside the source checkout",
    );

    await copyTrackedPlugin(installedRoot);
    await assert.rejects(
      access(path.join(installedRoot, "node_modules")),
      isMissingFile,
    );

    const plugin = JSON.parse(
      await readFile(
        path.join(installedRoot, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as {
      version?: unknown;
      userConfig?: {
        openai_api_key?: { sensitive?: unknown; required?: unknown };
      };
    };
    assert.equal(plugin.version, "0.1.1");
    assert.equal(plugin.userConfig?.openai_api_key?.sensitive, true);
    assert.equal(plugin.userConfig?.openai_api_key?.required, false);

    const mcp: unknown = JSON.parse(
      await readFile(path.join(installedRoot, ".mcp.json"), "utf8"),
    );
    assert.deepEqual(mcp, {
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
    });

    const bundle = await readFile(
      path.join(installedRoot, "dist", "server.mjs"),
      "utf8",
    );
    const normalizedBundle = bundle.replace(/\\+/g, "/").toLowerCase();
    const normalizedProject = path
      .resolve(projectRoot)
      .replace(/\\+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    assert.equal(
      normalizedBundle.includes(normalizedProject),
      false,
      "installed bundle must not contain its source checkout path",
    );

    const env = sanitizedEnvironment(
      workspaceRoot,
      pluginDataRoot,
      homeRoot,
      tempRoot,
    );
    await inspectBundledWebP(installedRoot, env);

    const child = spawn(process.execPath, ["dist/server.mjs"], {
      cwd: installedRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.on("error", () => undefined);

    const stdoutLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = "";
    let sawStatusResponse = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line === "") continue;
        stdoutLines.push(line);
        try {
          const message = parseJsonRpcLine(line);
          if (message.id === 3) {
            sawStatusResponse = true;
            child.stdin.end();
          }
        } catch {
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("installed MCP server did not finish its status call"));
      }, 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "installed-plugin-test", version: "1.0.0" },
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_status", arguments: {} },
      },
    ];
    child.stdin.write(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    );

    const exited = await exit;
    const trailing = stdoutBuffer.trim();
    if (trailing !== "") stdoutLines.push(trailing);
    const messages = stdoutLines.map(parseJsonRpcLine);
    const initialize = messages.find((message) => message.id === 1);
    const tools = messages.find((message) => message.id === 2);
    const status = messages.find((message) => message.id === 3);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    assert.equal(sawStatusResponse, true, stderr);
    assert.ok(initialize?.result);
    assert.equal(initialize.error, undefined);
    assert.equal(tools?.error, undefined);
    const toolResult = tools?.result as
      | { tools?: readonly { name?: unknown }[] }
      | undefined;
    assert.deepEqual(
      toolResult?.tools?.map((tool) => tool.name).sort(),
      ["edit_image", "generate_image", "get_status"],
    );

    assert.equal(status?.error, undefined);
    const callResult = status?.result as
      | {
          isError?: unknown;
          structuredContent?: Readonly<Record<string, unknown>>;
        }
      | undefined;
    assert.equal(callResult?.isError, undefined);
    const structured = callResult?.structuredContent;
    assert.equal(structured?.model, "gpt-image-2");
    assert.equal(structured?.server_version, "0.1.1");
    assert.equal(structured?.api_key_configured, false);
    assert.equal(structured?.base_url_configured, false);
    assert.equal(structured?.base_url_valid, true);
    assert.equal(
      structured?.default_relative_output_dir,
      ".claude/generated-images/gpt-image-2",
    );
    assert.deepEqual(structured?.workspace_roots, [await realpath(workspaceRoot)]);

    assert.equal(exited.code, 0);
    assert.equal(exited.signal, null);
    assert.equal(stderr.includes("OPENAI_API_KEY"), false);
    assert.equal(stderr.includes(installedRoot), false);
    assert.equal(stderr.includes(workspaceRoot), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
