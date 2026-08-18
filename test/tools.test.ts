import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../src/config/environment.ts";
import { Semaphore } from "../src/concurrency.ts";
import { AppError } from "../src/errors.ts";
import type {
  InputSnapshot,
  InputSnapshotSet,
  InputSnapshotter,
} from "../src/files/input-snapshot.ts";
import type {
  OutputPublisher,
  PublishedImage,
  PublicationWarning,
} from "../src/files/atomic-output.ts";
import { WorkspacePaths } from "../src/files/workspace-paths.ts";
import { WorkspaceRootRegistry } from "../src/files/workspace-roots.ts";
import type { ImageInfo } from "../src/images/types.ts";
import type {
  ImageProvider,
  ProviderEditRequest,
  ProviderGenerateRequest,
  ProviderImage,
  ProviderImageUsage,
} from "../src/openai/types.ts";
import type {
  EditImageInput,
  GenerateImageInput,
} from "../src/schemas.ts";
import { editImage } from "../src/tools/edit-image.ts";
import { generateImage } from "../src/tools/generate-image.ts";
import { toMcpError, toMcpSuccess } from "../src/tools/result.ts";
import { getStatus } from "../src/tools/status.ts";
import type {
  ToolContext,
  ToolOperations,
} from "../src/tools/types.ts";

const SMALL_PREVIEW_BASE64 = Buffer.from("inline-preview-marker").toString(
  "base64",
);

const PNG_INFO: Readonly<ImageInfo> = Object.freeze({
  format: "png",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  hasAlpha: true,
});

const JPEG_INFO: Readonly<ImageInfo> = Object.freeze({
  format: "jpeg",
  mimeType: "image/jpeg",
  width: 1024,
  height: 1024,
  hasAlpha: false,
});

function configuredRuntime(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    apiKeyConfigured: true,
    apiKey: "test-key-never-returned",
    baseUrl: "https://provider.example.invalid/v1",
    baseUrlConfigured: true,
    pluginDataRoot: path.join(tmpdir(), "gpt-image-test-data"),
    ...overrides,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}

class FakeProvider implements ImageProvider {
  readonly generateRequests: ProviderGenerateRequest[] = [];
  readonly editRequests: ProviderEditRequest[] = [];

  constructor(
    private readonly generateResult: (
      request: ProviderGenerateRequest,
    ) => Promise<ProviderImage> = async () => ({
      base64: SMALL_PREVIEW_BASE64,
    }),
    private readonly editResult: (
      request: ProviderEditRequest,
    ) => Promise<ProviderImage> = async () => ({
      base64: SMALL_PREVIEW_BASE64,
    }),
  ) {}

  async generate(request: ProviderGenerateRequest): Promise<ProviderImage> {
    this.generateRequests.push(request);
    return this.generateResult(request);
  }

  async edit(request: ProviderEditRequest): Promise<ProviderImage> {
    this.editRequests.push(request);
    return this.editResult(request);
  }
}

interface PublisherState {
  readonly calls: Parameters<OutputPublisher>[0][];
}

function createPublisher(options: {
  readonly info?: Readonly<ImageInfo>;
  readonly warnings?: readonly PublicationWarning[];
  readonly sizeBytes?: number;
} = {}): { publisher: OutputPublisher; state: PublisherState } {
  const calls: Parameters<OutputPublisher>[0][] = [];
  const publisher: OutputPublisher = async (input) => {
    calls.push(input);
    return {
      relativePath: input.output.relativePath,
      absolutePath: input.output.absolutePath,
      filename: path.basename(input.output.absolutePath),
      info: { ...(options.info ?? PNG_INFO) },
      sizeBytes:
        options.sizeBytes ?? Buffer.from(input.base64, "base64").byteLength,
      warnings: [...(options.warnings ?? [])],
    };
  };
  return { publisher, state: { calls } };
}

interface SnapshotterState {
  readonly calls: string[][];
  readonly disposals: { count: number }[];
}

