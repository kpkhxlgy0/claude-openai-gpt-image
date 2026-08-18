import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

function sanitizedEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    GPT_IMAGE_WORKSPACE_ROOT: workspaceRoot,
    GPT_IMAGE_PLUGIN_DATA: path.join(workspaceRoot, ".plugin-data"),
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

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

test("built stdio server emits JSON-RPC only and exits when stdin closes", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-server-process-"),
  );
  const env = sanitizedEnvironment(workspaceRoot);
  try {
    const builtServer = await readFile(
      path.join(projectRoot, "dist", "server.mjs"),
      "utf8",
    );
    assert.doesNotMatch(builtServer, /^[\t ]+$/m);

    const child = spawn(process.execPath, ["dist/server.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.on("error", () => undefined);

    const stdoutLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = "";
    let sawToolsResponse = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line === "") {
          continue;
        }
        stdoutLines.push(line);
        try {
          const message = parseJsonRpcLine(line);
          if (message.id === 2) {
            sawToolsResponse = true;
            child.stdin.end();
          }
        } catch {
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("built MCP server did not exit after stdin closed"));
        }, 10_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "server-process-test", version: "1.0.0" },
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
    ];
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);

    const exited = await exit;
    const trailing = stdoutBuffer.trim();
    if (trailing !== "") {
      stdoutLines.push(trailing);
    }
    const messages = stdoutLines.map(parseJsonRpcLine);
    const initialize = messages.find((message) => message.id === 1);
    const tools = messages.find((message) => message.id === 2);

    assert.equal(sawToolsResponse, true, Buffer.concat(stderrChunks).toString("utf8"));
    assert.ok(initialize);
    assert.equal(initialize.error, undefined);
    assert.ok(initialize.result);
    assert.ok(tools);
    assert.equal(tools.error, undefined);
    const toolResult = tools.result as { tools?: readonly { name?: unknown }[] };
    assert.deepEqual(
      toolResult.tools?.map((tool) => tool.name).sort(),
      ["edit_image", "generate_image", "get_status"],
    );
    assert.equal(exited.code, 0);
    assert.equal(exited.signal, null);
    assert.ok(stdoutLines.length >= 2);

    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    assert.equal(stderr.includes("OPENAI_API_KEY"), false);
    assert.equal(stderr.includes(workspaceRoot), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("fatal transport errors retain a nonzero exit when stdin also closes", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-server-error-"),
  );
  const env = sanitizedEnvironment(workspaceRoot);
  try {
    const builtServer = await readFile(
      path.join(projectRoot, "dist", "server.mjs"),
      "utf8",
    );
    assert.doesNotMatch(builtServer, /^[\t ]+$/m);

    const child = spawn(process.execPath, ["dist/server.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.on("error", () => undefined);
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("built MCP server did not exit after a transport error"));
        }, 10_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );

    child.stdin.end("{not-json}\n");
    const exited = await exit;
    assert.equal(exited.code, 1, Buffer.concat(stderrChunks).toString("utf8"));
    assert.equal(exited.signal, null);

    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    assert.equal(stderr.includes("OPENAI_API_KEY"), false);
    assert.equal(stderr.includes(workspaceRoot), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
