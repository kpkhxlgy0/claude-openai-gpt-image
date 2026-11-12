import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  PAID_CALL_MAX_PENDING,
  processPaidCallGate,
  Semaphore,
} from "../src/concurrency.ts";
import type { OutputPublisher } from "../src/files/atomic-output.ts";
import type { InputSnapshotter } from "../src/files/input-snapshot.ts";
import { WorkspacePaths } from "../src/files/workspace-paths.ts";
import type { RuntimeConfig } from "../src/config/environment.ts";
import { AppError } from "../src/errors.ts";
import { WorkspaceRootRegistry } from "../src/files/workspace-roots.ts";
import { createSafeLogger } from "../src/logger.ts";
import type {
  ImageProvider,
  ProviderEditRequest,
  ProviderGenerateRequest,
  ProviderImage,
} from "../src/openai/types.ts";
import { createProcessToolContext } from "../src/process-context.ts";
import { createImageServer } from "../src/server.ts";
import type { ToolContext, ToolOperations } from "../src/tools/types.ts";
import { makeGif, makePng, makeSvg } from "./helpers/image-fixtures.ts";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function assertExactOutputSchema(
  outputSchema: unknown,
  successRequired: readonly string[],
): void {
  const schema = asRecord(outputSchema);
  assert.equal(schema.type, "object");
  const branches = asArray(schema.oneOf).map(asRecord);
  assert.equal(branches.length, 2);

  const success = branches.find((branch) => {
    const properties = asRecord(branch.properties);
    return "model" in properties;
  });
  const failure = branches.find((branch) => {
    const properties = asRecord(branch.properties);
    return "isError" in properties;
  });
  assert.ok(success);
  assert.ok(failure);
  assert.deepEqual(
    asArray(success.required).map(String).sort(),
    [...successRequired].sort(),
  );
  assert.equal(success.additionalProperties, false);
  assert.deepEqual(
    asArray(failure.required).map(String).sort(),
    ["code", "isError", "message"],
  );
  assert.equal(failure.additionalProperties, false);
}

