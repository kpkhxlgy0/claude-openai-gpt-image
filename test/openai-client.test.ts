import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Images } from "openai/resources/images";
import { toErrorResult, AppError, type ErrorCode } from "../src/errors.ts";
import { MAX_INPUT_BYTES } from "../src/files/input-snapshot.ts";
import {
  OpenAIImageClient,
  type OpenAIImageAPIPromise,
  type OpenAIImageClientFactory,
  type OpenAIImageClientOptions,
  type OpenAIImageEditBody,
  type OpenAIImageGenerateBody,
  type OpenAIImageRequestOptions,
  type OpenAIImageSDK,
  type OpenAIImagesResponse,
} from "../src/openai/openai-image-client.ts";
import type {
  ProviderEditRequest,
  ProviderGenerateRequest,
  ProviderInputSnapshot,
} from "../src/openai/types.ts";
import { editImageSchema, generateImageSchema } from "../src/schemas.ts";

interface FakeSDKState {
  readonly generateBodies: OpenAIImageGenerateBody[];
  readonly editBodies: OpenAIImageEditBody[];
  readonly generateSignals: (AbortSignal | undefined)[];
  readonly editSignals: (AbortSignal | undefined)[];
  readonly generateArgumentCounts: number[];
  readonly editArgumentCounts: number[];
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
  const generateSignals: (AbortSignal | undefined)[] = [];
  const editSignals: (AbortSignal | undefined)[] = [];
  const generateArgumentCounts: number[] = [];
  const editArgumentCounts: number[] = [];
  const success = () =>
    apiSuccess({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] });

  return {
    state: {
      generateBodies,
      editBodies,
      generateSignals,
      editSignals,
      generateArgumentCounts,
      editArgumentCounts,
    },
    sdk: {
      images: {
        generate(...args) {
          const [body, options] = args;
          generateArgumentCounts.push(args.length);
          generateBodies.push(body);
          generateSignals.push(options?.signal);
          return (behavior.generate ?? success)();
        },
        edit(...args) {
          const [body, options] = args;
          editArgumentCounts.push(args.length);
          editBodies.push(body);
          editSignals.push(options?.signal);
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
  model: "gpt-image-2",
  prompt: "draw a lighthouse",
  quality: "high",
  size: "1536x1024",
  output_format: "jpeg",
  output_compression: 37,
  background: "auto",
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

const MARKUP_FIXTURE_TEXT = "markup-layer-bytes";

async function withSnapshotFixture(
  fn: (fixture: {
    first: ProviderInputSnapshot;
    second: ProviderInputSnapshot;
    mask: ProviderInputSnapshot;
    markup: ProviderInputSnapshot;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-client-test-"));
  const firstPath = path.join(directory, "0.snapshot");
  const secondPath = path.join(directory, "1.snapshot");
  const maskPath = path.join(directory, "mask.snapshot");
  const markupPath = path.join(directory, "markup.snapshot");
  const firstBytes = Buffer.from("first-image-bytes");
  const secondBytes = Buffer.from("second-image-bytes");
  const maskBytes = Buffer.from("mask_fixture_bin");
  const markupBytes = Buffer.from(MARKUP_FIXTURE_TEXT);
  await Promise.all([
    writeFile(firstPath, firstBytes),
    writeFile(secondPath, secondBytes),
    writeFile(maskPath, maskBytes),
    writeFile(markupPath, markupBytes),
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
      markup: Object.freeze({
        snapshotPath: markupPath,
        filename: "markup.png",
        sizeBytes: markupBytes.length,
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
  assert.equal(options.adminAPIKey, null);
  assert.equal(options.organization, null);
  assert.equal(options.project, null);
  assert.equal(options.webhookSecret, null);
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
  assert.equal("background" in state.generateBodies[0]!, false);
  assert.deepEqual(result, {
    base64: "Z2VuZXJhdGVkLWltYWdl",
    requestId: "req_generate-123.safe",
    usage,
  });
});

test("generate and edit pass the selected model and send only a non-auto background", async () => {
  const { client, state } = createClient();

  await client.generate({
    ...generateRequest,
    model: "gpt-image-2.5-sunburst",
    output_format: "png",
    background: "transparent",
  });
  await client.generate({
    ...generateRequest,
    model: "gpt-image-2.5-flare",
    background: "opaque",
  });
  await client.generate({ ...generateRequest, background: "opaque" });
  await withSnapshotFixture(async ({ first }) => {
    const editRequest: ProviderEditRequest = {
      model: "gpt-image-2.5-flare",
      prompt: "edit with a selected model",
      quality: "auto",
      size: "1024x1024",
      output_format: "webp",
      background: "transparent",
      images: Object.freeze([first]),
    };
    await client.edit(editRequest);
    await client.edit({
      ...editRequest,
      model: "gpt-image-2.5-sunburst",
      background: "opaque",
    });
    await client.edit({
      ...editRequest,
      model: "gpt-image-2",
      background: "auto",
    });
  });

  assert.deepEqual(
    state.generateBodies.map((body) => [body.model, body.background]),
    [
      ["gpt-image-2.5-sunburst", "transparent"],
      ["gpt-image-2.5-flare", "opaque"],
      ["gpt-image-2", "opaque"],
    ],
  );
  assert.deepEqual(
    state.editBodies.map((body) => [body.model, body.background]),
    [
      ["gpt-image-2.5-flare", "transparent"],
      ["gpt-image-2.5-sunburst", "opaque"],
      ["gpt-image-2", undefined],
    ],
  );
  assert.equal("background" in state.editBodies[2]!, false);
  assert.equal("input_fidelity" in state.generateBodies[0]!, false);
  assert.equal("input_fidelity" in state.editBodies[0]!, false);
});

test("schema defaults reach the provider body as flare at high quality without a background", async () => {
  const { client, state } = createClient();

  await client.generate(generateImageSchema.parse({ prompt: "default request" }));
  await withSnapshotFixture(async ({ first }) => {
    await client.edit({
      ...editImageSchema.parse({
        prompt: "default edit",
        image_paths: ["first.jpeg"],
      }),
      images: Object.freeze([first]),
    });
  });

  assert.deepEqual(state.generateBodies, [
    {
      model: "gpt-image-2.6-flare",
      n: 1,
      prompt: "default request",
      quality: "high",
      size: "1024x1024",
      output_format: "png",
      moderation: "auto",
    },
  ]);
  assert.equal("background" in state.generateBodies[0]!, false);
  assert.equal("complexity" in state.generateBodies[0]!, false);
  assert.equal(state.editBodies.length, 1);
  const editBody = state.editBodies[0]!;
  assert.equal(editBody.model, "gpt-image-2.6-flare");
  assert.equal(editBody.quality, "high");
  assert.equal(editBody.size, "1024x1024");
  assert.equal(editBody.output_format, "png");
  assert.equal("background" in editBody, false);
  assert.equal("moderation" in editBody, false);
  assert.equal("complexity" in editBody, false);
});

test("generate and edit bodies contain complexity only when the request has it", async () => {
  const { client, state } = createClient();

  await client.generate({
    ...generateRequest,
    model: "gpt-image-2.6-sunburst",
    complexity: "low",
  });
  await client.generate({ ...generateRequest, model: "gpt-image-2.6-flare" });
  await client.generate(
    generateImageSchema.parse({
      prompt: "parsed complexity",
      complexity: "medium",
    }),
  );
  await withSnapshotFixture(async ({ first }) => {
    const editRequest: ProviderEditRequest = {
      model: "gpt-image-2.6-flare",
      prompt: "edit with complexity",
      quality: "high",
      size: "1024x1024",
      output_format: "png",
      background: "auto",
      complexity: "high",
      images: Object.freeze([first]),
    };
    await client.edit(editRequest);
    const { complexity: _complexity, ...withoutComplexity } = editRequest;
    await client.edit({ ...withoutComplexity, model: "gpt-image-2.6-sunburst" });
  });

  assert.deepEqual(
    state.generateBodies.map((body) => [body.model, body.complexity]),
    [
      ["gpt-image-2.6-sunburst", "low"],
      ["gpt-image-2.6-flare", undefined],
      ["gpt-image-2.6-flare", "medium"],
    ],
  );
  assert.equal("complexity" in state.generateBodies[1]!, false);
  assert.deepEqual(
    state.editBodies.map((body) => [body.model, body.complexity]),
    [
      ["gpt-image-2.6-flare", "high"],
      ["gpt-image-2.6-sunburst", undefined],
    ],
  );
  assert.equal("complexity" in state.editBodies[1]!, false);
});

test("xhigh and max quality pass through to generate and edit bodies on GPT Image 2.5 models", async () => {
  const { client, state } = createClient();
  const cases = [
    ["gpt-image-2.5-sunburst", "xhigh"],
    ["gpt-image-2.5-sunburst", "max"],
    ["gpt-image-2.5-flare", "xhigh"],
    ["gpt-image-2.5-flare", "max"],
  ] as const;

  for (const [model, quality] of cases) {
    await client.generate({ ...generateRequest, model, quality });
  }
  await withSnapshotFixture(async ({ first }) => {
    for (const [model, quality] of cases) {
      await client.edit({
        model,
        prompt: "edit at an extended quality",
        quality,
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
      });
    }
  });

  assert.deepEqual(
    state.generateBodies.map((body) => [body.model, body.quality]),
    cases.map(([model, quality]) => [model, quality]),
  );
  assert.deepEqual(
    state.editBodies.map((body) => [body.model, body.quality]),
    cases.map(([model, quality]) => [model, quality]),
  );
});

test("omits the SDK request-options argument when no signal is present", async () => {
  const { client, state } = createClient();

  await client.generate(generateRequest);
  await withSnapshotFixture(async ({ first }) => {
    await client.edit({
      model: "gpt-image-2",
      prompt: "edit one image",
      quality: "auto",
      size: "1024x1024",
      output_format: "png",
      background: "auto",
      images: Object.freeze([first]),
    });
  });

  assert.deepEqual(state.generateArgumentCounts, [1]);
  assert.deepEqual(state.editArgumentCounts, [1]);
  assert.deepEqual(state.generateSignals, [undefined]);
  assert.deepEqual(state.editSignals, [undefined]);
});

test("passes the caller AbortSignal to generate and edit SDK requests", async () => {
  const controller = new AbortController();
  const { client, state } = createClient();

  await client.generate(generateRequest, controller.signal);
  await withSnapshotFixture(async ({ first }) => {
    await client.edit(
      {
        model: "gpt-image-2",
        prompt: "edit one image",
        quality: "auto",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
      },
      controller.signal,
    );
  });

  assert.equal(state.generateSignals[0], controller.signal);
  assert.equal(state.editSignals[0], controller.signal);
  assert.deepEqual(state.generateArgumentCounts, [2]);
  assert.deepEqual(state.editArgumentCounts, [2]);
});

test("default SDK adapter preserves underlying method arity with and without a signal", async () => {
  interface PatchedImagesPrototype {
    generate(
      ...args: [
        body: OpenAIImageGenerateBody,
        options?: OpenAIImageRequestOptions,
      ]
    ): OpenAIImageAPIPromise;
    edit(
      ...args: [body: OpenAIImageEditBody, options?: OpenAIImageRequestOptions]
    ): OpenAIImageAPIPromise;
  }

  const prototype = Images.prototype as unknown as PatchedImagesPrototype;
  const originalGenerate = prototype.generate;
  const originalEdit = prototype.edit;
  const generateArgumentCounts: number[] = [];
  const editArgumentCounts: number[] = [];
  const generateSignals: (AbortSignal | undefined)[] = [];
  const editSignals: (AbortSignal | undefined)[] = [];
  const success = () =>
    apiSuccess({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] });

  prototype.generate = (...args) => {
    generateArgumentCounts.push(args.length);
    generateSignals.push(args[1]?.signal);
    return success();
  };
  prototype.edit = (...args) => {
    editArgumentCounts.push(args.length);
    editSignals.push(args[1]?.signal);
    return success();
  };

  try {
    const client = new OpenAIImageClient({
      apiKey: "test-key-default-adapter",
      baseURL: "https://provider.example.test/v1",
    });
    const controller = new AbortController();

    await client.generate(generateRequest);
    await client.generate(generateRequest, controller.signal);
    await withSnapshotFixture(async ({ first }) => {
      const request: ProviderEditRequest = {
        model: "gpt-image-2",
        prompt: "exercise the default adapter",
        quality: "auto",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
      };
      await client.edit(request);
      await client.edit(request, controller.signal);
    });

    assert.deepEqual(generateArgumentCounts, [1, 2]);
    assert.deepEqual(editArgumentCounts, [1, 2]);
    assert.deepEqual(generateSignals, [undefined, controller.signal]);
    assert.deepEqual(editSignals, [undefined, controller.signal]);
  } finally {
    prototype.generate = originalGenerate;
    prototype.edit = originalEdit;
  }
});

test("default SDK adapter forwards xhigh and max quality and complexity unchanged", async () => {
  interface PatchedImagesPrototype {
    generate(
      ...args: [
        body: OpenAIImageGenerateBody,
        options?: OpenAIImageRequestOptions,
      ]
    ): OpenAIImageAPIPromise;
    edit(
      ...args: [body: OpenAIImageEditBody, options?: OpenAIImageRequestOptions]
    ): OpenAIImageAPIPromise;
  }

  const prototype = Images.prototype as unknown as PatchedImagesPrototype;
  const originalGenerate = prototype.generate;
  const originalEdit = prototype.edit;
  const generateQualities: unknown[] = [];
  const editQualities: unknown[] = [];
  const generateComplexities: unknown[] = [];
  const editComplexities: unknown[] = [];
  const success = () =>
    apiSuccess({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] });

  prototype.generate = (...args) => {
    generateQualities.push(args[0].quality);
    generateComplexities.push(args[0].complexity);
    return success();
  };
  prototype.edit = (...args) => {
    editQualities.push(args[0].quality);
    editComplexities.push(args[0].complexity);
    return success();
  };

  try {
    const client = new OpenAIImageClient({
      apiKey: "test-key-default-adapter-quality",
      baseURL: "https://provider.example.test/v1",
    });

    await client.generate({
      ...generateRequest,
      model: "gpt-image-2.5-flare",
      quality: "xhigh",
    });
    await client.generate({
      ...generateRequest,
      model: "gpt-image-2.6-flare",
      quality: "max",
      complexity: "low",
    });
    await withSnapshotFixture(async ({ first }) => {
      await client.edit({
        model: "gpt-image-2.5-sunburst",
        prompt: "exercise the default adapter quality",
        quality: "max",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
      });
      await client.edit({
        model: "gpt-image-2.6-sunburst",
        prompt: "exercise the default adapter complexity",
        quality: "xhigh",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        complexity: "medium",
        images: Object.freeze([first]),
      });
    });

    assert.deepEqual(generateQualities, ["xhigh", "max"]);
    assert.deepEqual(editQualities, ["max", "xhigh"]);
    assert.deepEqual(generateComplexities, [undefined, "low"]);
    assert.deepEqual(editComplexities, [undefined, "medium"]);
  } finally {
    prototype.generate = originalGenerate;
    prototype.edit = originalEdit;
  }
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
      model: "gpt-image-2",
      prompt: "combine the references",
      quality: "medium",
      size: "1024x1536",
      output_format: "webp",
      output_compression: 62,
      background: "auto",
      images: Object.freeze([first, second]),
      mask,
    });

    const result = await client.edit(request);

    assert.equal(state.editBodies.length, 1);
    const body = state.editBodies[0]!;
    assert.equal(body.model, "gpt-image-2");
    assert.equal("background" in body, false);
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
      model: "gpt-image-2",
      prompt: "edit one image",
      quality: "auto",
      size: "auto",
      output_format: "png",
      output_compression: 0,
      background: "auto",
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
            model: "gpt-image-2",
            prompt: "edit with invalid mask",
            quality: "auto",
            size: "1024x1024",
            output_format: "png",
            background: "auto",
            images: Object.freeze([first]),
            mask: invalidMask,
          }),
        hasAppErrorCode("INVALID_INPUT"),
      );
      assert.equal(state.editBodies.length, 0);
    }
  });
});

