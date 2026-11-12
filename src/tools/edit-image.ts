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

// The API compares the markup layer with the first image after EXIF
// orientation, which the local inspectors do not apply. A layer drawn for a
// rotated JPEG or WebP therefore matches the stored dimensions or their
// transpose. Those are the formats that commonly carry EXIF orientation, so
// only they get the transposed allowance; a PNG first image must match
// exactly. No EXIF data is parsed.
function assertMarkupValid(
  images: readonly InputSnapshot[],
  markup: InputSnapshot,
): void {
  const first = images[0];
  if (first === undefined) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Input snapshots were not prepared correctly",
    );
  }

  if (markup.info.format !== "png" || markup.info.mimeType !== "image/png") {
    throw new AppError("INPUT_FILE_INVALID", "Edit markup must be a PNG image");
  }
  if (!markup.info.hasAlpha) {
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Edit markup PNG must contain an alpha channel",
    );
  }
  const { width, height } = markup.info;
  const matchesStored =
    width === first.info.width && height === first.info.height;
  const mayBeRotated =
    first.info.format === "jpeg" || first.info.format === "webp";
  const matchesTransposed =
    mayBeRotated &&
    width === first.info.height &&
    height === first.info.width;
  if (!matchesStored && !matchesTransposed) {
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Edit markup dimensions must match the first input image",
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

  // Inputs are ordered images, then the optional mask, then the optional
  // markup layer. The schema keeps mask and markup apart, but the indexes
  // below do not depend on that.
  const maskIndex =
    input.mask_path === undefined ? undefined : input.image_paths.length;
  const markupIndex =
    input.markup_path === undefined
      ? undefined
      : input.image_paths.length + (maskIndex === undefined ? 0 : 1);
  const inputPaths = [
    ...input.image_paths,
    ...(input.mask_path === undefined ? [] : [input.mask_path]),
    ...(input.markup_path === undefined ? [] : [input.markup_path]),
  ];
  const resolvedInputs = await Promise.all(
    inputPaths.map((inputPath) =>
      operations.paths.resolveInput(inputPath, input.workspace_root),
    ),
  );
  signal?.throwIfAborted();
  const resolvedImages = resolvedInputs.slice(0, input.image_paths.length);
  const resolvedMask =
    maskIndex === undefined ? undefined : resolvedInputs[maskIndex];
  const resolvedMarkup =
    markupIndex === undefined ? undefined : resolvedInputs[markupIndex];

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
      "Output path must not identify an edit input, mask, or markup layer",
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
        maskIndex === undefined ? undefined : snapshotSet.snapshots[maskIndex];
      if (maskSnapshot !== undefined) {
        assertMaskValid(imageSnapshots, maskSnapshot);
      } else if (resolvedMask !== undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Mask snapshot was not prepared correctly",
        );
      }
      const markupSnapshot =
        markupIndex === undefined
          ? undefined
          : snapshotSet.snapshots[markupIndex];
      if (markupSnapshot !== undefined) {
        assertMarkupValid(imageSnapshots, markupSnapshot);
      } else if (resolvedMarkup !== undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Markup snapshot was not prepared correctly",
        );
      }

      const request: ProviderEditRequest = {
        model: input.model,
        prompt: input.prompt,
        quality: input.quality,
        size: input.size,
        output_format: input.output_format,
        ...(input.output_compression === undefined
          ? {}
          : { output_compression: input.output_compression }),
        background: input.background,
        ...(input.complexity === undefined
          ? {}
          : { complexity: input.complexity }),
        ...(input.frame_count === undefined
          ? {}
          : { frame_count: input.frame_count }),
        ...(input.frame_duration_ms === undefined
          ? {}
          : { frame_duration_ms: input.frame_duration_ms }),
        images: imageSnapshots,
        ...(maskSnapshot === undefined ? {} : { mask: maskSnapshot }),
        ...(markupSnapshot === undefined ? {} : { markup: markupSnapshot }),
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
        model: input.model,
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
