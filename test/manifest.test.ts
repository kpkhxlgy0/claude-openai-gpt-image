import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("API key is sensitive and MCP uses plugin substitutions", async () => {
  const plugin = await json(".claude-plugin/plugin.json");
  const mcp = await json(".mcp.json");
  assert.equal(plugin.userConfig.openai_api_key.sensitive, true);
  assert.equal(mcp.mcpServers.images.args[0], "${CLAUDE_PLUGIN_ROOT}/dist/server.mjs");
  assert.equal(mcp.mcpServers.images.env.OPENAI_API_KEY, "${user_config.openai_api_key}");
  assert.equal(mcp.mcpServers.images.env.GPT_IMAGE_WORKSPACE_ROOT, "${CLAUDE_PROJECT_DIR}");
});

test("plugin identity and approved userConfig fields", async () => {
  const plugin = await json(".claude-plugin/plugin.json");
  assert.equal(plugin.name, "gpt-image-2");
  assert.equal(plugin.version, "0.1.1");
  assert.equal(plugin.author.name, "KPK");
  assert.deepEqual(Object.keys(plugin.userConfig).sort(), [
    "openai_api_key",
    "openai_base_url",
  ]);
  assert.equal(plugin.userConfig.openai_api_key.required, false);
  assert.equal(plugin.userConfig.openai_api_key.sensitive, true);
  assert.equal(plugin.userConfig.openai_api_key.type, "string");
  assert.equal(plugin.userConfig.openai_base_url.required, false);
  assert.equal(plugin.userConfig.openai_base_url.type, "string");
  assert.equal(
    plugin.userConfig.openai_base_url.default,
    "https://api.openai.com/v1",
  );
});

test("MCP env wires Base URL and plugin data substitutions while clearing ambient SDK settings", async () => {
  const mcp = await json(".mcp.json");
  assert.equal(mcp.mcpServers.images.command, "node");
  assert.equal(
    mcp.mcpServers.images.env.OPENAI_BASE_URL,
    "${user_config.openai_base_url}",
  );
  assert.equal(
    mcp.mcpServers.images.env.GPT_IMAGE_PLUGIN_DATA,
    "${CLAUDE_PLUGIN_DATA}",
  );
  for (const name of [
    "OPENAI_ADMIN_KEY",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_WEBHOOK_SECRET",
    "OPENAI_CUSTOM_HEADERS",
  ]) {
    assert.equal(mcp.mcpServers.images.env[name], "", name);
  }
});
