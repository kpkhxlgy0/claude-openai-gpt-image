import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../src/config/environment.ts";
import { Semaphore } from "../src/concurrency.ts";
import { AppError } from "../src/errors.ts";
import {
  snapshotInputs,
  type InputSnapshot,
  type InputSnapshotSet,
  type InputSnapshotter,
} from "../src/files/input-snapshot.ts";
import {
  publishOutput,
  type OutputPublisher,
  type PublishedImage,
  type PublicationWarning,
} from "../src/files/atomic-output.ts";
import { makeDefaultOutputPath } from "../src/files/default-output.ts";
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
import {
  editImageSchema,
  generateImageSchema,
  type EditImageInput,
  type GenerateImageInput,
} from "../src/schemas.ts";
import { editImage } from "../src/tools/edit-image.ts";
import { generateImage } from "../src/tools/generate-image.ts";
import { toMcpError, toMcpSuccess } from "../src/tools/result.ts";
import { getStatus } from "../src/tools/status.ts";
import type {
  ImageToolOutput,
  ToolContext,
  ToolOperations,
} from "../src/tools/types.ts";
import {
  makeBaselineJpeg,
  makeGif,
  makeLossyWebP,
  makePng,
  makeSvg,
} from "./helpers/image-fixtures.ts";

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
  readonly generateSignals: (AbortSignal | undefined)[] = [];
  readonly editSignals: (AbortSignal | undefined)[] = [];

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

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage> {
    this.generateRequests.push(request);
    this.generateSignals.push(signal);
    return this.generateResult(request);
  }

  async edit(
    request: ProviderEditRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage> {
    this.editRequests.push(request);
    this.editSignals.push(signal);
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
      ".claude/generated-images/gpt-image/default.png",
    deferCleanup(task) {
      const timer = setTimeout(() => {
        void task().catch(() => undefined);
      }, 1_000);
      timer.unref();
    },
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
  model: "gpt-image-2",
  prompt: "draw a safe test image",
  quality: "high",
  size: "1024x1024",
  output_format: "png",
  background: "auto",
  moderation: "low",
  output_path: "outputs/generated.png",
};

const editInput: EditImageInput = {
  model: "gpt-image-2",
  prompt: "edit the safe test image",
  quality: "medium",
  size: "1024x1024",
  output_format: "png",
  background: "auto",
  image_paths: ["inputs/first.png", "inputs/second.jpeg"],
  mask_path: "inputs/mask.png",
  output_path: "outputs/edited.png",
};

const { mask_path: _editInputMaskPath, ...editInputWithoutMask } = editInput;

// The first image is stored portrait, as an EXIF-rotated JPEG is before the
// orientation is applied.
const PORTRAIT_JPEG_INFO: Readonly<ImageInfo> = Object.freeze({
  ...JPEG_INFO,
  width: 1024,
  height: 1536,
});

const markupEditInput: EditImageInput = {
  ...editInputWithoutMask,
  model: "gpt-image-2.6-flare",
  image_paths: ["inputs/first.jpeg"],
  markup_path: "inputs/markup.png",
};

function markupInfo(
  width: number,
  height: number,
  overrides: Partial<ImageInfo> = {},
): Readonly<ImageInfo> {
  return Object.freeze({ ...PNG_INFO, width, height, ...overrides });
}

const PORTRAIT_PNG_INFO: Readonly<ImageInfo> = markupInfo(1024, 1536);

const PORTRAIT_WEBP_INFO: Readonly<ImageInfo> = Object.freeze({
  format: "webp",
  mimeType: "image/webp",
  width: 1024,
  height: 1536,
  hasAlpha: false,
});

const MARKUP_DIMENSION_MESSAGE =
  "INPUT_FILE_INVALID: Edit markup dimensions must match the first input image";

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
      model: "gpt-image-2.6-flare",
      api_key_configured: true,
      base_url_configured: true,
      base_url_valid: true,
      workspace_roots: roots.list().map((root) => root.canonicalPath),
      default_relative_output_dir:
        ".claude/generated-images/gpt-image",
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
        model: "gpt-image-2",
        prompt: "draw a safe test image",
        quality: "high",
        size: "1024x1024",
        output_format: "png",
        background: "auto",
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
        return ".claude/generated-images/gpt-image/fixed.webp";
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
      ".claude/generated-images/gpt-image/fixed.webp",
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
    assert.equal(request.model, "gpt-image-2");
    assert.equal(request.background, "auto");
    assert.equal(snapshots.disposals[0]!.count, 1);
    assert.equal(result.relative_path, "outputs/edited.png");
    assert.equal(result.model, "gpt-image-2");
  });
});

test("generate and edit forward the selected model and background and report the model used", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    const provider = new FakeProvider();
    const { snapshotter } = createSnapshotter(() => PNG_INFO);
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    const generated = await generateImage(
      {
        ...generateInput,
        model: "gpt-image-2.5-sunburst",
        background: "transparent",
        output_path: "outputs/sunburst.png",
      },
      context,
    );
    const { mask_path: _maskPath, ...withoutMask } = editInput;
    const edited = await editImage(
      {
        ...withoutMask,
        model: "gpt-image-2.5-flare",
        background: "opaque",
        image_paths: ["inputs/first.png"],
        output_path: "outputs/flare.png",
      },
      context,
    );

    assert.equal(provider.generateRequests.length, 1);
    assert.equal(provider.generateRequests[0]!.model, "gpt-image-2.5-sunburst");
    assert.equal(provider.generateRequests[0]!.background, "transparent");
    assert.equal(provider.editRequests.length, 1);
    assert.equal(provider.editRequests[0]!.model, "gpt-image-2.5-flare");
    assert.equal(provider.editRequests[0]!.background, "opaque");
    assert.equal(generated.model, "gpt-image-2.5-sunburst");
    assert.equal(edited.model, "gpt-image-2.5-flare");
    assert.equal(toMcpSuccess(generated).structuredContent?.model, "gpt-image-2.5-sunburst");
    const editedText = toMcpSuccess(edited).content[0];
    assert.ok(
      editedText?.type === "text" &&
        editedText.text.startsWith("Saved gpt-image-2.5-flare image to "),
    );
  });
});

