import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toErrorResult, AppError, type ErrorCode } from "../src/errors.ts";
import {
  OpenAIImageClient,
  type OpenAIImageAPIPromise,
  type OpenAIImageClientFactory,
  type OpenAIImageClientOptions,
  type OpenAIImageEditBody,
  type OpenAIImageGenerateBody,
  type OpenAIImageSDK,
  type OpenAIImagesResponse,
} from "../src/openai/openai-image-client.ts";
import type {
  ProviderEditRequest,
  ProviderGenerateRequest,
  ProviderInputSnapshot,
} from "../src/openai/types.ts";

interface FakeSDKState {
  readonly generateBodies: OpenAIImageGenerateBody[];
  readonly editBodies: OpenAIImageEditBody[];
}

interface FakeSDKBehavior {
  readonly generate?: () => OpenAIImageAPIPromise;
  readonly edit?: () => OpenAIImageAPIPromise;
}

function apiSuccess(
  data: OpenAIImagesResponse,
  requestId: string | null = "req_default",
): OpenAIImageAPIPromise {
  const response = new Response(null, {
    status: 200,
    headers: requestId === null ? {} : { "x-request-id": requestId },
  });
  return {
    asResponse: async () => response,
    withResponse: async () => ({
      data,
      response,
      request_id: requestId,
    }),
  };
}

function apiFailure(error: unknown): OpenAIImageAPIPromise {
  return {
    asResponse: async () => Promise.reject(error),
    withResponse: async () => Promise.reject(error),
  };
}

function apiParseFailure(
  requestId: string,
  error: unknown = new SyntaxError("malformed JSON"),
): OpenAIImageAPIPromise {
  const response = new Response("{", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
  return {
    asResponse: async () => response,
    withResponse: async () => Promise.reject(error),
  };
}

function createFakeSDK(behavior: FakeSDKBehavior = {}): {
  sdk: OpenAIImageSDK;
  state: FakeSDKState;
} {
  const generateBodies: OpenAIImageGenerateBody[] = [];
  const editBodies: OpenAIImageEditBody[] = [];
  const success = () =>
    apiSuccess({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] });

  return {
    state: { generateBodies, editBodies },
    sdk: {
      images: {
        generate(body) {
          generateBodies.push(body);
          return (behavior.generate ?? success)();
        },
        edit(body) {
          editBodies.push(body);
          return (behavior.edit ?? success)();
        },
      },
    },
  };
}

function createClient(
  behavior: FakeSDKBehavior = {},
  config: Partial<Pick<OpenAIImageClientOptions, "apiKey" | "baseURL">> = {},
): {
  client: OpenAIImageClient;
  state: FakeSDKState;
  constructedOptions: OpenAIImageClientOptions[];
} {
  const { sdk, state } = createFakeSDK(behavior);
  const constructedOptions: OpenAIImageClientOptions[] = [];
  const createSDKClient: OpenAIImageClientFactory = (options) => {
    constructedOptions.push(options);
    return sdk;
  };
  const client = new OpenAIImageClient(
    {
      apiKey: config.apiKey ?? "test-key-constructor-secret",
      baseURL: config.baseURL ?? "https://provider.example.test/v1",
    },
    { createSDKClient },
  );
  return { client, state, constructedOptions };
}

const generateRequest: ProviderGenerateRequest = Object.freeze({
  prompt: "draw a lighthouse",
  quality: "high",
  size: "1536x1024",
  output_format: "jpeg",
  output_compression: 37,
  moderation: "low",
});

function providerError(
  fields: Readonly<Record<string, unknown>>,
  message = "provider request failed",
): Error & Record<string, unknown> {
  return Object.assign(new Error(message), fields);
}