function createSnapshotter(
  infoForPath: (relativePath: string, index: number) => Readonly<ImageInfo>,
): { snapshotter: InputSnapshotter; state: SnapshotterState } {
  const calls: string[][] = [];
  const disposals: { count: number }[] = [];
  const snapshotter: InputSnapshotter = async (resolvedPaths) => {
    calls.push(resolvedPaths.map((entry) => entry.relativePath));
    const disposal = { count: 0 };
    disposals.push(disposal);
    const snapshots: InputSnapshot[] = resolvedPaths.map((entry, index) => ({
      originalRelativePath: entry.relativePath,
      snapshotPath: path.join(tmpdir(), `snapshot-${index}`),
      filename: path.basename(entry.relativePath),
      info: infoForPath(entry.relativePath, index),
      sizeBytes: 128 + index,
    }));
    const set: InputSnapshotSet = {
      snapshots,
      async dispose() {
        disposal.count += 1;
      },
    };
    return set;
  };
  return { snapshotter, state: { calls, disposals } };
}

async function withWorkspace(
  run: (fixture: {
    root: string;
    roots: WorkspaceRootRegistry;
    paths: WorkspacePaths;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "gpt-image-tools-"));
  const roots = new WorkspaceRootRegistry();
  await roots.replace([root]);
  try {
    await run({ root, roots, paths: new WorkspacePaths(roots) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeOperations(
  paths: WorkspacePaths,
  overrides: Partial<ToolOperations> = {},
): ToolOperations {
  const { publisher } = createPublisher();
  const { snapshotter } = createSnapshotter(() => PNG_INFO);
  return {
    paths,
    snapshotInputs: snapshotter,
    publishOutput: publisher,
    makeDefaultOutputPath: () =>
      ".claude/generated-images/gpt-image-2/default.png",
    ...overrides,
  };
}

function makeContext(
  roots: WorkspaceRootRegistry,
  provider: ImageProvider | undefined,
  operations: ToolOperations,
  config: RuntimeConfig = configuredRuntime(),
  paidCallGate: Semaphore = new Semaphore(1),
): ToolContext {
  return {
    config,
    roots,
    ...(provider === undefined ? {} : { provider }),
    paidCallGate,
    serverVersion: "0.1.0-test",
    operations,
  };
}

const generateInput: GenerateImageInput = {
  prompt: "draw a safe test image",
  quality: "high",
  size: "1024x1024",
  output_format: "png",
  moderation: "low",
  output_path: "outputs/generated.png",
};

const editInput: EditImageInput = {
  prompt: "edit the safe test image",
  quality: "medium",
  size: "1024x1024",
  output_format: "png",
  image_paths: ["inputs/first.png", "inputs/second.jpeg"],
  mask_path: "inputs/mask.png",
  output_path: "outputs/edited.png",
};

test("getStatus is free and exposes only approved non-secret status fields", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths),
      configuredRuntime({
        apiKey: "secret-status-key",
        baseUrl: "https://secret-endpoint.example.invalid/v1",
      }),
    );

    const result = getStatus(context);

    assert.deepEqual(Object.keys(result).sort(), [
      "api_key_configured",
      "base_url_configured",
      "base_url_valid",
      "default_relative_output_dir",
      "model",
      "server_version",
      "workspace_roots",
    ]);
    assert.deepEqual(result, {
      model: "gpt-image-2",
      api_key_configured: true,
      base_url_configured: true,
      base_url_valid: true,
      workspace_roots: roots.list().map((root) => root.canonicalPath),
      default_relative_output_dir:
        ".claude/generated-images/gpt-image-2",
      server_version: "0.1.0-test",
    });
    assert.equal(provider.generateRequests.length, 0);
    assert.equal(provider.editRequests.length, 0);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("secret-status-key"), false);
    assert.equal(serialized.includes("secret-endpoint"), false);
  });
});