test("generate and edit forward complexity to the provider request only when it is set", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    const provider = new FakeProvider();
    const { snapshotter } = createSnapshotter(() => PNG_INFO);
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );
    const { mask_path: _maskPath, ...withoutMask } = editInput;

    await generateImage(
      {
        ...generateInput,
        model: "gpt-image-2.6-sunburst",
        complexity: "low",
        output_path: "outputs/complexity-low.png",
      },
      context,
    );
    await generateImage(
      {
        ...generateInput,
        model: "gpt-image-2.6-flare",
        output_path: "outputs/complexity-default.png",
      },
      context,
    );
    await editImage(
      {
        ...withoutMask,
        model: "gpt-image-2.6-flare",
        complexity: "high",
        image_paths: ["inputs/first.png"],
        output_path: "outputs/complexity-high-edit.png",
      },
      context,
    );
    await editImage(
      {
        ...withoutMask,
        model: "gpt-image-2.6-sunburst",
        image_paths: ["inputs/first.png"],
        output_path: "outputs/complexity-default-edit.png",
      },
      context,
    );

    assert.equal(provider.generateRequests.length, 2);
    assert.equal(provider.generateRequests[0]!.model, "gpt-image-2.6-sunburst");
    assert.equal(provider.generateRequests[0]!.complexity, "low");
    assert.equal("complexity" in provider.generateRequests[1]!, false);
    assert.equal(provider.editRequests.length, 2);
    assert.equal(provider.editRequests[0]!.model, "gpt-image-2.6-flare");
    assert.equal(provider.editRequests[0]!.complexity, "high");
    assert.equal("complexity" in provider.editRequests[1]!, false);
  });
});

test("generate and edit forward the caller signal into output publication", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    const controller = new AbortController();
    const provider = new FakeProvider();
    const { publisher, state } = createPublisher();
    const { snapshotter } = createSnapshotter(() => PNG_INFO);
    const operations = makeOperations(paths, {
      snapshotInputs: snapshotter,
      publishOutput: publisher,
    });
    const context = makeContext(roots, provider, operations);

    await generateImage(generateInput, context, controller.signal);
    const { mask_path: _maskPath, ...withoutMask } = editInput;
    await editImage(
      {
        ...withoutMask,
        image_paths: ["inputs/first.png"],
      },
      context,
      controller.signal,
    );

    assert.equal(state.calls.length, 2);
    assert.equal(
      (state.calls[0] as Parameters<OutputPublisher>[0] & {
        signal?: AbortSignal;
      }).signal,
      controller.signal,
    );
    assert.equal(
      (state.calls[1] as Parameters<OutputPublisher>[0] & {
        signal?: AbortSignal;
      }).signal,
      controller.signal,
    );
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

test("edit snapshots images then the markup layer in order and sends markup without a mask", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const { snapshotter, state } = createSnapshotter((relativePath) => {
      if (relativePath.endsWith("markup.png")) return markupInfo(1024, 1536);
      return relativePath.endsWith("first.jpeg") ? PORTRAIT_JPEG_INFO : PNG_INFO;
    });
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    const result = await editImage(
      {
        ...markupEditInput,
        image_paths: ["inputs/first.jpeg", "inputs/second.png"],
      },
      context,
    );

    assert.deepEqual(state.calls, [
      ["inputs/first.jpeg", "inputs/second.png", "inputs/markup.png"],
    ]);
    assert.equal(provider.editRequests.length, 1);
    const request = provider.editRequests[0]!;
    assert.deepEqual(
      request.images.map((image) => image.filename),
      ["first.jpeg", "second.png"],
    );
    assert.equal(request.markup?.filename, "markup.png");
    assert.equal(request.markup?.info.mimeType, "image/png");
    assert.equal("mask" in request, false);
    assert.equal(request.model, "gpt-image-2.6-flare");
    assert.equal(state.disposals[0]!.count, 1);
    assert.equal(result.model, "gpt-image-2.6-flare");
  });
});

test("edit resolves a mask and a markup layer in order when both reach the tool layer", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const { snapshotter, state } = createSnapshotter((relativePath) =>
      relativePath.endsWith("second.jpeg") ? JPEG_INFO : PNG_INFO,
    );
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    await editImage(
      {
        ...editInput,
        model: "gpt-image-2.6-flare",
        markup_path: "inputs/markup.png",
      },
      context,
    );

    assert.deepEqual(state.calls, [
      [
        "inputs/first.png",
        "inputs/second.jpeg",
        "inputs/mask.png",
        "inputs/markup.png",
      ],
    ]);
    assert.equal(provider.editRequests.length, 1);
    const request = provider.editRequests[0]!;
    assert.deepEqual(
      request.images.map((image) => image.filename),
      ["first.png", "second.jpeg"],
    );
    assert.equal(request.mask?.filename, "mask.png");
    assert.equal(request.markup?.filename, "markup.png");
    assert.equal(state.disposals[0]!.count, 1);
  });
});

test("edit accepts an exact markup match for PNG, JPEG, and WebP first images and a transposed one only for JPEG and WebP", async () => {
  const acceptedMarkups: readonly [string, Readonly<ImageInfo>, number, number][] = [
    ["PNG exact", PORTRAIT_PNG_INFO, 1024, 1536],
    ["JPEG exact", PORTRAIT_JPEG_INFO, 1024, 1536],
    ["JPEG transposed", PORTRAIT_JPEG_INFO, 1536, 1024],
    ["WebP exact", PORTRAIT_WEBP_INFO, 1024, 1536],
    ["WebP transposed", PORTRAIT_WEBP_INFO, 1536, 1024],
  ];

  for (const [label, firstInfo, width, height] of acceptedMarkups) {
    await withWorkspace(async ({ roots, paths }) => {
      const { snapshotter, state } = createSnapshotter((_relative, index) =>
        index === 1 ? markupInfo(width, height) : firstInfo,
      );
      const provider = new FakeProvider();
      const context = makeContext(
        roots,
        provider,
        makeOperations(paths, { snapshotInputs: snapshotter }),
      );

      await editImage(markupEditInput, context);

      assert.equal(provider.editRequests.length, 1, label);
      assert.equal(
        provider.editRequests[0]!.markup?.filename,
        "markup.png",
        label,
      );
      assert.equal(state.disposals[0]!.count, 1, label);
    });
  }
});

