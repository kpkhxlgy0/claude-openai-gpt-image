import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError, toErrorResult, type ErrorCode } from "./errors.ts";
import { WorkspaceRootRegistry } from "./files/workspace-roots.ts";
import { createSafeLogger, type SafeLogger } from "./logger.ts";
import {
  editImageSchema,
  generateImageSchema,
  statusSchema,
} from "./schemas.ts";
import { editImage } from "./tools/edit-image.ts";
import { generateImage } from "./tools/generate-image.ts";
import { toMcpError, toMcpSuccess } from "./tools/result.ts";
import { getStatus } from "./tools/status.ts";
import type { ToolContext } from "./tools/types.ts";

const ROOTS_REQUEST_TIMEOUT_MS = 2_000;

const rawCallToolRequestSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.unknown().optional(),
  }),
});

const ERROR_CODES = [
  "CONFIG_MISSING",
  "CONFIG_INVALID",
  "INVALID_INPUT",
  "WORKSPACE_ROOT_REQUIRED",
  "PATH_OUTSIDE_WORKSPACE",
  "INPUT_FILE_INVALID",
  "OUTPUT_EXISTS",
  "AUTHENTICATION_FAILED",
  "MODERATION_BLOCKED",
  "RATE_LIMITED",
  "PROVIDER_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "INTERNAL_ERROR",
] as const satisfies readonly ErrorCode[];

const errorCodeSchema = z.enum(ERROR_CODES);
const errorOutputSchema = z.strictObject({
  isError: z.literal(true),
  code: errorCodeSchema,
  message: z.string(),
});

const tokenDetailsSchema = z.strictObject({
  image_tokens: z.number().int().nonnegative(),
  text_tokens: z.number().int().nonnegative(),
});

const usageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: tokenDetailsSchema,
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  output_tokens_details: tokenDetailsSchema.optional(),
});

const statusSuccessOutputSchema = z.strictObject({
  model: z.literal("gpt-image-2"),
  api_key_configured: z.boolean(),
  base_url_configured: z.boolean(),
  base_url_valid: z.boolean(),
  workspace_roots: z.array(z.string()),
  default_relative_output_dir: z.literal(
    ".claude/generated-images/gpt-image-2",
  ),
  server_version: z.string().min(1),
});

const imageSuccessOutputSchema = z.strictObject({
  model: z.literal("gpt-image-2"),
  workspace_root: z.string(),
  relative_path: z.string(),
  absolute_path: z.string(),
  requested_size: z.string(),
  actual_width: z.number().int().positive(),
  actual_height: z.number().int().positive(),
  format: z.enum(["png", "jpeg", "webp"]),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().nonnegative(),
  quality: z.enum(["auto", "low", "medium", "high"]),
  preview_included: z.boolean(),
  request_id: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional(),
  usage: usageSchema.optional(),
  warnings: z.array(
    z.enum([
      "TEMP_CLEANUP_PENDING",
      "SIZE_MISMATCH",
      "SNAPSHOT_CLEANUP_PENDING",
    ]),
  ),
});

const STATUS_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

const IMAGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

const STATUS_TITLE = "Get GPT Image 2 status";
const STATUS_DESCRIPTION =
  "Report safe configuration and approved workspace-root status without making an image provider request.";
const GENERATE_TITLE = "Generate an image";
const GENERATE_DESCRIPTION =
  "Generate one GPT Image 2 image and publish it as a new file inside an approved workspace root.";
const EDIT_TITLE = "Edit images";
const EDIT_DESCRIPTION =
  "Edit one to eight workspace images and publish one new output file without modifying the inputs.";

export interface ImageServerDependencies {
  readonly context: ToolContext;
  readonly logger?: SafeLogger;
  readonly environmentRoot?: string;
}

function errorCode(error: unknown): ErrorCode {
  return toErrorResult(error).code;
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("INVALID_INPUT", "Image tool input is invalid");
  }
}

function objectJsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
): Tool["inputSchema"] {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io,
  });
  if (jsonSchema.type !== "object") {
    throw new AppError(
      "INTERNAL_ERROR",
      "Tool schema must advertise a JSON object",
    );
  }
  return jsonSchema as Tool["inputSchema"];
}

function outputJsonSchema(successSchema: z.ZodType): NonNullable<Tool["outputSchema"]> {
  const success = { ...objectJsonSchema(successSchema, "output") };
  const failure = { ...objectJsonSchema(errorOutputSchema, "output") };
  delete success.$schema;
  delete failure.$schema;
  return {
    type: "object",
    oneOf: [success, failure],
  };
}

function fileRootPath(uri: string): string | undefined {
  try {
    const value = new URL(uri);
    if (
      value.protocol !== "file:" ||
      value.username !== "" ||
      value.password !== "" ||
      value.search !== "" ||
      value.hash !== "" ||
      (value.hostname !== "" && value.hostname !== "localhost")
    ) {
      return undefined;
    }
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

async function validateRootPaths(
  candidates: readonly string[],
): Promise<readonly string[]> {
  const validated: string[] = [];
  for (const candidate of candidates) {
    const registry = new WorkspaceRootRegistry();
    try {
      await registry.replace([candidate]);
      const root = registry.list()[0];
      if (root !== undefined) {
        validated.push(root.canonicalPath);
      }
    } catch {
      // Invalid, missing, and non-directory roots are ignored individually.
    }
  }
  return validated;
}

export function createImageServer(
  dependencies: ImageServerDependencies,
): McpServer {
  const { context } = dependencies;
  const logger = dependencies.logger ?? createSafeLogger();
  const server = new McpServer({
    name: "gpt-image-2",
    version: context.serverVersion,
  });

  let synchronizationStarted = false;
  let synchronization = Promise.resolve();
  const synchronizeRoots = async (): Promise<void> => {
    const candidates: string[] = [];
    if (dependencies.environmentRoot !== undefined) {
      candidates.push(dependencies.environmentRoot);
    }

    const rootCapability = server.server.getClientCapabilities()?.roots;
    if (rootCapability === undefined) {
      logger.log("roots_unavailable", { phase: "roots" });
    } else {
      try {
        const published = await server.server.listRoots(undefined, {
          timeout: ROOTS_REQUEST_TIMEOUT_MS,
        });
        for (const root of published.roots) {
          const rootPath = fileRootPath(root.uri);
          if (rootPath !== undefined) {
            candidates.push(rootPath);
          }
        }
      } catch (error) {
        logger.log("roots_unavailable", {
          phase: "roots",
          code: errorCode(error),
        });
      }
    }

    const validated = await validateRootPaths(candidates);
    try {
      await context.roots.replace(validated);
      logger.log("roots_sync", {
        phase: "roots",
        rootCount: context.roots.list().length,
      });
    } catch (error) {
      logger.log("server_error", {
        phase: "roots",
        code: errorCode(error),
      });
    }
  };

  const queueRootSynchronization = (): Promise<void> => {
    synchronizationStarted = true;
    synchronization = synchronization.then(synchronizeRoots, synchronizeRoots);
    return synchronization;
  };

  const waitForRootSynchronization = (): Promise<void> =>
    synchronizationStarted ? synchronization : queueRootSynchronization();

  const toolFailure = (error: unknown) => {
    logger.log("tool_error", {
      phase: "tool",
      code: errorCode(error),
    });
    return toMcpError(error);
  };

  const runStatus = async (input: unknown) => {
    try {
      parseToolInput(statusSchema, input === undefined ? {} : input);
      await waitForRootSynchronization();
      return toMcpSuccess(getStatus(context));
    } catch (error) {
      return toolFailure(error);
    }
  };

  const runGenerate = async (input: unknown, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted();
      const parsed = parseToolInput(generateImageSchema, input);
      await waitForRootSynchronization();
      signal?.throwIfAborted();
      return toMcpSuccess(await generateImage(parsed, context, signal));
    } catch (error) {
      signal?.throwIfAborted();
      return toolFailure(error);
    }
  };

  const runEdit = async (input: unknown, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted();
      const parsed = parseToolInput(editImageSchema, input);
      await waitForRootSynchronization();
      signal?.throwIfAborted();
      return toMcpSuccess(await editImage(parsed, context, signal));
    } catch (error) {
      signal?.throwIfAborted();
      return toolFailure(error);
    }
  };

  server.registerTool(
    "get_status",
    {
      title: STATUS_TITLE,
      description: STATUS_DESCRIPTION,
      inputSchema: statusSchema,
      outputSchema: statusSuccessOutputSchema,
      annotations: STATUS_ANNOTATIONS,
    },
    (input) => runStatus(input),
  );

  server.registerTool(
    "generate_image",
    {
      title: GENERATE_TITLE,
      description: GENERATE_DESCRIPTION,
      inputSchema: generateImageSchema.in.out,
      outputSchema: imageSuccessOutputSchema,
      annotations: IMAGE_ANNOTATIONS,
    },
    (input, extra) => runGenerate(input, extra.signal),
  );

  server.registerTool(
    "edit_image",
    {
      title: EDIT_TITLE,
      description: EDIT_DESCRIPTION,
      inputSchema: editImageSchema.in.out,
      outputSchema: imageSuccessOutputSchema,
      annotations: IMAGE_ANNOTATIONS,
    },
    (input, extra) => runEdit(input, extra.signal),
  );

  const advertisedTools: readonly Tool[] = [
    {
      name: "get_status",
      title: STATUS_TITLE,
      description: STATUS_DESCRIPTION,
      inputSchema: objectJsonSchema(statusSchema, "input"),
      outputSchema: outputJsonSchema(statusSuccessOutputSchema),
      annotations: STATUS_ANNOTATIONS,
    },
    {
      name: "generate_image",
      title: GENERATE_TITLE,
      description: GENERATE_DESCRIPTION,
      inputSchema: objectJsonSchema(generateImageSchema.in.out, "input"),
      outputSchema: outputJsonSchema(imageSuccessOutputSchema),
      annotations: IMAGE_ANNOTATIONS,
    },
    {
      name: "edit_image",
      title: EDIT_TITLE,
      description: EDIT_DESCRIPTION,
      inputSchema: objectJsonSchema(editImageSchema.in.out, "input"),
      outputSchema: outputJsonSchema(imageSuccessOutputSchema),
      annotations: IMAGE_ANNOTATIONS,
    },
  ];

  // SDK 1.30 validates registered inputs before invoking callbacks and cannot
  // advertise a top-level Zod success/error union. Keep registerTool as the
  // source of tool registration, then adapt the protocol boundary so every
  // invalid input is mapped through the application's stable error contract.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...advertisedTools],
  }));
  const rawCallToolHandler = (
    request: z.output<typeof rawCallToolRequestSchema>,
    extra: { readonly signal: AbortSignal },
  ) => {
    switch (request.params.name) {
      case "get_status":
        return runStatus(request.params.arguments);
      case "generate_image":
        return runGenerate(request.params.arguments, extra.signal);
      case "edit_image":
        return runEdit(request.params.arguments, extra.signal);
      default:
        return toolFailure(
          new AppError("INVALID_INPUT", "Requested image tool is not available"),
        );
    }
  };
  Reflect.apply(Protocol.prototype.setRequestHandler, server.server, [
    rawCallToolRequestSchema,
    rawCallToolHandler,
  ]);

  server.server.oninitialized = () => {
    void queueRootSynchronization();
  };
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => queueRootSynchronization(),
  );

  logger.log("server_start", {
    phase: "startup",
    rootCount: context.roots.list().length,
    toolCount: advertisedTools.length,
  });
  return server;
}