test("getStatus remains available without an API key or provider", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const result = getStatus(
      makeContext(
        roots,
        undefined,
        makeOperations(paths),
        {
          apiKeyConfigured: false,
          baseUrl: "https://api.openai.com/v1",
          baseUrlConfigured: false,
        },
      ),
    );

    assert.equal(result.api_key_configured, false);
    assert.equal(result.base_url_configured, false);
    assert.equal(result.base_url_valid, true);
  });
});

test("missing API key or provider fails before any paid invocation", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    const operations = makeOperations(paths);

    await assert.rejects(
      () =>
        generateImage(
          generateInput,
          makeContext(
            roots,
            provider,
            operations,
            {
              apiKeyConfigured: false,
              baseUrl: "https://provider.example.invalid/v1",
              baseUrlConfigured: true,
            },
          ),
        ),
      hasCode("CONFIG_MISSING"),
    );
    await assert.rejects(
      () => generateImage(generateInput, makeContext(roots, undefined, operations)),
      hasCode("CONFIG_MISSING"),
    );
    assert.equal(provider.generateRequests.length, 0);
  });
});

test("invalid, mismatched-extension, and existing outputs fail before provider invocation", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    const provider = new FakeProvider();
    const { publisher, state } = createPublisher();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { publishOutput: publisher }),
    );

    await mkdir(path.join(root, "outputs"), { recursive: true });
    await writeFile(path.join(root, "outputs", "exists.png"), "existing");

    await assert.rejects(
      () =>
        generateImage(
          { ...generateInput, output_path: "../escape.png" },
          context,
        ),
      hasCode("PATH_OUTSIDE_WORKSPACE"),
    );
    await assert.rejects(
      () =>
        generateImage(
          { ...generateInput, output_path: "outputs/wrong.jpeg" },
          context,
        ),
      hasCode("INVALID_INPUT"),
    );
    await assert.rejects(
      () =>
        generateImage(
          { ...generateInput, output_path: "outputs/exists.png" },
          context,
        ),
      hasCode("OUTPUT_EXISTS"),
    );

    assert.equal(provider.generateRequests.length, 0);
    assert.equal(state.calls.length, 0);
  });
});

test("generate maps validated fields, publishes one image, and reports safe actual metadata", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    const usage: ProviderImageUsage = {
      input_tokens: 11,
      input_tokens_details: { image_tokens: 3, text_tokens: 8 },
      output_tokens: 22,
      total_tokens: 33,
    };
    const provider = new FakeProvider(async () => ({
      base64: SMALL_PREVIEW_BASE64,
      requestId: "req_generate_123.safe",
      usage: {
        ...usage,
        provider_private_value: "must-not-leak",
      } as ProviderImageUsage,
      provider_private_value: "must-not-leak",
    } as ProviderImage));
    const { publisher, state } = createPublisher({
      info: { ...PNG_INFO, width: 1024, height: 1024 },
      warnings: ["TEMP_CLEANUP_PENDING"],
    });
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { publishOutput: publisher }),
    );

    const result = await generateImage(
      {
        ...generateInput,
        workspace_root: root,
      },
      context,
    );

    assert.deepEqual(provider.generateRequests, [
      {
        prompt: "draw a safe test image",
        quality: "high",
        size: "1024x1024",
        output_format: "png",
        moderation: "low",
      },
    ]);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]!.base64, SMALL_PREVIEW_BASE64);
    assert.equal(state.calls[0]!.format, "png");
    assert.deepEqual(result, {
      model: "gpt-image-2",
      workspace_root: roots.list()[0]!.canonicalPath,
      relative_path: "outputs/generated.png",
      absolute_path: path.join(root, "outputs", "generated.png"),
      requested_size: "1024x1024",
      actual_width: 1024,
      actual_height: 1024,
      format: "png",
      mime_type: "image/png",
      size_bytes: Buffer.from(SMALL_PREVIEW_BASE64, "base64").byteLength,
      quality: "high",
      preview_included: true,
      request_id: "req_generate_123.safe",
      usage,
      warnings: ["TEMP_CLEANUP_PENDING"],
      preview: {
        data: SMALL_PREVIEW_BASE64,
        mimeType: "image/png",
      },
    });
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  });
});