test("edit rejects a transposed markup layer when the first image is a PNG", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const { snapshotter, state } = createSnapshotter((_relative, index) =>
      index === 1 ? markupInfo(1536, 1024) : PORTRAIT_PNG_INFO,
    );
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    await assert.rejects(
      () =>
        editImage(
          { ...markupEditInput, image_paths: ["inputs/first.png"] },
          context,
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "INPUT_FILE_INVALID" &&
        error.message === MARKUP_DIMENSION_MESSAGE,
    );
    assert.equal(provider.editRequests.length, 0);
    assert.equal(state.disposals[0]!.count, 1);
  });
});

test("edit compares the markup layer with the first image, not with any input image", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const { snapshotter, state } = createSnapshotter((_relative, index) => {
      if (index === 0) return PORTRAIT_PNG_INFO;
      if (index === 1) return markupInfo(1024, 1024);
      return markupInfo(1024, 1024);
    });
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    await assert.rejects(
      () =>
        editImage(
          {
            ...markupEditInput,
            image_paths: ["inputs/first.png", "inputs/second.png"],
          },
          context,
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "INPUT_FILE_INVALID" &&
        error.message === MARKUP_DIMENSION_MESSAGE,
    );
    assert.deepEqual(state.calls, [
      ["inputs/first.png", "inputs/second.png", "inputs/markup.png"],
    ]);
    assert.equal(provider.editRequests.length, 0);
    assert.equal(state.disposals[0]!.count, 1);
  });
});

test("edit rejects JPEG, opaque, and dimension-mismatched markup layers before provider invocation", async () => {
  const dimensionMessage =
    "INPUT_FILE_INVALID: Edit markup dimensions must match the first input image";
  const invalidMarkups: readonly [string, Readonly<ImageInfo>, string][] = [
    [
      "JPEG",
      PORTRAIT_JPEG_INFO,
      "INPUT_FILE_INVALID: Edit markup must be a PNG image",
    ],
    [
      "opaque PNG",
      markupInfo(1024, 1536, { hasAlpha: false }),
      "INPUT_FILE_INVALID: Edit markup PNG must contain an alpha channel",
    ],
    ["one pixel narrower", markupInfo(1023, 1536), dimensionMessage],
    ["one pixel shorter", markupInfo(1024, 1535), dimensionMessage],
    ["transposed and one pixel narrower", markupInfo(1535, 1024), dimensionMessage],
    ["transposed and one pixel shorter", markupInfo(1536, 1023), dimensionMessage],
    ["only the width matches", markupInfo(1024, 1024), dimensionMessage],
    ["only the height matches", markupInfo(1536, 1536), dimensionMessage],
  ];

  for (const [name, info, message] of invalidMarkups) {
    await withWorkspace(async ({ roots, paths }) => {
      const { snapshotter, state } = createSnapshotter((_relative, index) =>
        index === 1 ? info : PORTRAIT_JPEG_INFO,
      );
      const provider = new FakeProvider();
      const context = makeContext(
        roots,
        provider,
        makeOperations(paths, { snapshotInputs: snapshotter }),
      );

      await assert.rejects(
        () => editImage(markupEditInput, context),
        (error: unknown) => {
          assert.ok(error instanceof AppError, name);
          assert.equal(error.code, "INPUT_FILE_INVALID", name);
          assert.equal(error.message, message, name);
          return true;
        },
      );
      assert.equal(state.calls.length, 1, name);
      assert.equal(provider.editRequests.length, 0, name);
      assert.equal(state.disposals[0]!.count, 1, name);
    });
  }
});

