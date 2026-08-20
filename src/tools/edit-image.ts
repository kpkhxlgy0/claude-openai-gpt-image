import { AppError } from "../errors.ts";
import type { InputSnapshot } from "../files/input-snapshot.ts";
import { isSamePath } from "../files/workspace-roots.ts";
import type { ProviderEditRequest } from "../openai/types.ts";
import type { EditImageInput } from "../schemas.ts";
import { buildImageToolOutput } from "./result.ts";
import {
  assertOutputFormat,
  getToolOperations,
  requireImageProvider,
  selectOutputPath,
  type ImageToolOutput,
  type ToolContext,
} from "./types.ts";

function assertImageCount(input: EditImageInput): void {
  if (input.image_paths.length < 1 || input.image_paths.length > 8) {
    throw new AppError(
      "INVALID_INPUT",
      "Editing requires between one and eight input images",
    );
  }
}

function assertMaskValid(
  images: readonly InputSnapshot[],
  mask: InputSnapshot,
): void {
  const first = images[0];
  if (first === undefined) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Input snapshots were not prepared correctly",
    );
  }

  if (mask.info.format !== "png" || mask.info.mimeType !== "image/png") {
    throw new AppError("INPUT_FILE_INVALID", "Edit mask must be a PNG image");
  }
  if (!mask.info.hasAlpha) {
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Edit mask PNG must contain an alpha channel",
    );
  }
  if (
    mask.info.width !== first.info.width ||
    mask.info.height !== first.info.height
  ) {
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Edit mask dimensions must match the first input image",
    );
  }
}

export async function editImage(
  input: EditImageInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ImageToolOutput> {
  signal?.throwIfAborted();
  assertImageCount(input);
  const provider = requireImageProvider(context);
  const operations = getToolOperations(context);

  const inputPaths =
    input.mask_path === undefined
      ? input.image_paths
      : [...input.image_paths, input.mask_path];
  const resolvedInputs = await Promise.all(
    inputPaths.map((inputPath) =>
      operations.paths.resolveInput(inputPath, input.workspace_root),
    ),
  );
  signal?.throwIfAborted();
  const resolvedImages = resolvedInputs.slice(0, input.image_paths.length);
  const resolvedMask =
    input.mask_path === undefined
      ? undefined
      : resolvedInputs[input.image_paths.length];

  const requestedOutputPath = selectOutputPath(
    input.output_path,
    input.output_format,
    operations,
  );
  const outputIdentity = await operations.paths.resolveInput(
    requestedOutputPath,
    input.workspace_root,
  );
  signal?.throwIfAborted();
  if (
    resolvedInputs.some((resolved) =>
      isSamePath(resolved.absolutePath, outputIdentity.absolutePath),
    )
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "Output path must not identify an edit input or mask",
    );
  }

  return context.paidCallGate.runExclusive(async () => {
    signal?.throwIfAborted();
    const output = await operations.paths.resolveOutput(
      requestedOutputPath,
      input.workspace_root,
    );
    assertOutputFormat(output, input.output_format);
    signal?.throwIfAborted();

    const snapshotSet = await operations.snapshotInputs(
      resolvedInputs,
      context.config.pluginDataRoot,
      signal,
    );
    let result: ImageToolOutput | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      signal?.throwIfAborted();
      if (snapshotSet.snapshots.length !== resolvedInputs.length) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Input snapshots were not prepared correctly",
        );
      }

      const imageSnapshots = snapshotSet.snapshots.slice(
        0,
        resolvedImages.length,
      );
      const maskSnapshot =
        resolvedMask === undefined
          ? undefined
          : snapshotSet.snapshots[resolvedImages.length];
      if (maskSnapshot !== undefined) {
        assertMaskValid(imageSnapshots, maskSnapshot);
      } else if (resolvedMask !== undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Mask snapshot was not prepared correctly",
        );
      }

      const request: ProviderEditRequest = {
        prompt: input.prompt,
        quality: input.quality,
        size: input.size,
        output_format: input.output_format,
        ...(input.output_compression === undefined
          ? {}
          : { output_compression: input.output_compression }),
        images: imageSnapshots,
        ...(maskSnapshot === undefined ? {} : { mask: maskSnapshot }),
      };
      signal?.throwIfAborted();
      const providerImage = await provider.edit(request, signal);
      signal?.throwIfAborted();
      const published = await operations.publishOutput({
        output,
        base64: providerImage.base64,
        format: input.output_format,
        ...(signal === undefined ? {} : { signal }),
      });

      result = buildImageToolOutput({
        requestedSize: input.size,
        quality: input.quality,
        output,
        providerImage,
        published,
      });
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const disposeAfterFailure = async (error: unknown): Promise<never> => {
      try {
        await snapshotSet.dispose();
      } catch {
        try {
          operations.deferCleanup(() => snapshotSet.dispose());
        } catch {
          // Preserve the original operation failure if cleanup cannot be queued.
        }
      }
      throw error;
    };

    if (operationFailed) {
      return disposeAfterFailure(operationError);
    }
    if (result === undefined) {
      return disposeAfterFailure(
        new AppError("INTERNAL_ERROR", "Edit result was not constructed"),
      );
    }

    try {
      await snapshotSet.dispose();
    } catch {
      try {
        operations.deferCleanup(() => snapshotSet.dispose());
      } catch {
        // The committed output remains valid; the warning reports that
        // automatic cleanup could not be guaranteed.
      }
      result = {
        ...result,
        warnings: [...result.warnings, "SNAPSHOT_CLEANUP_PENDING"],
      };
    }
    return result;
  }, signal);
}