function makeContext(
  roots: WorkspaceRootRegistry,
  config: RuntimeConfig,
): ToolContext {
  return {
    config,
    roots,
    paidCallGate: new Semaphore(1),
    serverVersion: "0.1.0-test",
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTemporaryRoots(
  count: number,
  run: (roots: readonly string[]) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(path.join(tmpdir(), "gpt-image-protocol-"));
  const roots = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const directory = path.join(parent, `root-${index}`);
      await mkdir(directory, { recursive: true });
      return directory;
    }),
  );
  try {
    await run(roots);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

interface ConnectedProtocol {
  readonly client: Client;
  close(): Promise<void>;
}

async function connectProtocol(options: {
  readonly context: ToolContext;
  readonly environmentRoot?: string;
  readonly logs: string[];
  readonly clientRoots?: () => readonly string[];
  readonly beforeListRoots?: () => Promise<void>;
}): Promise<ConnectedProtocol> {
  const logger = createSafeLogger((line) => options.logs.push(line));
  const server = createImageServer({
    context: options.context,
    logger,
    ...(options.environmentRoot === undefined
      ? {}
      : { environmentRoot: options.environmentRoot }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "protocol-test-client", version: "1.0.0" },
    options.clientRoots === undefined
      ? { capabilities: {} }
      : { capabilities: { roots: { listChanged: true } } },
  );
  if (options.clientRoots !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      await options.beforeListRoots?.();
      return {
        roots: options.clientRoots!().map((root) => ({
          uri: pathToFileURL(root).href,
          name: path.basename(root),
        })),
      };
    });
  }

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

test("initialize without an API key exposes exactly three correctly annotated tools and schemas", async () => {
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    const logs: string[] = [];
    const protocol = await connectProtocol({
      context: makeContext(roots, {
        apiKeyConfigured: false,
        baseUrl: "https://api.openai.com/v1",
        baseUrlConfigured: false,
        workspaceRoot: environmentRoot,
      }),
      environmentRoot,
      logs,
    });

    try {
      const listed = await protocol.client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        ["edit_image", "generate_image", "get_status"],
      );

      const status = listed.tools.find((tool) => tool.name === "get_status");
      const generate = listed.tools.find((tool) => tool.name === "generate_image");
      const edit = listed.tools.find((tool) => tool.name === "edit_image");
      assert.ok(status);
      assert.ok(generate);
      assert.ok(edit);
      assert.equal(protocol.client.getServerVersion()?.name, "gpt-image");
      assert.equal(status.title, "Get GPT Image status");
      assert.equal(
        generate.description,
        "Generate one image with the selected GPT Image model (default gpt-image-2.6-flare) and publish it as a new file inside an approved workspace root.",
      );

      assert.equal(status.annotations?.readOnlyHint, true);
      assert.equal(status.annotations?.destructiveHint, false);
      assert.equal(status.annotations?.idempotentHint, true);
      assert.equal(status.annotations?.openWorldHint, false);
      for (const tool of [generate, edit]) {
        assert.equal(tool.annotations?.readOnlyHint, false);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.annotations?.idempotentHint, false);
        assert.equal(tool.annotations?.openWorldHint, true);
      }

      const statusInput = asRecord(status.inputSchema);
      assert.equal(statusInput.type, "object");
      assert.deepEqual(statusInput.properties, {});
      assert.equal(statusInput.additionalProperties, false);

      const generateInput = asRecord(generate.inputSchema);
      const generateProperties = asRecord(generateInput.properties);
      assert.deepEqual(Object.keys(generateProperties).sort(), [
        "background",
        "complexity",
        "frame_count",
        "frame_duration_ms",
        "model",
        "moderation",
        "output_compression",
        "output_format",
        "output_path",
        "prompt",
        "quality",
        "size",
        "workspace_root",
      ]);
      assert.deepEqual(generateInput.required, ["prompt"]);
      assert.equal(generateInput.additionalProperties, false);

      const editInput = asRecord(edit.inputSchema);
      const editProperties = asRecord(editInput.properties);
      assert.deepEqual(Object.keys(editProperties).sort(), [
        "background",
        "complexity",
        "frame_count",
        "frame_duration_ms",
        "image_paths",
        "markup_path",
        "mask_path",
        "model",
        "output_compression",
        "output_format",
        "output_path",
        "prompt",
        "quality",
        "size",
        "workspace_root",
      ]);
      assert.deepEqual(editInput.required, ["prompt", "image_paths"]);
      assert.equal(editInput.additionalProperties, false);
      const markupPath = asRecord(editProperties.markup_path);
      assert.equal(markupPath.type, "string");
      assert.equal(markupPath.minLength, 1);
      assert.equal("default" in markupPath, false);
      assert.equal("markup_path" in generateProperties, false);

      for (const properties of [generateProperties, editProperties]) {
        const model = asRecord(properties.model);
        assert.deepEqual(asArray(model.enum), [
          "gpt-image-2",
          "gpt-image-2.5-sunburst",
          "gpt-image-2.5-flare",
          "gpt-image-2.6-sunburst",
          "gpt-image-2.6-flare",
        ]);
        assert.equal(model.default, "gpt-image-2.6-flare");
        const complexity = asRecord(properties.complexity);
        assert.equal(complexity.type, "string");
        assert.deepEqual(asArray(complexity.enum), ["low", "medium", "high"]);
        assert.equal("default" in complexity, false);
        const quality = asRecord(properties.quality);
        assert.deepEqual(asArray(quality.enum), [
          "auto",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
        assert.equal(quality.default, "high");
        const background = asRecord(properties.background);
        assert.deepEqual(asArray(background.enum), [
          "auto",
          "opaque",
          "transparent",
        ]);
        assert.equal(background.default, "auto");
        // The GIF size default is injected before validation, so the
        // advertised default stays the raster default.
        const size = asRecord(properties.size);
        assert.equal(size.type, "string");
        assert.equal(size.default, "1024x1024");
        const frameCount = asRecord(properties.frame_count);
        assert.equal(frameCount.type, "integer");
        assert.equal(frameCount.minimum, 2);
        assert.equal(frameCount.maximum, 16);
        assert.equal("default" in frameCount, false);
        const frameDuration = asRecord(properties.frame_duration_ms);
        assert.equal(frameDuration.type, "integer");
        assert.equal(frameDuration.minimum, 20);
        assert.equal(frameDuration.maximum, 2000);
        assert.equal("default" in frameDuration, false);
      }
      const generateOutputFormat = asRecord(generateProperties.output_format);
      assert.deepEqual(asArray(generateOutputFormat.enum), [
        "png",
        "jpeg",
        "webp",
        "gif",
        "svg",
      ]);
      assert.equal(generateOutputFormat.default, "png");
      const editOutputFormat = asRecord(editProperties.output_format);
      assert.deepEqual(asArray(editOutputFormat.enum), [
        "png",
        "jpeg",
        "webp",
        "gif",
      ]);
      assert.equal(editOutputFormat.default, "png");

      const statusOutputSchema = JSON.stringify(status.outputSchema);
      assert.match(statusOutputSchema, /api_key_configured/);
      assert.match(statusOutputSchema, /workspace_roots/);
      assert.match(statusOutputSchema, /isError/);
      assert.match(statusOutputSchema, /INTERNAL_ERROR/);
      assertExactOutputSchema(status.outputSchema, [
        "model",
        "api_key_configured",
        "base_url_configured",
        "base_url_valid",
        "workspace_roots",
        "default_relative_output_dir",
        "server_version",
      ]);

      const imageSuccessRequired = [
        "model",
        "workspace_root",
        "relative_path",
        "absolute_path",
        "requested_size",
        "actual_width",
        "actual_height",
        "format",
        "mime_type",
        "size_bytes",
        "quality",
        "preview_included",
        "warnings",
      ];
      for (const tool of [generate, edit]) {
        const outputSchema = JSON.stringify(tool.outputSchema);
        assert.match(outputSchema, /relative_path/);
        assert.match(outputSchema, /actual_width/);
        assert.match(outputSchema, /warnings/);
        assert.match(outputSchema, /isError/);
        assert.doesNotMatch(outputSchema, /\"preview\"/);
        const imageSchema = asRecord(tool.outputSchema);
        const success = asArray(imageSchema.oneOf)
          .map(asRecord)
          .find((branch) => "model" in asRecord(branch.properties));
        assert.ok(success);
        assert.deepEqual(
          asArray(asRecord(asRecord(success.properties).model).enum),
          [
            "gpt-image-2",
            "gpt-image-2.5-sunburst",
            "gpt-image-2.5-flare",
            "gpt-image-2.6-sunburst",
            "gpt-image-2.6-flare",
          ],
        );
        assert.deepEqual(
          asArray(asRecord(asRecord(success.properties).quality).enum),
          ["auto", "low", "medium", "high", "xhigh", "max"],
        );
        assert.deepEqual(
          asArray(asRecord(asRecord(success.properties).format).enum),
          ["png", "jpeg", "webp", "gif", "svg"],
        );
        assert.deepEqual(
          asArray(asRecord(asRecord(success.properties).mime_type).enum),
          ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"],
        );
        const frameCountOutput = asRecord(
          asRecord(success.properties).actual_frame_count,
        );
        assert.equal(frameCountOutput.type, "integer");
        assert.equal(frameCountOutput.exclusiveMinimum, 0);
        const warningSchema = asRecord(
          asRecord(asRecord(success.properties).warnings).items,
        );
        assert.deepEqual(
          asArray(warningSchema.enum).map(String).sort(),
          [
            "SIZE_MISMATCH",
            "SNAPSHOT_CLEANUP_PENDING",
            "TEMP_CLEANUP_PENDING",
          ].sort(),
        );
        assertExactOutputSchema(tool.outputSchema, imageSuccessRequired);
      }

      const statusResult = await protocol.client.callTool({
        name: "get_status",
      });
      assert.equal(statusResult.isError, undefined);
      assert.deepEqual(statusResult.structuredContent, {
        model: "gpt-image-2.6-flare",
        api_key_configured: false,
        base_url_configured: false,
        base_url_valid: true,
        workspace_roots: [await realpath(environmentRoot)],
        default_relative_output_dir: ".claude/generated-images/gpt-image",
        server_version: "0.1.0-test",
      });
      assert.equal(
        asRecord(asArray(statusResult.content)[0]).text,
        "GPT Image status: API key not configured; 1 approved workspace root(s).",
      );
      const statusSuccess = asArray(asRecord(status.outputSchema).oneOf)
        .map(asRecord)
        .find((branch) => "model" in asRecord(branch.properties));
      assert.ok(statusSuccess);
      assert.equal(
        asRecord(asRecord(statusSuccess.properties).model).const,
        "gpt-image-2.6-flare",
      );
    } finally {
      await protocol.close();
    }
  });
});