test("edit rejects an output path identical to an image or the markup layer before snapshotting", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    await writeFile(path.join(root, "inputs", "markup.png"), "markup");
    const { snapshotter, state } = createSnapshotter(() => PNG_INFO);
    const provider = new FakeProvider();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );

    for (const output_path of ["inputs/first.png", "inputs/markup.png"]) {
      await assert.rejects(
        () =>
          editImage(
            {
              ...markupEditInput,
              image_paths: ["inputs/first.png"],
              output_path,
            },
            context,
          ),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "INVALID_INPUT" &&
          error.message ===
            "INVALID_INPUT: Output path must not identify an edit input, mask, or markup layer",
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

test("edit preserves provider and publication failures when snapshot cleanup is deferred", async () => {
  for (const stage of ["provider", "publication"] as const) {
    await withWorkspace(async ({ root, roots, paths }) => {
      await mkdir(path.join(root, "inputs"), { recursive: true });
      await writeFile(path.join(root, "inputs", "first.png"), "first");
      let disposalAttempts = 0;
      const deferredCleanupTasks: (() => Promise<void>)[] = [];
      const snapshotter: InputSnapshotter = async (resolvedPaths) => ({
        snapshots: resolvedPaths.map((entry) => ({
          originalRelativePath: entry.relativePath,
          snapshotPath: path.join(tmpdir(), "failed-cleanup.snapshot"),
          filename: path.basename(entry.relativePath),
          info: PNG_INFO,
          sizeBytes: 128,
        })),
        async dispose() {
          disposalAttempts += 1;
          if (disposalAttempts === 1) {
            throw new Error("private snapshot cleanup failure");
          }
        },
      });
      const provider = new FakeProvider(
        undefined,
        stage === "provider"
          ? async () => {
              throw new AppError(
                "PROVIDER_FAILURE",
                "simulated provider failure",
              );
            }
          : async () => ({ base64: SMALL_PREVIEW_BASE64 }),
      );
      const { publisher } = createPublisher();
      const failingPublisher: OutputPublisher =
        stage === "publication"
          ? async () => {
              throw new AppError(
                "INTERNAL_ERROR",
                "simulated publication failure",
              );
            }
          : publisher;
      const { mask_path: _maskPath, ...withoutMask } = editInput;
      const context = makeContext(
        roots,
        provider,
        makeOperations(paths, {
          snapshotInputs: snapshotter,
          publishOutput: failingPublisher,
          deferCleanup(task) {
            deferredCleanupTasks.push(task);
          },
        }),
      );

      await assert.rejects(
        () =>
          editImage(
            {
              ...withoutMask,
              image_paths: ["inputs/first.png"],
            },
            context,
          ),
        hasCode(stage === "provider" ? "PROVIDER_FAILURE" : "INTERNAL_ERROR"),
        stage,
      );
      assert.equal(disposalAttempts, 1, stage);
      assert.equal(deferredCleanupTasks.length, 1, stage);

      await deferredCleanupTasks[0]!();
      assert.equal(disposalAttempts, 2, stage);
    });
  }
});

test("snapshot cleanup failure after publication returns success with a cleanup warning", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    let disposalAttempts = 0;
    const deferredCleanupTasks: (() => Promise<void>)[] = [];
    const snapshotter: InputSnapshotter = async (resolvedPaths) => ({
      snapshots: resolvedPaths.map((entry) => ({
        originalRelativePath: entry.relativePath,
        snapshotPath: path.join(tmpdir(), "cleanup-warning.snapshot"),
        filename: path.basename(entry.relativePath),
        info: PNG_INFO,
        sizeBytes: 128,
      })),
      async dispose() {
        disposalAttempts += 1;
        if (disposalAttempts === 1) {
          throw new Error("private snapshot cleanup path");
        }
      },
    });
    const provider = new FakeProvider();
    const { mask_path: _maskPath, ...withoutMask } = editInput;

    const result = await editImage(
      {
        ...withoutMask,
        image_paths: ["inputs/first.png"],
      },
      makeContext(
        roots,
        provider,
        makeOperations(paths, {
          snapshotInputs: snapshotter,
          deferCleanup(task) {
            deferredCleanupTasks.push(task);
          },
        }),
      ),
    );

    assert.deepEqual(result.warnings, ["SNAPSHOT_CLEANUP_PENDING"]);
    assert.equal(provider.editRequests.length, 1);
    assert.equal(disposalAttempts, 1);
    assert.equal(deferredCleanupTasks.length, 1);
    await deferredCleanupTasks[0]!();
    assert.equal(disposalAttempts, 2);
  });
});

test("an aborted queued edit never creates snapshots or invokes the provider", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    const { snapshotter, state: snapshots } = createSnapshotter(() => PNG_INFO);
    const provider = new FakeProvider();
    const gate = new Semaphore(1);
    let releaseBlocker!: () => void;
    const blockerWait = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = gate.runExclusive(() => blockerWait);
    const controller = new AbortController();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
      configuredRuntime(),
      gate,
    );
    const { mask_path: _maskPath, ...withoutMask } = editInput;
    const queuedOutcome = editImage(
      {
        ...withoutMask,
        image_paths: ["inputs/first.png"],
        output_path: "outputs/queued.png",
      },
      context,
      controller.signal,
    ).then(
      (value) => value,
      (error: unknown) => error,
    );

    const snapshotDeadline = Date.now() + 250;
    while (snapshots.calls.length === 0 && Date.now() < snapshotDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const snapshotCallsBeforeAbort = snapshots.calls.length;
    controller.abort();
    releaseBlocker();
    await blocker;
    const outcome = await queuedOutcome;

    assert.equal(snapshotCallsBeforeAbort, 0);
    assert.equal(snapshots.calls.length, 0);
    assert.equal(provider.editRequests.length, 0);
    assert.ok(outcome instanceof DOMException);
    assert.equal(outcome.name, "AbortError");
  });
});

