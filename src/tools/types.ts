import path from "node:path";
import { setTimeout as scheduleTimeout } from "node:timers";
import type { RuntimeConfig } from "../config/environment.ts";
import type { Semaphore } from "../concurrency.ts";
import { AppError } from "../errors.ts";
import {
  publishOutput,
  type OutputPublisher,
  type PublicationWarning,
} from "../files/atomic-output.ts";
import {
  snapshotInputs,
  type InputSnapshotter,
} from "../files/input-snapshot.ts";
import { makeDefaultOutputPath } from "../files/default-output.ts";
import {
  WorkspacePaths,
  type ResolvedInputPath,
  type ResolvedOutputPath,
} from "../files/workspace-paths.ts";
import type { WorkspaceRootRegistry } from "../files/workspace-roots.ts";
import type { ImageFormat } from "../images/types.ts";
import type {
  ImageProvider,
  ProviderImageUsage,
  ProviderQuality,
  ProviderSize,
} from "../openai/types.ts";

export const MODEL = "gpt-image-2" as const;
export const DEFAULT_RELATIVE_OUTPUT_DIRECTORY =
  ".claude/generated-images/gpt-image-2" as const;
export const INLINE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export type ImageToolWarning =
  | PublicationWarning
  | "SIZE_MISMATCH"
  | "SNAPSHOT_CLEANUP_PENDING";

export interface StatusOutput {
  readonly model: typeof MODEL;
  readonly api_key_configured: boolean;
  readonly base_url_configured: boolean;
  readonly base_url_valid: boolean;
  readonly workspace_roots: readonly string[];
  readonly default_relative_output_dir: typeof DEFAULT_RELATIVE_OUTPUT_DIRECTORY;
  readonly server_version: string;
}

export interface InlineImagePreview {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ImageToolOutput {
  readonly model: typeof MODEL;
  readonly workspace_root: string;
  readonly relative_path: string;
  readonly absolute_path: string;
  readonly requested_size: ProviderSize;
  readonly actual_width: number;
  readonly actual_height: number;
  readonly format: ImageFormat;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly size_bytes: number;
  readonly quality: ProviderQuality;
  readonly preview_included: boolean;
  readonly request_id?: string;
  readonly usage?: ProviderImageUsage;
  readonly warnings: readonly ImageToolWarning[];
  readonly preview?: InlineImagePreview;
}

export interface WorkspacePathResolver {
  resolveInput(
    userPath: string,
    workspaceRootSelector?: string,
  ): Promise<ResolvedInputPath>;
  resolveOutput(
    userPath: string,
    workspaceRootSelector?: string,
  ): Promise<ResolvedOutputPath>;
}

export interface ToolOperations {
  readonly paths: WorkspacePathResolver;
  readonly snapshotInputs: InputSnapshotter;
  readonly publishOutput: OutputPublisher;
  readonly makeDefaultOutputPath: (format: ImageFormat) => string;
  readonly deferCleanup: (task: () => Promise<void>) => void;
}

export interface ToolContext {
  readonly config: RuntimeConfig;
  readonly roots: WorkspaceRootRegistry;
  readonly provider?: ImageProvider;
  readonly paidCallGate: Semaphore;
  readonly serverVersion: string;
  readonly operations?: ToolOperations;
}

export type ToolSuccessOutput = StatusOutput | ImageToolOutput;

function deferCleanup(task: () => Promise<void>): void {
  const timer = scheduleTimeout(() => {
    void task().catch(() => undefined);
  }, 1_000);
  timer.unref();
}

export function getToolOperations(context: ToolContext): ToolOperations {
  if (context.operations !== undefined) {
    return context.operations;
  }

  return {
    paths: new WorkspacePaths(context.roots),
    snapshotInputs,
    publishOutput,
    makeDefaultOutputPath,
    deferCleanup,
  };
}

export function requireImageProvider(context: ToolContext): ImageProvider {
  if (!context.config.apiKeyConfigured || context.provider === undefined) {
    throw new AppError(
      "CONFIG_MISSING",
      "Image generation requires a configured API key and provider",
    );
  }
  return context.provider;
}

export function selectOutputPath(
  requestedPath: string | undefined,
  format: ImageFormat,
  operations: ToolOperations,
): string {
  return requestedPath ?? operations.makeDefaultOutputPath(format);
}

export function assertOutputFormat(
  output: ResolvedOutputPath,
  format: ImageFormat,
): void {
  const extension = path.extname(output.absolutePath).toLowerCase();
  const valid =
    (format === "png" && extension === ".png") ||
    (format === "webp" && extension === ".webp") ||
    (format === "jpeg" && (extension === ".jpeg" || extension === ".jpg"));
  if (!valid) {
    throw new AppError(
      "INVALID_INPUT",
      "Output filename extension must match the requested image format",
    );
  }
}