test("an explicit size mismatch preserves the published output and adds SIZE_MISMATCH", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    const { publisher, state } = createPublisher({
      info: { ...PNG_INFO, width: 1536, height: 1024 },
      warnings: ["TEMP_CLEANUP_PENDING"],
    });

    const result = await generateImage(
      generateInput,
      makeContext(
        roots,
        provider,
        makeOperations(paths, { publishOutput: publisher }),
      ),
    );

    assert.equal(state.calls.length, 1);
    assert.equal(result.actual_width, 1536);
    assert.equal(result.actual_height, 1024);
    assert.deepEqual(result.warnings, [
      "TEMP_CLEANUP_PENDING",
      "SIZE_MISMATCH",
    ]);
  });
});

test("generate uses a prompt-free default output path when none is supplied", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    let defaultCalls = 0;
    const operations = makeOperations(paths, {
      makeDefaultOutputPath(format) {
        defaultCalls += 1;
        assert.equal(format, "webp");
        return ".claude/generated-images/gpt-image-2/fixed.webp";
      },
      publishOutput: createPublisher({
        info: {
          format: "webp",
          mimeType: "image/webp",
          width: 1024,
          height: 1024,
          hasAlpha: false,
        },
      }).publisher,
    });

    const { output_path: _outputPath, ...inputWithoutOutputPath } = generateInput;
    const result = await generateImage(
      {
        ...inputWithoutOutputPath,
        output_format: "webp",
      },
      makeContext(roots, provider, operations),
    );

    assert.equal(defaultCalls, 1);
    assert.equal(
      result.relative_path,
      ".claude/generated-images/gpt-image-2/fixed.webp",
    );
  });
});

test("edit snapshots inputs plus mask in order and validates the mask before provider invocation", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "inputs", "first.png"), "first"),
      writeFile(path.join(root, "inputs", "second.jpeg"), "second"),
      writeFile(path.join(root, "inputs", "mask.png"), "mask"),
    ]);

    const { snapshotter, state: snapshots } = createSnapshotter(
      (relativePath) =>
        relativePath.endsWith("second.jpeg") ? JPEG_INFO : PNG_INFO,
    );
    const provider = new FakeProvider();
    const { publisher } = createPublisher();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, {
        snapshotInputs: snapshotter,
        publishOutput: publisher,
      }),
    );

    const result = await editImage(editInput, context);

    assert.deepEqual(snapshots.calls, [
      ["inputs/first.png", "inputs/second.jpeg", "inputs/mask.png"],
    ]);
    assert.equal(provider.editRequests.length, 1);
    const request = provider.editRequests[0]!;
    assert.deepEqual(
      request.images.map((image) => image.filename),
      ["first.png", "second.jpeg"],
    );
    assert.equal(request.mask?.filename, "mask.png");
    assert.equal(request.prompt, editInput.prompt);
    assert.equal(request.quality, editInput.quality);
    assert.equal(request.size, editInput.size);
    assert.equal(request.output_format, editInput.output_format);
    assert.equal(snapshots.disposals[0]!.count, 1);
    assert.equal(result.relative_path, "outputs/edited.png");
  });
});