function uploadType(upload: unknown): string {
  const type = (upload as { type?: unknown }).type;
  assert.equal(typeof type, "string");
  return type as string;
}

async function uploadText(upload: unknown): Promise<string> {
  const text = (upload as { text?: unknown }).text;
  assert.equal(typeof text, "function");
  return (upload as { text(): Promise<string> }).text();
}

test("edit uploads a markup snapshot as the markup PNG field and sends no mask", async () => {
  await withSnapshotFixture(async ({ first, second, markup }) => {
    const { client, state } = createClient();

    await client.edit({
      model: "gpt-image-2.6-flare",
      prompt: "follow the markup",
      quality: "high",
      size: "auto",
      output_format: "png",
      background: "auto",
      images: Object.freeze([first, second]),
      markup,
    });

    assert.equal(state.editBodies.length, 1);
    const body = state.editBodies[0]!;
    assert.equal("mask" in body, false);
    assert.deepEqual(
      (body.image as unknown[]).map((upload) => uploadMetadata(upload).name),
      ["first.jpeg", "second.webp"],
    );
    assert.equal(uploadMetadata(body.markup).name, "markup.png");
    assert.equal(uploadMetadata(body.markup).size, MARKUP_FIXTURE_TEXT.length);
    assert.equal(uploadType(body.markup), "image/png");
    assert.equal(await uploadText(body.markup), MARKUP_FIXTURE_TEXT);
  });
});