function hasAppErrorCode(code: ErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

async function withSnapshotFixture(
  fn: (fixture: {
    first: ProviderInputSnapshot;
    second: ProviderInputSnapshot;
    mask: ProviderInputSnapshot;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-client-test-"));
  const firstPath = path.join(directory, "0.snapshot");
  const secondPath = path.join(directory, "1.snapshot");
  const maskPath = path.join(directory, "mask.snapshot");
  const firstBytes = Buffer.from("first-image-bytes");
  const secondBytes = Buffer.from("second-image-bytes");
  const maskBytes = Buffer.from("mask_fixture_bin");
  await Promise.all([
    writeFile(firstPath, firstBytes),
    writeFile(secondPath, secondBytes),
    writeFile(maskPath, maskBytes),
  ]);

  try {
    await fn({
      first: Object.freeze({
        snapshotPath: firstPath,
        filename: "first.jpeg",
        sizeBytes: firstBytes.length,
        info: Object.freeze({ mimeType: "image/jpeg" }),
      }),
      second: Object.freeze({
        snapshotPath: secondPath,
        filename: "second.webp",
        sizeBytes: secondBytes.length,
        info: Object.freeze({ mimeType: "image/webp" }),
      }),
      mask: Object.freeze({
        snapshotPath: maskPath,
        filename: "mask.png",
        sizeBytes: maskBytes.length,
        info: Object.freeze({ mimeType: "image/png" }),
      }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function uploadMetadata(upload: unknown): { name: string; size: number } {
  assert.equal(typeof upload, "object");
  assert.notEqual(upload, null);
  const metadata = upload as { name?: unknown; size?: unknown };
  assert.equal(typeof metadata.name, "string");
  assert.equal(typeof metadata.size, "number");
  return metadata as { name: string; size: number };
}

test("constructs one SDK client with validated no-retry and disabled-logging options", () => {
  const { constructedOptions } = createClient(
    {},
    {
      apiKey: "test-key-exact-key",
      baseURL: "https://provider.example.test/v1///",
    },
  );

  assert.equal(constructedOptions.length, 1);
  const options = constructedOptions[0]!;
  assert.equal(options.apiKey, "test-key-exact-key");
  assert.equal(options.baseURL, "https://provider.example.test/v1");
  assert.equal(options.maxRetries, 0);
  assert.equal(options.logLevel, "off");
  assert.deepEqual(options.fetchOptions, { redirect: "error" });
  assert.equal(typeof options.logger.error, "function");
  assert.equal(typeof options.logger.warn, "function");
  assert.equal(typeof options.logger.info, "function");
  assert.equal(typeof options.logger.debug, "function");
});

test("generate maps validated fields and extracts one Base64 image, usage, and request ID", async () => {
  const usage: NonNullable<OpenAIImagesResponse["usage"]> = Object.freeze({
    input_tokens: 11,
    input_tokens_details: Object.freeze({ image_tokens: 4, text_tokens: 7 }),
    output_tokens: 22,
    total_tokens: 33,
  });
  const { client, state } = createClient({
    generate: () =>
      apiSuccess(
        {
          created: 1,
          data: [{ b64_json: "Z2VuZXJhdGVkLWltYWdl" }],
          usage,
        },
        "req_generate-123.safe",
      ),
  });

  const result = await client.generate(generateRequest);

  assert.deepEqual(state.generateBodies, [
    {
      model: "gpt-image-2",
      n: 1,
      prompt: "draw a lighthouse",
      quality: "high",
      size: "1536x1024",
      output_format: "jpeg",
      output_compression: 37,
      moderation: "low",
    },
  ]);
  assert.deepEqual(result, {
    base64: "Z2VuZXJhdGVkLWltYWdl",
    requestId: "req_generate-123.safe",
    usage,
  });
});

test("copies only known numeric usage fields from an untrusted provider response", async () => {
  const providerOnlyValue = "provider-private-echo";
  const response = {
    created: 1,
    data: [{ b64_json: "c2FmZS1pbWFnZQ==" }],
    usage: {
      input_tokens: 11,
      input_tokens_details: {
        image_tokens: 4,
        text_tokens: 7,
        provider_only_value: providerOnlyValue,
      },
      output_tokens: 22,
      total_tokens: 33,
      output_tokens_details: {
        image_tokens: 20,
        text_tokens: 2,
        provider_only_value: providerOnlyValue,
      },
      provider_only_value: providerOnlyValue,
    },
  } as unknown as OpenAIImagesResponse;
  const { client } = createClient({
    generate: () => apiSuccess(response),
  });

  const result = await client.generate(generateRequest);

  assert.deepEqual(result.usage, {
    input_tokens: 11,
    input_tokens_details: { image_tokens: 4, text_tokens: 7 },
    output_tokens: 22,
    total_tokens: 33,
    output_tokens_details: { image_tokens: 20, text_tokens: 2 },
  });
  assert.equal(JSON.stringify(result).includes(providerOnlyValue), false);

  const malformed = {
    created: 1,
    data: [{ b64_json: "c2FmZS1pbWFnZQ==" }],
    usage: { input_tokens: providerOnlyValue },
  } as unknown as OpenAIImagesResponse;
  const { client: malformedClient } = createClient({
    generate: () => apiSuccess(malformed),
  });
  const malformedResult = await malformedClient.generate(generateRequest);
  assert.equal("usage" in malformedResult, false);
});

test("generate omits PNG compression even when a normalized zero reaches the provider boundary", async () => {
  const { client, state } = createClient();

  await client.generate({
    ...generateRequest,
    output_format: "png",
    output_compression: 0,
  });

  assert.equal("output_compression" in state.generateBodies[0]!, false);
});

test("edit uploads immutable snapshots in order, includes the optional mask, and maps fields", async () => {
  await withSnapshotFixture(async ({ first, second, mask }) => {
    const { client, state } = createClient({
      edit: () =>
        apiSuccess(
          { created: 1, data: [{ b64_json: "ZWRpdGVkLWltYWdl" }] },
          "req_edit_456",
        ),
    });
    const request: ProviderEditRequest = Object.freeze({
      prompt: "combine the references",
      quality: "medium",
      size: "1024x1536",
      output_format: "webp",
      output_compression: 62,
      images: Object.freeze([first, second]),
      mask,
    });

    const result = await client.edit(request);

    assert.equal(state.editBodies.length, 1);
    const body = state.editBodies[0]!;
    assert.equal(body.model, "gpt-image-2");
    assert.equal(body.n, 1);
    assert.equal(body.prompt, "combine the references");
    assert.equal(body.quality, "medium");
    assert.equal(body.size, "1024x1536");
    assert.equal(body.output_format, "webp");
    assert.equal(body.output_compression, 62);
    assert.ok(Array.isArray(body.image));
    assert.deepEqual(
      body.image.map((upload) => uploadMetadata(upload).name),
      ["first.jpeg", "second.webp"],
    );
    assert.deepEqual(
      body.image.map((upload) => uploadMetadata(upload).size),
      [17, 18],
    );
    assert.equal(uploadMetadata(body.mask).name, "mask.png");
    assert.equal(uploadMetadata(body.mask).size, 16);
    assert.deepEqual(result, {
      base64: "ZWRpdGVkLWltYWdl",
      requestId: "req_edit_456",
    });
  });
});

test("edit omits an absent mask and PNG compression", async () => {
  await withSnapshotFixture(async ({ first }) => {
    const { client, state } = createClient();

    await client.edit({
      prompt: "edit one image",
      quality: "auto",
      size: "auto",
      output_format: "png",
      output_compression: 0,
      images: Object.freeze([first]),
    });

    const body = state.editBodies[0]!;
    assert.equal("mask" in body, false);
    assert.equal("output_compression" in body, false);
    assert.deepEqual(
      (body.image as unknown[]).map((upload) => uploadMetadata(upload).name),
      ["first.jpeg"],
    );
  });
});

test("edit rejects a non-PNG or 4 MiB mask before an SDK call", async () => {
  await withSnapshotFixture(async ({ first, second, mask }) => {
    for (const invalidMask of [
      Object.freeze({
        ...second,
        filename: "mask.jpeg",
      }),
      Object.freeze({
        ...mask,
        sizeBytes: 4 * 1024 * 1024,
      }),
    ]) {
      const { client, state } = createClient();
      await assert.rejects(
        () =>
          client.edit({
            prompt: "edit with invalid mask",
            quality: "auto",
            size: "1024x1024",
            output_format: "png",
            images: Object.freeze([first]),
            mask: invalidMask,
          }),
        hasAppErrorCode("INVALID_INPUT"),
      );
      assert.equal(state.editBodies.length, 0);
    }
  });
});

test("retains only short safe request IDs", async () => {
  const unsafeIds = [
    "https://private-provider.example/v1/request",
    "request id with spaces",
    `req_${"x".repeat(200)}`,
  ];

  for (const requestId of unsafeIds) {
    const { client } = createClient({
      generate: () =>
        apiSuccess(
          { created: 1, data: [{ b64_json: "c2FmZS1pbWFnZQ==" }] },
          requestId,
        ),
    });
    const result = await client.generate(generateRequest);
    assert.equal(result.requestId, undefined);
    assert.equal("requestId" in result, false);
  }
});

test("rejects every malformed provider image response", async () => {
  const malformed: OpenAIImagesResponse[] = [
    { created: 1 },
    { created: 1, data: [] },
    { created: 1, data: [{ b64_json: "one" }, { b64_json: "two" }] },
    { created: 1, data: [{}] },
    { created: 1, data: [{ b64_json: "" }] },
    { created: 1, data: [{ b64_json: "   " }] },
  ];

  for (const response of malformed) {
    const { client, state } = createClient({
      generate: () => apiSuccess(response, "req_malformed"),
    });
    await assert.rejects(
      () => client.generate(generateRequest),
      hasAppErrorCode("INVALID_PROVIDER_RESPONSE"),
    );
    assert.equal(state.generateBodies.length, 1);
  }
});

test("maps a successful HTTP response that fails parsing to invalid provider response", async () => {
  const { client, state } = createClient({
    generate: () => apiParseFailure("req_parse_failure-1"),
  });

  let caught: unknown;
  try {
    await client.generate(generateRequest);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AppError);
  assert.equal(caught.code, "INVALID_PROVIDER_RESPONSE");
  assert.match(caught.message, /req_parse_failure-1/);
  assert.equal(state.generateBodies.length, 1);
});

test("maps provider failures to stable errors without retrying", async () => {
  const cases: ReadonlyArray<{
    label: string;
    error: unknown;
    code: ErrorCode;
  }> = [
    {
      label: "401",
      error: providerError({ status: 401, code: "invalid_api_key" }),
      code: "AUTHENTICATION_FAILED",
    },
    {
      label: "403",
      error: providerError({ status: 403, code: "permission_denied" }),
      code: "AUTHENTICATION_FAILED",
    },
    {
      label: "403 content policy",
      error: providerError({ status: 403, code: "content_policy_violation" }),
      code: "MODERATION_BLOCKED",
    },
    {
      label: "content policy",
      error: providerError({ status: 400, code: "content_policy_violation" }),
      code: "MODERATION_BLOCKED",
    },
    {
      label: "nested moderation code",
      error: providerError({
        status: 400,
        error: { code: "moderation_blocked" },
      }),
      code: "MODERATION_BLOCKED",
    },
    {
      label: "429",
      error: providerError({ status: 429, code: "rate_limit_exceeded" }),
      code: "RATE_LIMITED",
    },
    {
      label: "ordinary 4xx",
      error: providerError({ status: 422, code: "invalid_request_error" }),
      code: "PROVIDER_FAILURE",
    },
    {
      label: "5xx",
      error: providerError({ status: 503, code: "server_error" }),
      code: "PROVIDER_FAILURE",
    },
    {
      label: "network",
      error: new Error("socket disconnected after upload"),
      code: "PROVIDER_FAILURE",
    },
    {
      label: "unknown",
      error: Object.freeze({ failure: "unrecognized provider rejection" }),
      code: "PROVIDER_FAILURE",
    },
  ];

  for (const fixture of cases) {
    const { client, state } = createClient({
      generate: () => apiFailure(fixture.error),
    });
    await assert.rejects(
      () => client.generate(generateRequest),
      hasAppErrorCode(fixture.code),
      fixture.label,
    );
    assert.equal(state.generateBodies.length, 1, fixture.label);
  }
});

test("sanitizes provider failures while retaining only a safe request ID", async () => {
  const prompt = "draw the unreleased secret product";
  const baseURL = "https://private-provider.example/v1";
  const inputPath = "C:\\private\\customer\\input.png";
  const apiKey = "test-key-do-not-expose";
  const authorization = `Bearer ${apiKey}`;
  const responseBody = "raw-provider-response-body";
  const causeDetails = "private socket cause details";
  const upstream = providerError(
    {
      status: 500,
      code: "server_error",
      requestID: "req_safe_sanitized-1",
      baseURL,
      inputPath,
      authorization,
      apiKey,
      response: { body: responseBody },
      cause: new Error(causeDetails),
    },
    `${prompt} ${baseURL} ${inputPath} ${authorization} ${responseBody}`,
  );
  upstream.stack = `Error: ${causeDetails}\n at ${inputPath}`;
  const { client, state } = createClient(
    { generate: () => apiFailure(upstream) },
    { apiKey, baseURL },
  );

  let caught: unknown;
  try {
    await client.generate({ ...generateRequest, prompt });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AppError);
  assert.equal(caught.code, "PROVIDER_FAILURE");
  assert.equal(caught.cause, undefined);
  assert.match(caught.message, /req_safe_sanitized-1/);
  const serialized = JSON.stringify(toErrorResult(caught));
  for (const forbidden of [
    prompt,
    baseURL,
    "private-provider.example",
    inputPath,
    apiKey,
    authorization,
    responseBody,
    causeDetails,
    "cause",
    "stack",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(state.generateBodies.length, 1);
});

test("bounded snapshot reads reject descriptor/file size changes before an SDK call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-client-size-test-"));
  const snapshotPath = path.join(directory, "changed.snapshot");
  await writeFile(snapshotPath, Buffer.from("larger-than-declared"));
  try {
    const { client, state } = createClient();
    const snapshot: ProviderInputSnapshot = Object.freeze({
      snapshotPath,
      filename: "changed.png",
      sizeBytes: 4,
      info: Object.freeze({ mimeType: "image/png" }),
    });

    await assert.rejects(
      () =>
        client.edit({
          prompt: "edit changed snapshot",
          quality: "auto",
          size: "1024x1024",
          output_format: "png",
          images: Object.freeze([snapshot]),
        }),
      hasAppErrorCode("INVALID_INPUT"),
    );
    assert.equal(state.editBodies.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