test("edit rejects non-PNG, opaque, and dimension-mismatched masks before provider invocation", async () => {
  const invalidMasks: readonly [string, Readonly<ImageInfo>][] = [
    ["non-PNG", JPEG_INFO],
    ["opaque", { ...PNG_INFO, hasAlpha: false }],
    ["dimension-mismatched", { ...PNG_INFO, width: 1536 }],
  ];

  for (const [name, maskInfo] of invalidMasks) {
    await withWorkspace(async ({ roots, paths }) => {
      const { snapshotter, state } = createSnapshotter((_relative, index) =>
        index === 2 ? maskInfo : PNG_INFO,
      );
      const provider = new FakeProvider();
      const context = makeContext(
        roots,
        provider,
        makeOperations(paths, { snapshotInputs: snapshotter }),
      );

      await assert.rejects(
        () => editImage(editInput, context),
        (error: unknown) => {
          assert.ok(error instanceof AppError, name);
          assert.equal(error.code, "INPUT_FILE_INVALID", name);
          return true;
        },
      );
      assert.equal(provider.editRequests.length, 0, name);
      assert.equal(state.disposals[0]!.count, 1, name);
    });
  }
});

test("edit rejects image counts outside 1-8 before snapshotting or provider invocation", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const { snapshotter, state } = createSnapshotter(() => PNG_INFO);
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    for (const image_paths of [[], Array.from({ length: 9 }, (_, i) => `i${i}.png`)]) {
      await assert.rejects(
        () => editImage({ ...editInput, image_paths }, context),
        hasCode("INVALID_INPUT"),
      );
    }
    assert.equal(state.calls.length, 0);
    assert.equal(provider.editRequests.length, 0);
  });
});

test("edit rejects an output path identical to an image or mask before snapshotting", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    await writeFile(path.join(root, "inputs", "mask.png"), "mask");
    const { snapshotter, state } = createSnapshotter(() => PNG_INFO);
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    for (const output_path of ["inputs/first.png", "inputs/mask.png"]) {
      await assert.rejects(
        () =>
          editImage(
            {
              ...editInput,
              image_paths: ["inputs/first.png"],
              mask_path: "inputs/mask.png",
              output_path,
            },
            context,
          ),
        hasCode("INVALID_INPUT"),
      );
    }

    assert.equal(state.calls.length, 0);
    assert.equal(provider.editRequests.length, 0);
  });
});

test("edit disposes snapshots after provider success and provider failure", async () => {
  for (const shouldFail of [false, true]) {
    await withWorkspace(async ({ roots, paths }) => {
      const { snapshotter, state } = createSnapshotter(() => PNG_INFO);
      const provider = new FakeProvider(
        undefined,
        shouldFail
          ? async () => {
              throw new AppError("PROVIDER_FAILURE", "simulated provider failure");
            }
          : async () => ({ base64: SMALL_PREVIEW_BASE64 }),
      );
      const context = makeContext(
        roots,
        provider,
        makeOperations(paths, { snapshotInputs: snapshotter }),
      );
      const { mask_path: _maskPath, ...inputWithoutMask } = editInput;
      const input: EditImageInput = {
        ...inputWithoutMask,
        image_paths: ["inputs/first.png"],
      };

      if (shouldFail) {
        await assert.rejects(
          () => editImage(input, context),
          hasCode("PROVIDER_FAILURE"),
        );
      } else {
        await editImage(input, context);
      }
      assert.equal(state.disposals[0]!.count, 1);
    });
  }
});

test("the semaphore is FIFO, allows one paid call at a time, and releases after failure", async () => {
  const gate = new Semaphore(1);
  const starts: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const run = (id: number, fail = false) =>
    gate.runExclusive(async () => {
      starts.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (id === 1) {
          await firstBlocked;
        }
        if (fail) {
          throw new Error("expected failure");
        }
      } finally {
        active -= 1;
      }
    });

  const first = run(1);
  const second = run(2, true);
  const third = run(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1]);
  releaseFirst();
  await first;
  await assert.rejects(second, /expected failure/);
  await third;

  assert.deepEqual(starts, [1, 2, 3]);
  assert.equal(maximumActive, 1);
});

