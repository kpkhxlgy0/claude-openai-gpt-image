import { AppError } from "../errors.ts";
import { inspectGif } from "./gif.ts";
import { inspectImage } from "./inspect-image.ts";
import { inspectSvg } from "./svg.ts";
import type { OutputImageFormat, OutputImageInfo } from "./types.ts";

/**
 * Validates provider output bytes against the requested output format.
 * PNG, JPEG, and WebP use the same inspection as edit inputs; GIF and SVG are
 * accepted only here, because they are output-only formats.
 */
export async function inspectOutputImage(
  bytes: Uint8Array,
  format: OutputImageFormat,
): Promise<OutputImageInfo> {
  switch (format) {
    case "png":
    case "jpeg":
    case "webp":
      return inspectImage(bytes, format);
    case "gif":
      return inspectGif(bytes);
    case "svg":
      return inspectSvg(bytes);
    default: {
      // Fails closed if a caller passes a value outside the union at runtime.
      const unreachable: never = format;
      void unreachable;
      throw new AppError("INPUT_FILE_INVALID", "Unsupported output image format");
    }
  }
}