test("an admitted edit passes cancellation into snapshot creation", async () => {
  await withWorkspace(async ({ root, roots, paths }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "first.png"), "first");
    const provider = new FakeProvider();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const snapshotter: InputSnapshotter = async (
      _resolvedPaths,
      _pluginDataRoot,
      signal?: AbortSignal,
    ) => {
      observedSignal = signal;
      markSnapshotStarted();
      return new Promise((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("snapshot cancellation signal was not provided"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { snapshotInputs: snapshotter }),
    );
    const { mask_path: _maskPath, ...withoutMask } = editInput;
    const editOutcome = editImage(
      {
        ...withoutMask,
        image_paths: ["inputs/first.png"],
        output_path: "outputs/cancelled-snapshot.png",
      },
      context,
      controller.signal,
    ).then(
      (value) => value,
      (error: unknown) => error,
    );

    await snapshotStarted;
    controller.abort();
    const outcome = await editOutcome;

    assert.equal(observedSignal, controller.signal);
    assert.equal(observedSignal.aborted, true);
    assert.ok(outcome instanceof DOMException);
    assert.equal(outcome.name, "AbortError");
    assert.equal(provider.editRequests.length, 0);
  });
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

test("the semaphore removes an aborted queued waiter without disturbing FIFO order", async () => {
  const gate = new Semaphore(1);
  const starts: number[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = new AbortController();

  const first = gate.runExclusive(async () => {
    starts.push(1);
    await firstBlocked;
  });
  const cancelled = gate.runExclusive(() => {
    starts.push(2);
  }, controller.signal);
  const third = gate.runExclusive(() => {
    starts.push(3);
  });
  const cancelledAssertion = assert.rejects(
    cancelled,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1]);
  controller.abort();
  releaseFirst();
  await first;
  await cancelledAssertion;
  await third;

  assert.deepEqual(starts, [1, 3]);
});

test("the semaphore rejects beyond its pending bound before running an operation", async () => {
  const gate = new Semaphore(1, 1);
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let overflowRan = false;

  const first = gate.runExclusive(() => firstBlocked);
  const second = gate.runExclusive(() => undefined);
  const overflow = gate.runExclusive(() => {
    overflowRan = true;
  });

  try {
    const outcome = await Promise.race([
      overflow.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 25),
      ),
    ]);
    assert.ok(outcome instanceof AppError);
    assert.equal(outcome.code, "RATE_LIMITED");
    assert.equal(overflowRan, false);
  } finally {
    releaseFirst();
    await Promise.allSettled([first, second, overflow]);
  }
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

test("concurrent generate calls for one output invoke the provider at most once", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    const publicationGate = new Semaphore(1);
    let publicationCalls = 0;
    let markFirstPublicationStarted!: () => void;
    const firstPublicationStarted = new Promise<void>((resolve) => {
      markFirstPublicationStarted = resolve;
    });
    let releaseFirstPublication!: () => void;
    const firstPublicationBlocked = new Promise<void>((resolve) => {
      releaseFirstPublication = resolve;
    });
    const publisher: OutputPublisher = (input) =>
      publicationGate.runExclusive(async () => {
        publicationCalls += 1;
        if (publicationCalls === 1) {
          markFirstPublicationStarted();
          await firstPublicationBlocked;
        }
        await mkdir(path.dirname(input.output.absolutePath), { recursive: true });
        try {
          await writeFile(input.output.absolutePath, "published", { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new AppError("OUTPUT_EXISTS", "Output path already exists");
          }
          throw error;
        }
        return {
          relativePath: input.output.relativePath,
          absolutePath: input.output.absolutePath,
          filename: path.basename(input.output.absolutePath),
          info: { ...PNG_INFO },
          sizeBytes: Buffer.from(input.base64, "base64").byteLength,
          warnings: [],
        };
      });
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { publishOutput: publisher }),
    );

    const first = generateImage(generateInput, context);
    await firstPublicationStarted;
    const secondOutcome = generateImage(generateInput, context).then(
      (value) => value,
      (error: unknown) => error,
    );
    const providerDeadline = Date.now() + 250;
    while (
      provider.generateRequests.length < 2 &&
      Date.now() < providerDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const providerCallsBeforePublication = provider.generateRequests.length;

    releaseFirstPublication();
    await first;
    const second = await secondOutcome;

    assert.ok(second instanceof AppError);
    assert.equal(second.code, "OUTPUT_EXISTS");
    assert.equal(providerCallsBeforePublication, 1);
    assert.equal(provider.generateRequests.length, 1);
    assert.equal(publicationCalls, 1);
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

test("toMcpSuccess renders path text as escaped untrusted data", () => {
  const markdownTarget = ["https:", "", "example.invalid", ""].join("/");
  const relativePath = [
    "outputs/line",
    String.fromCodePoint(0x0a, 0x85, 0x2028, 0x2029, 0x202e),
    `[click](${markdownTarget})\`name\`.png`,
  ].join("");
  const output: ImageToolOutput = {
    model: "gpt-image-2",
    workspace_root: "C:/workspace",
    relative_path: relativePath,
    absolute_path: `C:/workspace/${relativePath}`,
    requested_size: "1024x1024",
    actual_width: 1024,
    actual_height: 1024,
    format: "png",
    mime_type: "image/png",
    size_bytes: 1,
    quality: "auto",
    preview_included: false,
    warnings: ["SNAPSHOT_CLEANUP_PENDING"],
  };

  const result = toMcpSuccess(output);
  const textContent = result.content[0];
  assert.equal(textContent?.type, "text");
  if (textContent?.type !== "text") {
    return;
  }

  assert.equal(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(
      textContent.text,
    ),
    false,
  );
  assert.ok(
    textContent.text.includes(
      `\`\` outputs/line\\u000a\\u0085\\u2028\\u2029\\u202e[click](${markdownTarget})\`name\`.png \`\``,
    ),
  );
  assert.equal(result.structuredContent?.relative_path, relativePath);
  assert.equal(result.structuredContent?.absolute_path, output.absolute_path);
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

// Runs a tool against the real snapshotter, publisher, and default output path
// so provider bytes pass through the production inspectors.
async function withRealLifecycle(
  run: (fixture: {
    root: string;
    roots: WorkspaceRootRegistry;
    operations: ToolOperations;
    config: RuntimeConfig;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), "gpt-image-tools-real-"));
  const root = path.join(base, "workspace");
  const pluginDataRoot = path.join(base, "plugin-data");
  await mkdir(root, { recursive: true });
  const roots = new WorkspaceRootRegistry();
  await roots.replace([root]);
  try {
    await run({
      root,
      roots,
      operations: makeOperations(new WorkspacePaths(roots), {
        snapshotInputs,
        publishOutput,
        makeDefaultOutputPath: (format) => makeDefaultOutputPath(format),
      }),
      config: configuredRuntime({ pluginDataRoot }),
    });
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

const EXTENSION_MISMATCH_MESSAGE =
  "INVALID_INPUT: Output filename extension must match the requested image format";

test("generate GIF without a size sends auto and frame fields and publishes an animated GIF with a GIF preview", async () => {
  await withRealLifecycle(async ({ roots, operations, config }) => {
    const gif = makeGif({ width: 16, height: 16, frames: 3 });
    const gifBase64 = gif.toString("base64");
    const provider = new FakeProvider(async () => ({ base64: gifBase64 }));
    const context = makeContext(roots, provider, operations, config);

    const result = await generateImage(
      generateImageSchema.parse({
        prompt: "animate a bouncing ball",
        output_format: "gif",
        frame_count: 3,
        frame_duration_ms: 150,
        output_compression: 0,
        output_path: "outputs/bounce.gif",
      }),
      context,
    );

    assert.deepEqual(provider.generateRequests, [
      {
        model: "gpt-image-2.6-flare",
        prompt: "animate a bouncing ball",
        quality: "high",
        size: "auto",
        output_format: "gif",
        background: "auto",
        moderation: "auto",
        frame_count: 3,
        frame_duration_ms: 150,
      },
    ]);
    assert.deepEqual(await readFile(result.absolute_path), gif);
    assert.equal(result.relative_path, "outputs/bounce.gif");
    assert.equal(result.format, "gif");
    assert.equal(result.mime_type, "image/gif");
    assert.equal(result.actual_width, 16);
    assert.equal(result.actual_height, 16);
    assert.equal(result.actual_frame_count, 3);
    assert.equal(result.requested_size, "auto");
    assert.equal(result.size_bytes, gif.length);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.preview_included, true);
    assert.deepEqual(result.preview, { data: gifBase64, mimeType: "image/gif" });

    const mcp = toMcpSuccess(result);
    assert.deepEqual(mcp.content, [
      {
        type: "text",
        text: `Saved gpt-image-2.6-flare image to \` outputs/bounce.gif \` (16x16, gif, 3 frames, ${gif.length} bytes).`,
      },
      { type: "image", data: gifBase64, mimeType: "image/gif" },
    ]);
    const structured = mcp.structuredContent ?? {};
    assert.equal(structured.format, "gif");
    assert.equal(structured.mime_type, "image/gif");
    assert.equal(structured.actual_frame_count, 3);
    assert.equal(structured.preview_included, true);
    assert.equal(JSON.stringify(structured).includes(gifBase64), false);
  });
});

test("GIF sizes below the raster pixel minimum are compared per frame and only warn on mismatch", async () => {
  await withRealLifecycle(async ({ roots, operations, config }) => {
    const gif = makeGif({ width: 16, height: 16, frames: 2 });
    const provider = new FakeProvider(async () => ({ base64: gif.toString("base64") }));
    const context = makeContext(roots, provider, operations, config);

    const matching = await generateImage(
      generateImageSchema.parse({
        prompt: "small animation",
        output_format: "gif",
        size: "16x16",
        output_path: "outputs/match.gif",
      }),
      context,
    );
    assert.deepEqual(matching.warnings, []);
    assert.equal(matching.requested_size, "16x16");

    const mismatched = await generateImage(
      generateImageSchema.parse({
        prompt: "small animation",
        output_format: "gif",
        size: "32x32",
        output_path: "outputs/mismatch.gif",
      }),
      context,
    );
    assert.deepEqual(mismatched.warnings, ["SIZE_MISMATCH"]);
    assert.equal(mismatched.requested_size, "32x32");
    assert.equal(mismatched.actual_frame_count, 2);
    assert.equal(provider.generateRequests[1]!.size, "32x32");
  });
});

test("generate SVG publishes a .svg file with no inline preview and no SIZE_MISMATCH", async () => {
  await withRealLifecycle(async ({ roots, operations, config }) => {
    const svg = makeSvg('<rect width="64" height="32"/>');
    const provider = new FakeProvider(async () => ({ base64: svg.toString("base64") }));
    const context = makeContext(roots, provider, operations, config);

    const result = await generateImage(
      generateImageSchema.parse({
        prompt: "draw a vector badge",
        output_format: "svg",
        output_compression: 0,
      }),
      context,
    );

    assert.equal(provider.generateRequests.length, 1);
    const request = provider.generateRequests[0]!;
    assert.equal(request.output_format, "svg");
    assert.equal(request.size, "1024x1024");
    assert.equal("output_compression" in request, false);
    assert.equal("frame_count" in request, false);
    assert.equal("frame_duration_ms" in request, false);

    assert.match(
      result.relative_path,
      /^\.claude\/generated-images\/gpt-image\/\d{8}-\d{6}-[0-9a-f]{8}\.svg$/,
    );
    assert.deepEqual(await readFile(result.absolute_path), svg);
    assert.equal(result.format, "svg");
    assert.equal(result.mime_type, "image/svg+xml");
    assert.equal(result.actual_width, 64);
    assert.equal(result.actual_height, 32);
    assert.equal(result.requested_size, "1024x1024");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.preview_included, false);
    assert.equal("preview" in result, false);
    assert.equal("actual_frame_count" in result, false);

    const mcp = toMcpSuccess(result);
    assert.deepEqual(mcp.content, [
      {
        type: "text",
        text: `Saved gpt-image-2.6-flare image to \` ${result.relative_path} \` (64x32, svg, ${svg.length} bytes).`,
      },
    ]);
    const structured = mcp.structuredContent ?? {};
    assert.equal(structured.format, "svg");
    assert.equal(structured.mime_type, "image/svg+xml");
    assert.equal(structured.preview_included, false);
    assert.deepEqual(structured.warnings, []);
    assert.equal("actual_frame_count" in structured, false);
  });
});

test("a provider SVG with a script element fails as INVALID_PROVIDER_RESPONSE and leaves no output file", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    const provider = new FakeProvider(async () => ({
      base64: makeSvg("<script>alert(1)</script>").toString("base64"),
    }));
    const context = makeContext(roots, provider, operations, config);

    await assert.rejects(
      () =>
        generateImage(
          generateImageSchema.parse({
            prompt: "draw a vector badge",
            output_format: "svg",
            output_path: "outputs/unsafe.svg",
          }),
          context,
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "INVALID_PROVIDER_RESPONSE" &&
        error.message ===
          "INVALID_PROVIDER_RESPONSE: Provider image payload failed validation",
    );
    assert.equal(provider.generateRequests.length, 1);
    await assert.rejects(
      () => access(path.join(root, "outputs", "unsafe.svg")),
      { code: "ENOENT" },
    );
    assert.deepEqual(await readdir(path.join(root, "outputs")), []);
  });
});

test("provider PNG bytes for an SVG request name both formats in the error result and leave no output file", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    const provider = new FakeProvider(async () => ({
      base64: makePng().toString("base64"),
    }));
    const context = makeContext(roots, provider, operations, config);

    let caught: unknown;
    try {
      await generateImage(
        generateImageSchema.parse({
          prompt: "draw a vector badge",
          output_format: "svg",
          output_path: "outputs/badge.svg",
        }),
        context,
      );
    } catch (error) {
      caught = error;
    }

    const expected =
      "INVALID_PROVIDER_RESPONSE: Provider returned png output, but svg was requested";
    assert.ok(caught instanceof AppError);
    assert.equal(caught.code, "INVALID_PROVIDER_RESPONSE");
    assert.equal(caught.message, expected);
    const result = toMcpError(caught);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: expected }]);
    assert.deepEqual(result.structuredContent, {
      isError: true,
      code: "INVALID_PROVIDER_RESPONSE",
      message: expected,
    });
    assert.equal(provider.generateRequests.length, 1);
    await assert.rejects(
      () => access(path.join(root, "outputs", "badge.svg")),
      { code: "ENOENT" },
    );
    assert.deepEqual(await readdir(path.join(root, "outputs")), []);
  });
});

