import { AppError } from "../errors.ts";
import { inspectJpeg } from "./jpeg.ts";
import { inspectPng, PNG_SIGNATURE } from "./png.ts";
import {
  MAX_IMAGE_BYTES,
  type ImageFormat,
  type ImageInfo,
} from "./types.ts";
import { inspectWebP } from "./webp.ts";

function invalidImage(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", message);
}

function detectFormat(bytes: Buffer): ImageFormat {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "png";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  invalidImage("Input bytes are not a supported PNG, JPEG, or WebP image");
}

export async function inspectImage(
  bytes: Uint8Array,
  expectedFormat?: ImageFormat,
): Promise<ImageInfo> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    invalidImage("Encoded image exceeds the byte limit");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const format = detectFormat(buffer);
  if (expectedFormat !== undefined && format !== expectedFormat) {
    invalidImage(`Image format does not match expected ${expectedFormat}`);
  }

  switch (format) {
    case "png":
      return inspectPng(buffer);
    case "jpeg":
      return inspectJpeg(buffer);
    case "webp":
      return inspectWebP(buffer);
  }
}