test("edit rejects an invalid markup snapshot before an SDK call", async () => {
  await withSnapshotFixture(async ({ first, second, mask, markup }) => {
    const oversizedImages = Object.freeze(
      Array.from({ length: 4 }, () =>
        Object.freeze({ ...first, sizeBytes: MAX_INPUT_BYTES }),
      ),
    );
    const cases: readonly [
      Pick<ProviderEditRequest, "images" | "mask" | "markup">,
      string,
    ][] = [
      [
        { images: Object.freeze([first]), mask, markup },
        "INVALID_INPUT: Markup and mask snapshots cannot be combined",
      ],
      [
        {
          images: Object.freeze([first]),
          markup: Object.freeze({ ...second, filename: "markup.webp" }),
        },
        "INVALID_INPUT: Markup snapshot must be a PNG image",
      ],
      [
        {
          images: Object.freeze([first]),
          markup: Object.freeze({ ...markup, filename: "../markup.png" }),
        },
        "INVALID_INPUT: Input snapshot filename is invalid",
      ],
      [
        {
          images: Object.freeze([first]),
          markup: Object.freeze({ ...markup, sizeBytes: 0 }),
        },
        "INVALID_INPUT: Input snapshot size is invalid",
      ],
      [
        {
          images: Object.freeze([first]),
          markup: Object.freeze({
            ...markup,
            info: Object.freeze({ mimeType: "image/gif" }),
          }) as unknown as ProviderInputSnapshot,
        },
        "INVALID_INPUT: Input snapshot media type is invalid",
      ],
      // Four maximum-size images reach the aggregate limit exactly, so only
      // the markup bytes push the request over it.
      [
        { images: oversizedImages, markup },
        "INVALID_INPUT: Input snapshots exceed the aggregate size limit",
      ],
    ];

    for (const [snapshots, message] of cases) {
      const { client, state } = createClient();
      await assert.rejects(
        () =>
          client.edit({
            model: "gpt-image-2.6-flare",
            prompt: "edit with invalid markup",
            quality: "auto",
            size: "1024x1024",
            output_format: "png",
            background: "auto",
            ...snapshots,
          }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "INVALID_INPUT" &&
          error.message === message,
        message,
      );
      assert.equal(state.editBodies.length, 0, message);
    }
  });
});

test("a markup snapshot is not subject to the 4 MiB mask limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-client-markup-"));
  const layerPath = path.join(directory, "layer.snapshot");
  const layerBytes = 4 * 1024 * 1024;
  await writeFile(layerPath, Buffer.alloc(layerBytes));
  const layer: ProviderInputSnapshot = Object.freeze({
    snapshotPath: layerPath,
    filename: "layer.png",
    sizeBytes: layerBytes,
    info: Object.freeze({ mimeType: "image/png" }),
  });
  try {
    await withSnapshotFixture(async ({ first }) => {
      const request = {
        model: "gpt-image-2.5-sunburst",
        prompt: "edit with a large layer",
        quality: "auto",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
      } as const;

      const { client, state } = createClient();
      await client.edit({ ...request, markup: layer });
      assert.equal(state.editBodies.length, 1);
      assert.equal(uploadMetadata(state.editBodies[0]!.markup).size, layerBytes);

      const masked = createClient();
      await assert.rejects(
        () => masked.client.edit({ ...request, mask: layer }),
        (error: unknown) =>
          error instanceof AppError &&
          error.message ===
            "INVALID_INPUT: Mask snapshot must be smaller than 4 MiB",
      );
      assert.equal(masked.state.editBodies.length, 0);
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
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
  assert.equal(
    caught.message,
    "PROVIDER_FAILURE: The image provider request failed with HTTP 500 (request ID: req_safe_sanitized-1)",
  );
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

async function providerFailureMessage(error: unknown): Promise<string> {
  const { client } = createClient({ generate: () => apiFailure(error) });
  try {
    await client.generate(generateRequest);
  } catch (caught) {
    assert.ok(caught instanceof AppError);
    return caught.message;
  }
  assert.fail("generate must reject");
}

test("provider failure messages include a validated HTTP status and nothing else from the provider", async () => {
  const generic = "PROVIDER_FAILURE: The image provider request failed";
  const cases: ReadonlyArray<{ label: string; error: unknown; message: string }> = [
    {
      label: "500 with a safe request ID",
      error: providerError({ status: 500, code: "server_error", requestID: "req_abc" }),
      message: `${generic} with HTTP 500 (request ID: req_abc)`,
    },
    {
      label: "400 without a request ID",
      error: providerError({ status: 400, code: "invalid_request_error" }),
      message: `${generic} with HTTP 400`,
    },
    {
      label: "404 with an unsafe request ID",
      error: providerError({ status: 404, request_id: "req <unsafe>" }),
      message: `${generic} with HTTP 404`,
    },
    {
      label: "lowest valid status",
      error: providerError({ status: 100 }),
      message: `${generic} with HTTP 100`,
    },
    {
      label: "highest valid status",
      error: providerError({ status: 599 }),
      message: `${generic} with HTTP 599`,
    },
    {
      label: "connection error without a status",
      error: new Error("socket disconnected after upload"),
      message: generic,
    },
    {
      label: "connection error with a safe request ID",
      error: providerError({ requestID: "req_conn-1" }),
      message: `${generic} (request ID: req_conn-1)`,
    },
    {
      label: "string status",
      error: providerError({ status: "400", requestID: "req_abc" }),
      message: `${generic} (request ID: req_abc)`,
    },
    { label: "fractional status", error: providerError({ status: 400.5 }), message: generic },
    { label: "status below range", error: providerError({ status: 99 }), message: generic },
    { label: "status above range", error: providerError({ status: 600 }), message: generic },
    { label: "NaN status", error: providerError({ status: Number.NaN }), message: generic },
    {
      label: "infinite status",
      error: providerError({ status: Number.POSITIVE_INFINITY }),
      message: generic,
    },
    { label: "negative status", error: providerError({ status: -400 }), message: generic },
    {
      label: "boxed Number status",
      error: providerError({ status: new Number(400) }),
      message: generic,
    },
    {
      label: "object status with valueOf and toString",
      error: providerError({ status: { valueOf: () => 400, toString: () => "400" } }),
      message: generic,
    },
    { label: "bigint status", error: providerError({ status: 400n }), message: generic },
  ];

  for (const fixture of cases) {
    assert.equal(await providerFailureMessage(fixture.error), fixture.message, fixture.label);
  }
});

test("authentication, rate-limit, and moderation messages carry no HTTP status", async () => {
  const cases: ReadonlyArray<{ label: string; error: unknown; message: string }> = [
    {
      label: "401",
      error: providerError({ status: 401, code: "invalid_api_key" }),
      message: "AUTHENTICATION_FAILED: Authentication with the image provider failed",
    },
    {
      label: "403 with a safe request ID",
      error: providerError({ status: 403, code: "permission_denied", requestID: "req_auth-1" }),
      message:
        "AUTHENTICATION_FAILED: Authentication with the image provider failed (request ID: req_auth-1)",
    },
    {
      label: "429",
      error: providerError({ status: 429, code: "rate_limit_exceeded" }),
      message: "RATE_LIMITED: The image provider rate limit was reached",
    },
    {
      label: "400 moderation",
      error: providerError({ status: 400, code: "content_policy_violation" }),
      message: "MODERATION_BLOCKED: The image request was blocked by provider safety controls",
    },
    {
      label: "403 moderation with a safe request ID",
      error: providerError({
        status: 403,
        error: { code: "moderation_blocked" },
        requestID: "req_mod-1",
      }),
      message:
        "MODERATION_BLOCKED: The image request was blocked by provider safety controls (request ID: req_mod-1)",
    },
  ];

  for (const fixture of cases) {
    assert.equal(await providerFailureMessage(fixture.error), fixture.message, fixture.label);
  }
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
          model: "gpt-image-2",
          prompt: "edit changed snapshot",
          quality: "auto",
          size: "1024x1024",
          output_format: "png",
          background: "auto",
          images: Object.freeze([snapshot]),
        }),
      hasAppErrorCode("INVALID_INPUT"),
    );
    assert.equal(state.editBodies.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("GIF generate bodies carry the auto size default and frame fields but never output_compression", async () => {
  const { client, state } = createClient();

  await client.generate(
    generateImageSchema.parse({
      prompt: "animated request",
      output_format: "gif",
      frame_count: 4,
      frame_duration_ms: 120,
      output_compression: 0,
    }),
  );
  await client.generate(
    generateImageSchema.parse({ prompt: "animated default", output_format: "gif" }),
  );
  await client.generate(
    generateImageSchema.parse({ prompt: "vector request", output_format: "svg" }),
  );

  assert.deepEqual(state.generateBodies, [
    {
      model: "gpt-image-2.6-flare",
      n: 1,
      prompt: "animated request",
      quality: "high",
      size: "auto",
      output_format: "gif",
      moderation: "auto",
      frame_count: 4,
      frame_duration_ms: 120,
    },
    {
      model: "gpt-image-2.6-flare",
      n: 1,
      prompt: "animated default",
      quality: "high",
      size: "auto",
      output_format: "gif",
      moderation: "auto",
    },
    {
      model: "gpt-image-2.6-flare",
      n: 1,
      prompt: "vector request",
      quality: "high",
      size: "1024x1024",
      output_format: "svg",
      moderation: "auto",
    },
  ]);
});

test("output_compression reaches generate and edit bodies only for JPEG and WebP", async () => {
  const { client, state } = createClient();

  const generateFormats = ["png", "gif", "svg", "jpeg", "webp"] as const;
  for (const output_format of generateFormats) {
    await client.generate({
      ...generateRequest,
      model: "gpt-image-2.6-flare",
      output_format,
      output_compression: 30,
    });
  }
  const editFormats = ["png", "gif", "jpeg", "webp"] as const;
  await withSnapshotFixture(async ({ first }) => {
    for (const output_format of editFormats) {
      await client.edit({
        model: "gpt-image-2.6-flare",
        prompt: "edit with compression",
        quality: "high",
        size: "auto",
        output_format,
        output_compression: 30,
        background: "auto",
        images: Object.freeze([first]),
      });
    }
  });

  assert.deepEqual(
    state.generateBodies.map((body) => [
      body.output_format,
      "output_compression" in body,
      body.output_compression,
    ]),
    [
      ["png", false, undefined],
      ["gif", false, undefined],
      ["svg", false, undefined],
      ["jpeg", true, 30],
      ["webp", true, 30],
    ],
  );
  assert.deepEqual(
    state.editBodies.map((body) => [
      body.output_format,
      "output_compression" in body,
      body.output_compression,
    ]),
    [
      ["png", false, undefined],
      ["gif", false, undefined],
      ["jpeg", true, 30],
      ["webp", true, 30],
    ],
  );
});

test("edit bodies carry GIF frame fields and the auto size default only when set", async () => {
  const { client, state } = createClient();

  await withSnapshotFixture(async ({ first }) => {
    await client.edit({
      ...editImageSchema.parse({
        prompt: "animate this",
        image_paths: ["first.jpeg"],
        output_format: "gif",
        frame_count: 5,
        frame_duration_ms: 80,
      }),
      images: Object.freeze([first]),
    });
    await client.edit({
      ...editImageSchema.parse({
        prompt: "animate with defaults",
        image_paths: ["first.jpeg"],
        output_format: "gif",
      }),
      images: Object.freeze([first]),
    });
  });

  assert.equal(state.editBodies.length, 2);
  const [withFrames, withoutFrames] = state.editBodies;
  assert.ok(withFrames && withoutFrames);
  assert.equal(withFrames.output_format, "gif");
  assert.equal(withFrames.size, "auto");
  assert.equal(withFrames.frame_count, 5);
  assert.equal(withFrames.frame_duration_ms, 80);
  assert.equal("output_compression" in withFrames, false);
  assert.equal("mask" in withFrames, false);
  assert.equal(withoutFrames.output_format, "gif");
  assert.equal(withoutFrames.size, "auto");
  assert.equal("frame_count" in withoutFrames, false);
  assert.equal("frame_duration_ms" in withoutFrames, false);
});

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

async function withRecordingServer(
  run: (baseURL: string, requests: readonly RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "req_wire_test",
      });
      response.end(
        JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// openai 6.49.0 predates complexity, the GIF frame fields, and the markup
// layer. This drives the real SDK (no createSDKClient override) against a
// loopback server to prove it puts unknown body keys on the wire unchanged for
// JSON and multipart bodies, including a file part named markup.
test("the real SDK sends complexity, GIF frame fields, and the markup layer on the wire for generate and edit", async () => {
  await withRecordingServer(async (baseURL, requests) => {
    const client = new OpenAIImageClient({
      apiKey: "test-key-wire-level",
      baseURL,
    });

    const generated = await client.generate({
      model: "gpt-image-2.6-flare",
      prompt: "wire generate",
      quality: "high",
      size: "auto",
      output_format: "gif",
      output_compression: 0,
      background: "opaque",
      complexity: "medium",
      frame_count: 6,
      frame_duration_ms: 150,
      moderation: "auto",
    });
    assert.equal(generated.base64, "aW1hZ2U=");
    assert.equal(generated.requestId, "req_wire_test");

    await withSnapshotFixture(async ({ first, markup }) => {
      const edited = await client.edit({
        model: "gpt-image-2.6-sunburst",
        prompt: "wire edit",
        quality: "medium",
        size: "auto",
        output_format: "gif",
        output_compression: 0,
        background: "auto",
        complexity: "low",
        frame_count: 3,
        frame_duration_ms: 400,
        images: Object.freeze([first]),
      });
      assert.equal(edited.base64, "aW1hZ2U=");

      const markupEdited = await client.edit({
        model: "gpt-image-2.5-flare",
        prompt: "wire markup edit",
        quality: "high",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
        images: Object.freeze([first]),
        markup,
      });
      assert.equal(markupEdited.base64, "aW1hZ2U=");
    });

    assert.equal(requests.length, 3);
    const [generateWire, editWire, markupWire] = requests;
    assert.ok(generateWire && editWire && markupWire);

    assert.equal(generateWire.method, "POST");
    assert.equal(generateWire.url, "/v1/images/generations");
    assert.match(
      String(generateWire.headers["content-type"]),
      /^application\/json/,
    );
    assert.deepEqual(JSON.parse(generateWire.body.toString("utf8")), {
      model: "gpt-image-2.6-flare",
      n: 1,
      prompt: "wire generate",
      quality: "high",
      size: "auto",
      output_format: "gif",
      moderation: "auto",
      background: "opaque",
      complexity: "medium",
      frame_count: 6,
      frame_duration_ms: 150,
    });

    assert.equal(editWire.method, "POST");
    assert.equal(editWire.url, "/v1/images/edits");
    const editContentType = String(editWire.headers["content-type"]);
    assert.match(editContentType, /^multipart\/form-data; boundary=/);
    const form = await new Response(Uint8Array.from(editWire.body), {
      headers: { "content-type": editContentType },
    }).formData();
    assert.deepEqual(
      [...form.keys()].sort(),
      [
        "complexity",
        "frame_count",
        "frame_duration_ms",
        "image[]",
        "model",
        "n",
        "output_format",
        "prompt",
        "quality",
        "size",
      ],
    );
    assert.equal(form.get("model"), "gpt-image-2.6-sunburst");
    assert.equal(form.get("output_format"), "gif");
    assert.equal(form.get("size"), "auto");
    assert.equal(form.get("complexity"), "low");
    assert.equal(form.get("frame_count"), "3");
    assert.equal(form.get("frame_duration_ms"), "400");
    assert.equal(form.has("output_compression"), false);
    const uploads = form.getAll("image[]");
    assert.equal(uploads.length, 1);
    assert.equal(uploadMetadata(uploads[0]).name, "first.jpeg");
    assert.equal(form.has("markup"), false);

    assert.equal(markupWire.method, "POST");
    assert.equal(markupWire.url, "/v1/images/edits");
    const markupContentType = String(markupWire.headers["content-type"]);
    assert.match(markupContentType, /^multipart\/form-data; boundary=/);
    const markupForm = await new Response(Uint8Array.from(markupWire.body), {
      headers: { "content-type": markupContentType },
    }).formData();
    assert.deepEqual(
      [...markupForm.keys()].sort(),
      [
        "image[]",
        "markup",
        "model",
        "n",
        "output_format",
        "prompt",
        "quality",
        "size",
      ],
    );
    assert.equal(markupForm.has("mask"), false);
    assert.equal(markupForm.get("model"), "gpt-image-2.5-flare");
    assert.equal(markupForm.get("output_format"), "png");
    const markupParts = markupForm.getAll("markup");
    assert.equal(markupParts.length, 1);
    const markupPart = markupParts[0];
    assert.equal(typeof markupPart, "object");
    assert.equal(uploadMetadata(markupPart).name, "markup.png");
    assert.equal(uploadType(markupPart), "image/png");
    assert.equal(await uploadText(markupPart), MARKUP_FIXTURE_TEXT);
    assert.equal(markupForm.getAll("image[]").length, 1);
    // The part header itself names the field and declares the PNG type.
    assert.match(
      markupWire.body.toString("latin1"),
      /content-disposition: form-data; name="markup"; filename="markup\.png"\r\ncontent-type: image\/png\r\n/i,
    );
  });
});
