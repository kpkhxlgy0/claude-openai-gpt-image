import assert from "node:assert/strict";
import test from "node:test";
import { AppError, toErrorResult } from "../src/errors.ts";
import { validateOpenAIBaseUrl } from "../src/config/base-url.ts";
import { loadEnvironment } from "../src/config/environment.ts";

test("validateOpenAIBaseUrl defaults and normalizes trailing slashes", () => {
  assert.equal(validateOpenAIBaseUrl(undefined), "https://api.openai.com/v1");
  assert.equal(validateOpenAIBaseUrl(""), "https://api.openai.com/v1");
  assert.equal(
    validateOpenAIBaseUrl("https://example.test/v1///"),
    "https://example.test/v1",
  );
  assert.equal(
    validateOpenAIBaseUrl("http://127.0.0.1:8080/v1/"),
    "http://127.0.0.1:8080/v1",
  );
  assert.equal(
    validateOpenAIBaseUrl("https://example.test"),
    "https://example.test",
  );
});

test("validateOpenAIBaseUrl rejects whitespace, credentials, query, fragment, and bad schemes", () => {
  assert.throws(
    () => validateOpenAIBaseUrl(" https://example.test/v1"),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "CONFIG_INVALID" &&
      /CONFIG_INVALID/.test(error.message),
  );
  assert.throws(
    () => validateOpenAIBaseUrl("https://example.test/v1 "),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("https://user:pass@example.test/v1"),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("https://example.test/v1?q=1"),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("https://example.test/v1#frag"),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("ftp://example.test/v1"),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("https://example.test/v1\n"),
    /CONFIG_INVALID/,
  );
  assert.throws(
    () => validateOpenAIBaseUrl("not-a-url"),
    /CONFIG_INVALID/,
  );
});

test("loadEnvironment reports key presence without mutating the raw key", () => {
  const config = loadEnvironment({
    OPENAI_API_KEY: "test-key-raw",
    OPENAI_BASE_URL: "https://example.test/v1///",
    GPT_IMAGE_WORKSPACE_ROOT: "D:\\project",
    GPT_IMAGE_PLUGIN_DATA: "D:\\plugin-data",
  });

  assert.equal(config.apiKeyConfigured, true);
  assert.equal(config.apiKey, "test-key-raw");
  assert.equal(config.baseUrl, "https://example.test/v1");
  assert.equal(config.baseUrlConfigured, true);
  assert.equal(config.workspaceRoot, "D:\\project");
  assert.equal(config.pluginDataRoot, "D:\\plugin-data");
});

test("loadEnvironment treats whitespace-only keys as missing and keeps raw non-empty keys", () => {
  const missing = loadEnvironment({
    OPENAI_API_KEY: "   ",
  });
  assert.equal(missing.apiKeyConfigured, false);
  assert.equal(missing.apiKey, undefined);
  assert.equal(missing.baseUrl, "https://api.openai.com/v1");
  assert.equal(missing.baseUrlConfigured, false);

  const withSpaces = loadEnvironment({
    OPENAI_API_KEY: "  test-key-with-spaces  ",
  });
  assert.equal(withSpaces.apiKeyConfigured, true);
  assert.equal(withSpaces.apiKey, "  test-key-with-spaces  ");
});

test("loadEnvironment treats the official manifest Base URL as not custom", () => {
  const config = loadEnvironment({
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  });

  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.baseUrlConfigured, false);
});

test("loadEnvironment rejects invalid configured Base URLs", () => {
  for (const value of [
    " https://example.test/v1",
    "   ",
    "\t",
  ]) {
    assert.throws(
      () =>
        loadEnvironment({
          OPENAI_BASE_URL: value,
        }),
      /CONFIG_INVALID/,
    );
  }
});

test("toErrorResult preserves AppError codes and sanitizes unknown failures", () => {
  const app = toErrorResult(
    new AppError("CONFIG_MISSING", "API key is not configured"),
  );
  assert.equal(app.isError, true);
  assert.equal(app.code, "CONFIG_MISSING");
  assert.match(app.message, /API key is not configured/);
  assert.equal("cause" in app, false);
  assert.equal("stack" in app, false);

  const secret = {
    message: "upstream failed",
    stack: "Error: secret stack",
    cause: { authorization: "Bearer test-secret", body: { prompt: "hidden" } },
    response: { data: { error: "raw" } },
    env: { OPENAI_API_KEY: "test-secret" },
  };
  const internal = toErrorResult(secret);
  assert.equal(internal.isError, true);
  assert.equal(internal.code, "INTERNAL_ERROR");
  const serialized = JSON.stringify(internal);
  assert.equal(serialized.includes("test-secret"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(serialized.includes("secret stack"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
});