test("GIF and SVG outputs require matching extensions before the provider is called", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    await writeFile(path.join(root, "first.png"), makePng({ width: 16, height: 16 }));
    const provider = new FakeProvider();
    const context = makeContext(roots, provider, operations, config);
    const isExtensionMismatch = (error: unknown) =>
      error instanceof AppError &&
      error.code === "INVALID_INPUT" &&
      error.message === EXTENSION_MISMATCH_MESSAGE;

    for (const [output_format, output_path] of [
      ["gif", "a.png"],
      ["gif", "outputs/a.svg"],
      ["svg", "a.gif"],
      ["svg", "outputs/a.png"],
      ["png", "a.gif"],
      ["png", "a.svg"],
    ] as const) {
      await assert.rejects(
        () =>
          generateImage(
            generateImageSchema.parse({ prompt: "p", output_format, output_path }),
            context,
          ),
        isExtensionMismatch,
      );
    }
    for (const output_path of ["a.png", "a.svg"]) {
      await assert.rejects(
        () =>
          editImage(
            editImageSchema.parse({
              prompt: "p",
              image_paths: ["first.png"],
              output_format: "gif",
              output_path,
            }),
            context,
          ),
        isExtensionMismatch,
      );
    }

    assert.equal(provider.generateRequests.length, 0);
    assert.equal(provider.editRequests.length, 0);
  });
});

