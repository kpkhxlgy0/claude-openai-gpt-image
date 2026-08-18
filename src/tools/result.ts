import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorResult } from "../errors.ts";
import type { PublishedImage } from "../files/atomic-output.ts";
import type { ResolvedOutputPath } from "../files/workspace-paths.ts";
import { parseImageSize } from "../schemas.ts";
import {
  asUnknownRecord,
  sanitizeRequestId,
} from "../openai/map-error.ts";
import type {
  ProviderImage,
  ProviderImageUsage,
  ProviderQuality,
  ProviderSize,
  ProviderTokenDetails,
} from "../openai/types.ts";
import {
  INLINE_PREVIEW_MAX_BYTES,
  MODEL,
  type ImageToolOutput,
  type ImageToolWarning,
  type StatusOutput,
  type ToolSuccessOutput,
} from "./types.ts";

export interface BuildImageToolOutputOptions {
  readonly requestedSize: ProviderSize;
  readonly quality: ProviderQuality;
  readonly output: ResolvedOutputPath;
  readonly providerImage: ProviderImage;
  readonly published: PublishedImage;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function copyTokenDetails(value: unknown): ProviderTokenDetails | undefined {
  const record = asUnknownRecord(value);
  const imageTokens = readNonNegativeInteger(record?.image_tokens);
  const textTokens = readNonNegativeInteger(record?.text_tokens);
  if (imageTokens === undefined || textTokens === undefined) {
    return undefined;
  }
  return {
    image_tokens: imageTokens,
    text_tokens: textTokens,
  };
}

function copyUsage(value: unknown): ProviderImageUsage | undefined {
  const record = asUnknownRecord(value);
  const inputTokens = readNonNegativeInteger(record?.input_tokens);
  const inputDetails = copyTokenDetails(record?.input_tokens_details);
  const outputTokens = readNonNegativeInteger(record?.output_tokens);
  const totalTokens = readNonNegativeInteger(record?.total_tokens);
  if (
    inputTokens === undefined ||
    inputDetails === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const outputDetails = copyTokenDetails(record?.output_tokens_details);
  return {
    input_tokens: inputTokens,
    input_tokens_details: inputDetails,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(outputDetails === undefined
      ? {}
      : { output_tokens_details: outputDetails }),
  };
}

function collectWarnings(
  options: BuildImageToolOutputOptions,
): readonly ImageToolWarning[] {
  const warnings: ImageToolWarning[] = [...options.published.warnings];
  const requested = parseImageSize(options.requestedSize);
  if (
    requested !== null &&
    (requested.width !== options.published.info.width ||
      requested.height !== options.published.info.height)
  ) {
    warnings.push("SIZE_MISMATCH");
  }
  return warnings;
}

export function buildImageToolOutput(
  options: BuildImageToolOutputOptions,
): ImageToolOutput {
  const previewIncluded =
    options.published.sizeBytes <= INLINE_PREVIEW_MAX_BYTES;
  const requestId = sanitizeRequestId(options.providerImage.requestId);
  const usage = copyUsage(options.providerImage.usage);

  return {
    model: MODEL,
    workspace_root: options.output.root.canonicalPath,
    relative_path: options.published.relativePath,
    absolute_path: options.published.absolutePath,
    requested_size: options.requestedSize,
    actual_width: options.published.info.width,
    actual_height: options.published.info.height,
    format: options.published.info.format,
    mime_type: options.published.info.mimeType,
    size_bytes: options.published.sizeBytes,
    quality: options.quality,
    preview_included: previewIncluded,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(usage === undefined ? {} : { usage }),
    warnings: collectWarnings(options),
    ...(previewIncluded
      ? {
          preview: {
            data: options.providerImage.base64,
            mimeType: options.published.info.mimeType,
          },
        }
      : {}),
  };
}

function statusStructured(output: StatusOutput): Record<string, unknown> {
  return {
    model: output.model,
    api_key_configured: output.api_key_configured,
    base_url_configured: output.base_url_configured,
    base_url_valid: output.base_url_valid,
    workspace_roots: [...output.workspace_roots],
    default_relative_output_dir: output.default_relative_output_dir,
    server_version: output.server_version,
  };
}

function imageStructured(output: ImageToolOutput): Record<string, unknown> {
  return {
    model: output.model,
    workspace_root: output.workspace_root,
    relative_path: output.relative_path,
    absolute_path: output.absolute_path,
    requested_size: output.requested_size,
    actual_width: output.actual_width,
    actual_height: output.actual_height,
    format: output.format,
    mime_type: output.mime_type,
    size_bytes: output.size_bytes,
    quality: output.quality,
    preview_included: output.preview_included,
    ...(output.request_id === undefined
      ? {}
      : { request_id: output.request_id }),
    ...(output.usage === undefined ? {} : { usage: output.usage }),
    warnings: [...output.warnings],
  };
}

function isStatusOutput(output: ToolSuccessOutput): output is StatusOutput {
  return "workspace_roots" in output;
}

export function toMcpSuccess(output: ToolSuccessOutput): CallToolResult {
  if (isStatusOutput(output)) {
    const keyState = output.api_key_configured ? "configured" : "not configured";
    return {
      content: [
        {
          type: "text",
          text: `GPT Image 2 status: API key ${keyState}; ${output.workspace_roots.length} approved workspace root(s).`,
        },
      ],
      structuredContent: statusStructured(output),
    };
  }

  const warningSuffix =
    output.warnings.length === 0
      ? ""
      : ` Warnings: ${output.warnings.join(", ")}.`;
  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: `Saved ${output.model} image to ${output.relative_path} (${output.actual_width}x${output.actual_height}, ${output.format}, ${output.size_bytes} bytes).${warningSuffix}`,
    },
  ];
  if (output.preview_included && output.preview !== undefined) {
    content.push({
      type: "image",
      data: output.preview.data,
      mimeType: output.preview.mimeType,
    });
  }

  return {
    content,
    structuredContent: imageStructured(output),
  };
}

export function toMcpError(error: unknown): CallToolResult {
  const result = toErrorResult(error);
  return {
    isError: true,
    content: [{ type: "text", text: result.message }],
    structuredContent: {
      isError: true,
      code: result.code,
      message: result.message,
    },
  };
}