test("invalid inputs and missing configuration return stable sanitized structured errors without logging secrets", async () => {
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    const logs: string[] = [];
    const secretPrompt = "PROMPT_SECRET_DO_NOT_LOG";
    const secretKey = "API_KEY_SECRET_DO_NOT_LOG";
    const secretBaseUrl = "https://secret-provider.example.invalid/v1";
    const protocol = await connectProtocol({
      context: makeContext(roots, {
        apiKeyConfigured: true,
        apiKey: secretKey,
        baseUrl: secretBaseUrl,
        baseUrlConfigured: true,
        workspaceRoot: environmentRoot,
      }),
      environmentRoot,
      logs,
    });

    try {
      const invalid = await protocol.client.callTool({
        name: "generate_image",
        arguments: {
          prompt: "valid prompt",
          output_format: "png",
          output_compression: 1,
        },
      });
      assert.equal(invalid.isError, true);
      assert.deepEqual(invalid.structuredContent, {
        isError: true,
        code: "INVALID_INPUT",
        message:
          "INVALID_INPUT: output_compression is not supported for PNG except the ignored zero default",
      });

      for (const [toolName, extraArguments] of [
        ["generate_image", {}],
        ["edit_image", { image_paths: ["input.png"] }],
      ] as const) {
        const transparentGptImage2 = await protocol.client.callTool({
          name: toolName,
          arguments: {
            prompt: "valid prompt",
            model: "gpt-image-2",
            background: "transparent",
            ...extraArguments,
          },
        });
        assert.equal(transparentGptImage2.isError, true);
        assert.deepEqual(transparentGptImage2.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message:
            'INVALID_INPUT: background "transparent" requires model gpt-image-2.5-sunburst or gpt-image-2.5-flare or gpt-image-2.6-sunburst or gpt-image-2.6-flare',
        });

        for (const quality of ["xhigh", "max"] as const) {
          const extendedQualityGptImage2 = await protocol.client.callTool({
            name: toolName,
            arguments: {
              prompt: "valid prompt",
              model: "gpt-image-2",
              quality,
              ...extraArguments,
            },
          });
          assert.equal(extendedQualityGptImage2.isError, true);
          assert.deepEqual(extendedQualityGptImage2.structuredContent, {
            isError: true,
            code: "INVALID_INPUT",
            message: `INVALID_INPUT: quality "${quality}" requires model gpt-image-2.5-sunburst or gpt-image-2.5-flare or gpt-image-2.6-sunburst or gpt-image-2.6-flare`,
          });
        }

        // No provider is configured here, so INVALID_INPUT proves the
        // complexity rule fails before any provider call.
        for (const model of ["gpt-image-2", "gpt-image-2.5-flare"] as const) {
          const complexityNon26 = await protocol.client.callTool({
            name: toolName,
            arguments: {
              prompt: "valid prompt",
              model,
              complexity: "medium",
              ...extraArguments,
            },
          });
          assert.equal(complexityNon26.isError, true);
          assert.deepEqual(complexityNon26.structuredContent, {
            isError: true,
            code: "INVALID_INPUT",
            message:
              "INVALID_INPUT: complexity requires model gpt-image-2.6-sunburst or gpt-image-2.6-flare",
          });
        }

        const unknownComplexity = await protocol.client.callTool({
          name: toolName,
          arguments: {
            prompt: "valid prompt",
            complexity: "extreme",
            ...extraArguments,
          },
        });
        assert.equal(unknownComplexity.isError, true);
        assert.deepEqual(unknownComplexity.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message: "INVALID_INPUT: Image tool input is invalid",
        });

        // The default model accepts these values, so validation passes and the
        // call stops at CONFIG_MISSING because this context has no provider.
        const defaultModelExtended = await protocol.client.callTool({
          name: toolName,
          arguments: {
            prompt: "valid prompt",
            background: "transparent",
            quality: "max",
            complexity: "low",
            ...extraArguments,
          },
        });
        assert.equal(defaultModelExtended.isError, true);
        assert.equal(
          asRecord(defaultModelExtended.structuredContent).code,
          "CONFIG_MISSING",
        );

        const transparentJpeg = await protocol.client.callTool({
          name: toolName,
          arguments: {
            prompt: "valid prompt",
            model: "gpt-image-2.5-sunburst",
            background: "transparent",
            output_format: "jpeg",
            ...extraArguments,
          },
        });
        assert.equal(transparentJpeg.isError, true);
        assert.deepEqual(transparentJpeg.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message:
            'INVALID_INPUT: background "transparent" requires output_format "png" or "webp"',
        });

        const unknownModel = await protocol.client.callTool({
          name: toolName,
          arguments: {
            prompt: "valid prompt",
            model: "gpt-image-1",
            ...extraArguments,
          },
        });
        assert.equal(unknownModel.isError, true);
        assert.deepEqual(unknownModel.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message: "INVALID_INPUT: Image tool input is invalid",
        });

        // No provider is configured here, so INVALID_INPUT proves each GIF
        // rule fails before any provider call, and CONFIG_MISSING proves a
        // valid GIF request passes validation.
        const gifStructuredErrors: readonly [
          Record<string, unknown>,
          string,
        ][] = [
          [
            { model: "gpt-image-2.5-flare", output_format: "gif" },
            'INVALID_INPUT: output_format "gif" requires model gpt-image-2.6-sunburst or gpt-image-2.6-flare',
          ],
          [
            { frame_count: 4 },
            'INVALID_INPUT: frame_count and frame_duration_ms require output_format "gif"',
          ],
          [
            { output_format: "png", frame_duration_ms: 100 },
            'INVALID_INPUT: frame_count and frame_duration_ms require output_format "gif"',
          ],
          [
            { output_format: "gif", output_compression: 5 },
            "INVALID_INPUT: output_compression is not supported for GIF except the ignored zero default",
          ],
          [
            { output_format: "gif", background: "transparent" },
            'INVALID_INPUT: background "transparent" requires output_format "png" or "webp"',
          ],
          [{ size: "100x100" }, "INVALID_INPUT: Image tool input is invalid"],
          [
            { output_format: "gif", size: "100x100" },
            "INVALID_INPUT: Image tool input is invalid",
          ],
          [{ size: "256x256" }, "INVALID_INPUT: Image tool input is invalid"],
          [
            { output_format: "gif", frame_count: 17 },
            "INVALID_INPUT: Image tool input is invalid",
          ],
        ];
        for (const [fields, message] of gifStructuredErrors) {
          const gifInvalid = await protocol.client.callTool({
            name: toolName,
            arguments: { prompt: "valid prompt", ...fields, ...extraArguments },
          });
          assert.equal(gifInvalid.isError, true);
          assert.deepEqual(gifInvalid.structuredContent, {
            isError: true,
            code: "INVALID_INPUT",
            message,
          });
        }

        for (const fields of [
          { output_format: "gif" },
          {
            output_format: "gif",
            size: "256x256",
            frame_count: 16,
            frame_duration_ms: 20,
            output_compression: 0,
            complexity: "low",
          },
        ]) {
          const validGif = await protocol.client.callTool({
            name: toolName,
            arguments: { prompt: "valid prompt", ...fields, ...extraArguments },
          });
          assert.equal(validGif.isError, true);
          assert.equal(asRecord(validGif.structuredContent).code, "CONFIG_MISSING");
        }
      }

      for (const [fields, message] of [
        [
          { model: "gpt-image-2", output_format: "svg" },
          'INVALID_INPUT: output_format "svg" requires model gpt-image-2.6-sunburst or gpt-image-2.6-flare',
        ],
        [
          { output_format: "svg", output_compression: 30 },
          "INVALID_INPUT: output_compression is not supported for SVG except the ignored zero default",
        ],
        [
          { output_format: "svg", frame_count: 3 },
          'INVALID_INPUT: frame_count and frame_duration_ms require output_format "gif"',
        ],
      ] as const) {
        const svgInvalid = await protocol.client.callTool({
          name: "generate_image",
          arguments: { prompt: "valid prompt", ...fields },
        });
        assert.equal(svgInvalid.isError, true);
        assert.deepEqual(svgInvalid.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message,
        });
      }
      const validSvg = await protocol.client.callTool({
        name: "generate_image",
        arguments: { prompt: "valid prompt", output_format: "svg" },
      });
      assert.equal(asRecord(validSvg.structuredContent).code, "CONFIG_MISSING");

      const svgEdit = await protocol.client.callTool({
        name: "edit_image",
        arguments: {
          prompt: "valid prompt",
          image_paths: ["input.png"],
          output_format: "svg",
        },
      });
      assert.equal(svgEdit.isError, true);
      assert.deepEqual(svgEdit.structuredContent, {
        isError: true,
        code: "INVALID_INPUT",
        message: "INVALID_INPUT: Image tool input is invalid",
      });

      const gifMask = await protocol.client.callTool({
        name: "edit_image",
        arguments: {
          prompt: "valid prompt",
          image_paths: ["input.png"],
          mask_path: "mask.png",
          output_format: "gif",
        },
      });
      assert.equal(gifMask.isError, true);
      assert.deepEqual(gifMask.structuredContent, {
        isError: true,
        code: "INVALID_INPUT",
        message:
          'INVALID_INPUT: mask_path is not supported with output_format "gif"',
      });

      for (const [markupArguments, message] of [
        [
          { mask_path: "mask.png", markup_path: "markup.png" },
          "INVALID_INPUT: markup_path cannot be combined with mask_path",
        ],
        [
          { model: "gpt-image-2", markup_path: "markup.png" },
          "INVALID_INPUT: markup_path requires model gpt-image-2.5-sunburst or gpt-image-2.5-flare or gpt-image-2.6-sunburst or gpt-image-2.6-flare",
        ],
      ] as const) {
        const markupInvalid = await protocol.client.callTool({
          name: "edit_image",
          arguments: {
            prompt: "valid prompt",
            image_paths: ["input.png"],
            ...markupArguments,
          },
        });
        assert.equal(markupInvalid.isError, true);
        assert.deepEqual(markupInvalid.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message,
        });
      }
      const validMarkup = await protocol.client.callTool({
        name: "edit_image",
        arguments: {
          prompt: "valid prompt",
          image_paths: ["input.png"],
          markup_path: "markup.png",
          output_format: "gif",
        },
      });
      assert.equal(asRecord(validMarkup.structuredContent).code, "CONFIG_MISSING");

      for (const argumentsValue of [
        {},
        { prompt: 42 },
        { prompt: "valid prompt", unexpected: secretPrompt },
      ]) {
        const structuralInvalid = await protocol.client.callTool({
          name: "generate_image",
          arguments: argumentsValue,
        });
        assert.equal(structuralInvalid.isError, true);
        assert.deepEqual(structuralInvalid.structuredContent, {
          isError: true,
          code: "INVALID_INPUT",
          message: "INVALID_INPUT: Image tool input is invalid",
        });
      }

      for (const toolName of [
        "get_status",
        "generate_image",
        "edit_image",
      ] as const) {
        for (const argumentsValue of [null, [], "not-an-object", 7]) {
          const nonObjectInvalid = await protocol.client.callTool({
            name: toolName,
            arguments: argumentsValue as never,
          });
          assert.equal(nonObjectInvalid.isError, true);
          assert.deepEqual(nonObjectInvalid.structuredContent, {
            isError: true,
            code: "INVALID_INPUT",
            message: "INVALID_INPUT: Image tool input is invalid",
          });
        }
      }

      const missingProvider = await protocol.client.callTool({
        name: "generate_image",
        arguments: { prompt: secretPrompt },
      });
      assert.equal(missingProvider.isError, true);
      const structured = asRecord(missingProvider.structuredContent);
      assert.equal(structured.code, "CONFIG_MISSING");

      const captured = logs.join("");
      for (const forbidden of [
        secretPrompt,
        secretKey,
        secretBaseUrl,
        environmentRoot,
      ]) {
        assert.equal(captured.includes(forbidden), false);
      }
      for (const line of logs) {
        const entry = asRecord(JSON.parse(line));
        assert.equal(typeof entry.event, "string");
        for (const value of Object.values(entry)) {
          assert.notEqual(typeof value, "object");
        }
      }
    } finally {
      await protocol.close();
    }
  });
});