test("edit rejects GIF and SVG files in image_paths as INPUT_FILE_INVALID before the provider is called", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(root, "inputs", "first.png"),
        makePng({ width: 16, height: 16 }),
      ),
      writeFile(path.join(root, "inputs", "anim.gif"), makeGif({ frames: 2 })),
      writeFile(path.join(root, "inputs", "vector.svg"), makeSvg()),
    ]);
    const provider = new FakeProvider();
    const context = makeContext(roots, provider, operations, config);

    for (const image_paths of [
      ["inputs/anim.gif"],
      ["inputs/vector.svg"],
      ["inputs/first.png", "inputs/anim.gif"],
      ["inputs/first.png", "inputs/vector.svg"],
    ]) {
      for (const output_format of ["png", "gif"] as const) {
        await assert.rejects(
          () =>
            editImage(
              editImageSchema.parse({
                prompt: "p",
                image_paths,
                output_format,
                output_path: `outputs/edited.${output_format}`,
              }),
              context,
            ),
          hasCode("INPUT_FILE_INVALID"),
        );
      }
    }

    assert.equal(provider.editRequests.length, 0);
    for (const output of ["edited.png", "edited.gif"]) {
      await assert.rejects(() => access(path.join(root, "outputs", output)), {
        code: "ENOENT",
      });
    }
  });
});

test("edit GIF forwards frame fields and the auto size and publishes the animated output", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(
      path.join(root, "inputs", "first.png"),
      makePng({ width: 16, height: 16 }),
    );
    const gif = makeGif({ width: 16, height: 16, frames: 2 });
    const provider = new FakeProvider(undefined, async () => ({
      base64: gif.toString("base64"),
    }));
    const context = makeContext(roots, provider, operations, config);

    const result = await editImage(
      editImageSchema.parse({
        prompt: "animate the input",
        image_paths: ["inputs/first.png"],
        output_format: "gif",
        frame_count: 2,
        complexity: "low",
        output_path: "outputs/edited.gif",
      }),
      context,
    );

    assert.equal(provider.editRequests.length, 1);
    const request = provider.editRequests[0]!;
    assert.equal(request.output_format, "gif");
    assert.equal(request.size, "auto");
    assert.equal(request.frame_count, 2);
    assert.equal(request.complexity, "low");
    assert.equal("frame_duration_ms" in request, false);
    assert.equal("output_compression" in request, false);
    assert.equal("mask" in request, false);
    assert.deepEqual(
      request.images.map((image) => image.info.mimeType),
      ["image/png"],
    );

    assert.equal(result.format, "gif");
    assert.equal(result.mime_type, "image/gif");
    assert.equal(result.actual_frame_count, 2);
    assert.equal(result.preview?.mimeType, "image/gif");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await readFile(result.absolute_path), gif);
  });
});