test("concurrent generate calls share the paid-call gate and never overlap provider calls", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const provider = new FakeProvider(async (request) => {
      starts.push(request.prompt);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { base64: SMALL_PREVIEW_BASE64 };
    });
    const gate = new Semaphore(1);
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths),
      configuredRuntime(),
      gate,
    );

    await Promise.all([
      generateImage(
        { ...generateInput, prompt: "first", output_path: "outputs/1.png" },
        context,
      ),
      generateImage(
        { ...generateInput, prompt: "second", output_path: "outputs/2.png" },
        context,
      ),
      generateImage(
        { ...generateInput, prompt: "third", output_path: "outputs/3.png" },
        context,
      ),
    ]);

    assert.deepEqual([...starts].sort(), ["first", "second", "third"]);
    assert.equal(maximumActive, 1);
  });
});

test("toMcpSuccess includes previews only at or below 2 MiB and never puts Base64 in text or structuredContent", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const atLimitBytes = 2 * 1024 * 1024;
    const atLimit = Buffer.alloc(atLimitBytes, 0x41).toString("base64");

    async function runWith(
      base64: string,
      outputPath: string,
      sizeBytes: number,
    ) {
      const provider = new FakeProvider(async () => ({ base64 }));
      const { publisher } = createPublisher({ sizeBytes });
      return generateImage(
        { ...generateInput, output_path: outputPath },
        makeContext(
          roots,
          provider,
          makeOperations(paths, { publishOutput: publisher }),
        ),
      );
    }

    const included = await runWith(
      atLimit,
      "outputs/at-limit.png",
      atLimitBytes,
    );
    const includedMcp = toMcpSuccess(included);
    assert.equal(included.preview_included, true);
    assert.equal(includedMcp.content.length, 2);
    assert.deepEqual(includedMcp.content[1], {
      type: "image",
      data: atLimit,
      mimeType: "image/png",
    });

    const text = includedMcp.content[0];
    assert.equal(text?.type, "text");
    assert.equal(
      text?.type === "text" && text.text.includes(atLimit.slice(0, 64)),
      false,
    );
    assert.equal(
      JSON.stringify(includedMcp.structuredContent).includes(
        atLimit.slice(0, 64),
      ),
      false,
    );
    assert.equal("preview" in (includedMcp.structuredContent ?? {}), false);

    const overLimitBytes = atLimitBytes + 1;
    const overLimit = Buffer.alloc(overLimitBytes, 0x42).toString("base64");
    const omitted = await runWith(
      overLimit,
      "outputs/over-limit.png",
      overLimitBytes,
    );
    const omittedMcp = toMcpSuccess(omitted);
    assert.equal(omitted.preview_included, false);
    assert.equal("preview" in omitted, false);
    assert.equal(omittedMcp.content.length, 1);
    assert.equal(
      JSON.stringify(omittedMcp).includes(overLimit.slice(0, 64)),
      false,
    );
  });
});

test("toMcpSuccess maps status without adding secret-bearing fields", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const status = getStatus(
      makeContext(roots, new FakeProvider(), makeOperations(paths)),
    );
    const result = toMcpSuccess(status);

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, status);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, "text");
  });
});

test("toMcpError maps known and unknown failures through sanitized error results", () => {
  const secret = "secret-cause-and-base64-marker";
  const known = toMcpError(
    new AppError("INVALID_INPUT", "Correct the image tool input", {
      cause: { secret },
    }),
  );
  assert.equal(known.isError, true);
  assert.deepEqual(known.structuredContent, {
    isError: true,
    code: "INVALID_INPUT",
    message: "INVALID_INPUT: Correct the image tool input",
  });
  assert.deepEqual(known.content, [
    {
      type: "text",
      text: "INVALID_INPUT: Correct the image tool input",
    },
  ]);
  assert.equal(JSON.stringify(known).includes(secret), false);

  const unknown = toMcpError(new Error(secret));
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, {
    isError: true,
    code: "INTERNAL_ERROR",
    message: "INTERNAL_ERROR: An unexpected error occurred",
  });
  assert.equal(JSON.stringify(unknown).includes(secret), false);
});