test("MCP cancellation aborts the in-flight provider signal", async () => {
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    let providerSignal: AbortSignal | undefined;
    let providerAborted = false;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let rejectProvider!: (error: unknown) => void;
    const provider: ImageProvider = {
      generate(
        _request: ProviderGenerateRequest,
        signal?: AbortSignal,
      ): Promise<ProviderImage> {
        providerSignal = signal;
        markProviderStarted();
        return new Promise((_resolve, reject) => {
          rejectProvider = reject;
          signal?.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      edit(
        _request: ProviderEditRequest,
        _signal?: AbortSignal,
      ): Promise<ProviderImage> {
        throw new Error("edit is not used in this test");
      },
    };
    const protocol = await connectProtocol({
      context: {
        ...makeContext(roots, {
          apiKeyConfigured: true,
          apiKey: "test-key-protocol-cancellation",
          baseUrl: "https://api.openai.com/v1",
          baseUrlConfigured: false,
          workspaceRoot: environmentRoot,
        }),
        provider,
      },
      environmentRoot,
      logs: [],
    });
    const controller = new AbortController();

    try {
      const callOutcome = protocol.client.callTool(
        {
          name: "generate_image",
          arguments: {
            prompt: "cancel this test request",
            output_path: "outputs/cancelled.png",
          },
        },
        undefined,
        { signal: controller.signal },
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      await providerStarted;
      controller.abort();
      const clientOutcome = await callOutcome;
      const abortDeadline = Date.now() + 250;
      while (!providerAborted && Date.now() < abortDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const observedSignal = providerSignal;
      const observedProviderAbort = providerAborted;
      if (!providerAborted) {
        rejectProvider(
          new AppError("PROVIDER_FAILURE", "protocol cancellation test released"),
        );
      }

      assert.ok(clientOutcome instanceof Error);
      assert.ok(observedSignal instanceof AbortSignal);
      assert.equal(observedSignal.aborted, true);
      assert.equal(observedProviderAbort, true);
    } finally {
      if (!providerAborted && rejectProvider !== undefined) {
        rejectProvider(
          new AppError("PROVIDER_FAILURE", "protocol cancellation test cleanup"),
        );
      }
      await protocol.close();
    }
  });
});

// Drives one generate_image call through tools/call with an injected provider
// that returns fixed bytes. listTools runs first so the SDK client checks the
// structured result against the advertised output schema.
async function callGenerateWithProvider(
  base64: string,
  toolArguments: Record<string, unknown>,
): Promise<{
  readonly requests: readonly ProviderGenerateRequest[];
  readonly result: Awaited<ReturnType<Client["callTool"]>>;
  readonly savedBytes: Buffer;
}> {
  let outcome:
    | {
        requests: readonly ProviderGenerateRequest[];
        result: Awaited<ReturnType<Client["callTool"]>>;
        savedBytes: Buffer;
      }
    | undefined;
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    const requests: ProviderGenerateRequest[] = [];
    const provider: ImageProvider = {
      async generate(request: ProviderGenerateRequest): Promise<ProviderImage> {
        requests.push(request);
        return { base64, requestId: "req_protocol_success" };
      },
      edit(): Promise<ProviderImage> {
        throw new Error("edit is not used in this test");
      },
    };
    const protocol = await connectProtocol({
      context: {
        ...makeContext(roots, {
          apiKeyConfigured: true,
          apiKey: "test-key-protocol-success",
          baseUrl: "https://api.openai.com/v1",
          baseUrlConfigured: false,
          workspaceRoot: environmentRoot,
        }),
        provider,
      },
      environmentRoot,
      logs: [],
    });
    try {
      await protocol.client.listTools();
      const result = await protocol.client.callTool({
        name: "generate_image",
        arguments: toolArguments,
      });
      const structured = asRecord(result.structuredContent);
      const savedBytes = await readFile(String(structured.absolute_path));
      outcome = { requests, result, savedBytes };
    } finally {
      await protocol.close();
    }
  });
  assert.ok(outcome);
  return outcome;
}

test("a GIF generate_image call without a size sends auto through tools/call and returns a GIF preview", async () => {
  const gif = makeGif({ width: 16, height: 16, frames: 3 });
  const gifBase64 = gif.toString("base64");
  const { requests, result, savedBytes } = await callGenerateWithProvider(
    gifBase64,
    { prompt: "animate a bouncing ball", output_format: "gif" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.size, "auto");
  assert.equal(requests[0]!.output_format, "gif");
  assert.notEqual(result.isError, true);
  const structured = asRecord(result.structuredContent);
  assert.equal(structured.format, "gif");
  assert.equal(structured.mime_type, "image/gif");
  assert.equal(structured.actual_frame_count, 3);
  assert.equal(structured.requested_size, "auto");
  assert.equal(structured.preview_included, true);
  assert.deepEqual(structured.warnings, []);
  assert.match(
    String(structured.relative_path),
    /^\.claude\/generated-images\/gpt-image\/[^/]+\.gif$/,
  );
  assert.deepEqual(savedBytes, gif);

  const content = asArray(result.content).map(asRecord);
  assert.equal(content.length, 2);
  assert.equal(content[0]!.type, "text");
  assert.match(String(content[0]!.text), / \(16x16, gif, 3 frames, \d+ bytes\)\.$/);
  assert.deepEqual(content[1], {
    type: "image",
    data: gifBase64,
    mimeType: "image/gif",
  });
});

test("an SVG generate_image call returns one text block, no preview, and no SIZE_MISMATCH through tools/call", async () => {
  const svg = makeSvg();
  const { requests, result, savedBytes } = await callGenerateWithProvider(
    svg.toString("base64"),
    { prompt: "draw a vector badge", output_format: "svg" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.output_format, "svg");
  assert.notEqual(result.isError, true);
  const structured = asRecord(result.structuredContent);
  assert.equal(structured.format, "svg");
  assert.equal(structured.mime_type, "image/svg+xml");
  assert.equal(structured.preview_included, false);
  assert.equal("actual_frame_count" in structured, false);
  assert.deepEqual(structured.warnings, []);
  assert.match(
    String(structured.relative_path),
    /^\.claude\/generated-images\/gpt-image\/[^/]+\.svg$/,
  );
  assert.deepEqual(savedBytes, svg);

  const content = asArray(result.content).map(asRecord);
  assert.equal(content.length, 1);
  assert.equal(content[0]!.type, "text");
  assert.equal(String(content[0]!.text).includes("SIZE_MISMATCH"), false);
});

test("production paid-call queue enforces its bound, cancellation, and mixed FIFO order", async () => {
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    await writeFile(path.join(environmentRoot, "edit-input.png"), makePng());
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    assert.equal(PAID_CALL_MAX_PENDING, 8);
    assert.equal(processPaidCallGate.pendingCount, 0);
    const imageBytes = makePng({ width: 2, height: 2 });
    const imageBase64 = imageBytes.toString("base64");
    const starts: string[] = [];
    let markBlockerStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const provider: ImageProvider = {
      async generate(
        request: ProviderGenerateRequest,
        _signal?: AbortSignal,
      ): Promise<ProviderImage> {
        starts.push(`generate:${request.prompt}`);
        if (request.prompt === "queue-blocker") {
          markBlockerStarted();
          await blockerReleased;
        }
        return { base64: imageBase64 };
      },
      async edit(
        request: ProviderEditRequest,
        _signal?: AbortSignal,
      ): Promise<ProviderImage> {
        starts.push(`edit:${request.prompt}`);
        return { base64: imageBase64 };
      },
    };
    const publisher: OutputPublisher = async (input) => ({
      relativePath: input.output.relativePath,
      absolutePath: input.output.absolutePath,
      filename: path.basename(input.output.absolutePath),
      info: {
        format: "png",
        mimeType: "image/png",
        width: 2,
        height: 2,
        hasAlpha: true,
      },
      sizeBytes: imageBytes.length,
      warnings: [],
    });
    const snapshotter: InputSnapshotter = async (resolvedPaths) => ({
      snapshots: resolvedPaths.map((resolved) => ({
        originalRelativePath: resolved.relativePath,
        snapshotPath: path.join(environmentRoot, ".private-test-snapshot"),
        filename: path.basename(resolved.relativePath),
        info: {
          format: "png",
          mimeType: "image/png",
          width: 1,
          height: 1,
          hasAlpha: true,
        },
        sizeBytes: makePng().length,
      })),
      async dispose() {},
    });
    const operations: ToolOperations = {
      paths: new WorkspacePaths(roots),
      snapshotInputs: snapshotter,
      publishOutput: publisher,
      makeDefaultOutputPath: () => "outputs/default.png",
      deferCleanup: () => undefined,
    };
    const config: RuntimeConfig = {
      apiKeyConfigured: true,
      apiKey: "test-key-production-queue",
      baseUrl: "https://api.openai.com/v1",
      baseUrlConfigured: false,
      workspaceRoot: environmentRoot,
      pluginDataRoot: path.join(environmentRoot, ".plugin-data"),
    };
    const context: ToolContext = {
      ...createProcessToolContext({
        config,
        roots,
        provider,
        serverVersion: "0.1.0-test",
      }),
      operations,
    };
    assert.strictEqual(context.paidCallGate, processPaidCallGate);
    const gate = context.paidCallGate;
    const pendingCount = () => gate.pendingCount;
    const protocol = await connectProtocol({
      context,
      environmentRoot,
      logs: [],
    });
    const blockerOutcome = protocol.client.callTool({
      name: "generate_image",
      arguments: {
        prompt: "queue-blocker",
        output_path: "outputs/blocker.png",
      },
    });

    type QueuedOutcome =
      | { readonly status: "fulfilled"; readonly value: Awaited<typeof blockerOutcome> }
      | { readonly status: "rejected"; readonly error: unknown };
    const queued: Array<{
      readonly label: string;
      readonly controller: AbortController;
      readonly outcome: Promise<QueuedOutcome>;
    }> = [];

    try {
      await blockerStarted;
      for (let index = 0; index < PAID_CALL_MAX_PENDING; index += 1) {
        const isEdit = index % 2 === 1;
        const label = `${isEdit ? "edit" : "generate"}-queued-${index}`;
        const controller = new AbortController();
        const outcome = protocol.client.callTool(
          isEdit
            ? {
                name: "edit_image",
                arguments: {
                  prompt: label,
                  image_paths: ["edit-input.png"],
                  output_path: `outputs/${label}.png`,
                },
              }
            : {
                name: "generate_image",
                arguments: {
                  prompt: label,
                  output_path: `outputs/${label}.png`,
                },
              },
          undefined,
          { signal: controller.signal },
        ).then<QueuedOutcome, QueuedOutcome>(
          (value) => ({ status: "fulfilled", value }),
          (error: unknown) => ({ status: "rejected", error }),
        );
        queued.push({ label, controller, outcome });
        await waitFor(
          () => pendingCount() === index + 1,
          `paid-call request ${index} did not enter the production queue`,
        );
      }

      const overflow = await protocol.client.callTool(
        {
          name: "generate_image",
          arguments: {
            prompt: "queue-overflow",
            output_path: "outputs/overflow.png",
          },
        },
        undefined,
        { signal: AbortSignal.timeout(1_000) },
      );
      assert.equal(overflow.isError, true);
      assert.deepEqual(overflow.structuredContent, {
        isError: true,
        code: "RATE_LIMITED",
        message: "RATE_LIMITED: Too many paid image requests are already queued",
      });
      assert.deepEqual(starts, ["generate:queue-blocker"]);
      assert.equal(pendingCount(), PAID_CALL_MAX_PENDING);

      const canceledIndex = 3;
      queued[canceledIndex]!.controller.abort();
      const canceled = await queued[canceledIndex]!.outcome;
      assert.equal(canceled.status, "rejected");
      if (canceled.status === "rejected") {
        assert.ok(canceled.error instanceof Error);
      }
      await waitFor(
        () => pendingCount() === PAID_CALL_MAX_PENDING - 1,
        "canceled request remained in the production queue",
      );

      releaseBlocker();
      const blocker = await blockerOutcome;
      assert.equal(blocker.isError, undefined);
      const survivors = await Promise.all(
        queued
          .filter((_entry, index) => index !== canceledIndex)
          .map((entry) => entry.outcome),
      );
      assert.equal(
        survivors.every(
          (outcome) =>
            outcome.status === "fulfilled" && outcome.value.isError === undefined,
        ),
        true,
      );
      assert.deepEqual(starts, [
        "generate:queue-blocker",
        ...queued
          .filter((_entry, index) => index !== canceledIndex)
          .map((entry) => {
            const prefix = entry.label.startsWith("edit-") ? "edit" : "generate";
            return `${prefix}:${entry.label}`;
          }),
      ]);
      assert.equal(starts.includes("generate:queue-overflow"), false);
    } finally {
      releaseBlocker();
      await Promise.allSettled([blockerOutcome, ...queued.map((entry) => entry.outcome)]);
      await protocol.close();
    }
    assert.equal(gate.pendingCount, 0);
  });
});

test("an immediate tool call waits for initial roots synchronization", { timeout: 5_000 }, async () => {
  await withTemporaryRoots(2, async ([environmentRoot, clientRoot]) => {
    assert.ok(environmentRoot);
    assert.ok(clientRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    let releaseRoots = (): void => undefined;
    const rootsGate = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });
    let rootsRequestStarted = false;
    const protocol = await connectProtocol({
      context: makeContext(roots, {
        apiKeyConfigured: false,
        baseUrl: "https://api.openai.com/v1",
        baseUrlConfigured: false,
        workspaceRoot: environmentRoot,
      }),
      environmentRoot,
      logs: [],
      clientRoots: () => [clientRoot],
      beforeListRoots: async () => {
        rootsRequestStarted = true;
        await rootsGate;
      },
    });

    try {
      let settled = false;
      const statusPromise = protocol.client
        .callTool({ name: "get_status" })
        .then((result) => {
          settled = true;
          return result;
        });
      await waitFor(
        () => rootsRequestStarted,
        "initial roots/list request did not start",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(settled, false);

      releaseRoots();
      const status = await statusPromise;
      assert.deepEqual(
        asRecord(status.structuredContent).workspace_roots,
        [await realpath(environmentRoot), await realpath(clientRoot)],
      );
    } finally {
      releaseRoots();
      await protocol.close();
    }
  });
});

test("MCP roots merge with the environment root and refresh on roots/list_changed", async () => {
  await withTemporaryRoots(3, async ([environmentRoot, initialClientRoot, changedClientRoot]) => {
    assert.ok(environmentRoot);
    assert.ok(initialClientRoot);
    assert.ok(changedClientRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    let publishedRoots: readonly string[] = [initialClientRoot];
    const logs: string[] = [];
    const protocol = await connectProtocol({
      context: makeContext(roots, {
        apiKeyConfigured: false,
        baseUrl: "https://api.openai.com/v1",
        baseUrlConfigured: false,
        workspaceRoot: environmentRoot,
      }),
      environmentRoot,
      logs,
      clientRoots: () => publishedRoots,
    });

    try {
      const environmentCanonical = await realpath(environmentRoot);
      const initialCanonical = await realpath(initialClientRoot);
      await waitFor(
        () => {
          const current = roots.list().map((root) => root.canonicalPath);
          return current.includes(environmentCanonical) && current.includes(initialCanonical);
        },
        "initial roots/list result was not merged",
      );

      publishedRoots = [
        changedClientRoot,
        path.join(environmentRoot, "missing-client-root"),
      ];
      await protocol.client.sendRootsListChanged();
      const changedCanonical = await realpath(changedClientRoot);
      await waitFor(
        () => {
          const current = roots.list().map((root) => root.canonicalPath);
          return (
            current.length === 2 &&
            current.includes(environmentCanonical) &&
            current.includes(changedCanonical)
          );
        },
        "roots/list_changed did not refresh the registry",
      );
    } finally {
      await protocol.close();
    }
  });
});

test("clients without roots capability do not prevent initialization or status", async () => {
  await withTemporaryRoots(1, async ([environmentRoot]) => {
    assert.ok(environmentRoot);
    const roots = new WorkspaceRootRegistry();
    await roots.replace([environmentRoot]);
    const protocol = await connectProtocol({
      context: makeContext(roots, {
        apiKeyConfigured: false,
        baseUrl: "https://api.openai.com/v1",
        baseUrlConfigured: false,
        workspaceRoot: environmentRoot,
      }),
      environmentRoot,
      logs: [],
    });

    try {
      const status = await protocol.client.callTool({
        name: "get_status",
        arguments: {},
      });
      assert.equal(status.isError, undefined);
      assert.equal(
        asRecord(status.structuredContent).api_key_configured,
        false,
      );
    } finally {
      await protocol.close();
    }
  });
});