test("edit validates real markup layers: exact PNG and transposed JPEG or WebP matches upload; transposed PNG, opaque, and JPEG layers are rejected", async () => {
  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    await mkdir(path.join(root, "inputs"), { recursive: true });
    // The JPEG and WebP fixtures are 3x2, so a 2x3 layer is their transpose.
    const exactMarkup = makePng({ width: 16, height: 32 });
    await Promise.all([
      writeFile(
        path.join(root, "inputs", "first.png"),
        makePng({ width: 16, height: 32 }),
      ),
      writeFile(path.join(root, "inputs", "photo.jpeg"), makeBaselineJpeg()),
      writeFile(path.join(root, "inputs", "photo.webp"), makeLossyWebP()),
      writeFile(path.join(root, "inputs", "markup.png"), exactMarkup),
      writeFile(
        path.join(root, "inputs", "transposed.png"),
        makePng({ width: 32, height: 16 }),
      ),
      writeFile(
        path.join(root, "inputs", "rotated.png"),
        makePng({ width: 2, height: 3 }),
      ),
      writeFile(
        path.join(root, "inputs", "opaque.png"),
        makePng({ width: 16, height: 32, colorType: 2 }),
      ),
    ]);
    const edited = makePng({ width: 16, height: 32 });
    const provider = new FakeProvider(undefined, async () => ({
      base64: edited.toString("base64"),
    }));
    const context = makeContext(roots, provider, operations, config);
    const parseMarkupEdit = (
      firstImage: string,
      markup_path: string,
      output_path: string,
    ) =>
      editImageSchema.parse({
        prompt: "follow the markup",
        image_paths: [firstImage],
        markup_path,
        size: "auto",
        output_path,
      });

    const result = await editImage(
      parseMarkupEdit("inputs/first.png", "inputs/markup.png", "outputs/edited.png"),
      context,
    );
    assert.equal(provider.editRequests.length, 1);
    const request = provider.editRequests[0]!;
    assert.equal(request.model, "gpt-image-2.6-flare");
    assert.equal(request.markup?.filename, "markup.png");
    assert.equal(request.markup?.info.mimeType, "image/png");
    assert.equal(request.markup?.sizeBytes, exactMarkup.length);
    assert.equal("mask" in request, false);
    assert.equal(result.format, "png");
    assert.deepEqual(await readFile(result.absolute_path), edited);

    for (const [firstImage, mimeType] of [
      ["inputs/photo.jpeg", "image/jpeg"],
      ["inputs/photo.webp", "image/webp"],
    ] as const) {
      const extension = path.extname(firstImage).slice(1);
      await editImage(
        parseMarkupEdit(
          firstImage,
          "inputs/rotated.png",
          `outputs/edited-${extension}.png`,
        ),
        context,
      );
      const rotatedRequest = provider.editRequests.at(-1)!;
      assert.equal(rotatedRequest.images[0]!.info.mimeType, mimeType);
      assert.equal(rotatedRequest.markup?.filename, "rotated.png");
    }
    assert.equal(provider.editRequests.length, 3);

    for (const [markup_path, message] of [
      ["inputs/transposed.png", MARKUP_DIMENSION_MESSAGE],
      [
        "inputs/opaque.png",
        "INPUT_FILE_INVALID: Edit markup PNG must contain an alpha channel",
      ],
      ["inputs/photo.jpeg", "INPUT_FILE_INVALID: Edit markup must be a PNG image"],
    ] as const) {
      await assert.rejects(
        () =>
          editImage(
            parseMarkupEdit("inputs/first.png", markup_path, "outputs/rejected.png"),
            context,
          ),
        (error: unknown) =>
          error instanceof AppError && error.message === message,
        markup_path,
      );
    }
    assert.equal(provider.editRequests.length, 3);
    await assert.rejects(
      () => access(path.join(root, "outputs", "rejected.png")),
      { code: "ENOENT" },
    );
  });
});

test("a requested size that cannot be parsed never discards a published result or adds SIZE_MISMATCH", async () => {
  await withWorkspace(async ({ roots, paths }) => {
    const provider = new FakeProvider();
    const { publisher, state } = createPublisher();
    const context = makeContext(
      roots,
      provider,
      makeOperations(paths, { publishOutput: publisher }),
    );

    for (const [index, size] of ["100x100", "not-a-size"].entries()) {
      const result = await generateImage(
        {
          ...generateInput,
          size: size as GenerateImageInput["size"],
          output_path: `outputs/unparsed-${index}.png`,
        },
        context,
      );
      assert.equal(result.requested_size, size);
      assert.equal(result.relative_path, `outputs/unparsed-${index}.png`);
      assert.deepEqual(result.warnings, []);
    }
    assert.equal(state.calls.length, 2);
  });

  await withRealLifecycle(async ({ root, roots, operations, config }) => {
    const gif = makeGif({ width: 16, height: 16, frames: 2 });
    const provider = new FakeProvider(async () => ({
      base64: gif.toString("base64"),
    }));

    const result = await generateImage(
      {
        ...generateInput,
        model: "gpt-image-2.6-flare",
        output_format: "gif",
        size: "100x100",
        output_path: "outputs/unparsed.gif",
      },
      makeContext(roots, provider, operations, config),
    );

    assert.equal(provider.generateRequests[0]!.size, "100x100");
    assert.equal(result.format, "gif");
    assert.equal(result.requested_size, "100x100");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      await readFile(path.join(root, "outputs", "unparsed.gif")),
      gif,
    );
  });
});

test("toMcpSuccess says 1 frame for a single-frame GIF and N frames otherwise", async () => {
  await withRealLifecycle(async ({ roots, operations, config }) => {
    for (const [frames, wording] of [
      [1, "1 frame"],
      [2, "2 frames"],
    ] as const) {
      const gif = makeGif({ width: 16, height: 16, frames });
      const provider = new FakeProvider(async () => ({
        base64: gif.toString("base64"),
      }));
      const result = await generateImage(
        generateImageSchema.parse({
          prompt: "count the frames",
          output_format: "gif",
          output_path: `outputs/frames-${frames}.gif`,
        }),
        makeContext(roots, provider, operations, config),
      );

      assert.equal(result.actual_frame_count, frames);
      assert.deepEqual(toMcpSuccess(result).content[0], {
        type: "text",
        text: `Saved gpt-image-2.6-flare image to \` outputs/frames-${frames}.gif \` (16x16, gif, ${wording}, ${gif.length} bytes).`,
      });
    }
  });
});
