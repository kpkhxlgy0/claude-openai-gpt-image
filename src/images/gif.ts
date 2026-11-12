import { AppError } from "../errors.ts";
import {
  MAX_GIF_FRAMES,
  MAX_GIF_TOTAL_FRAME_PIXELS,
  MAX_IMAGE_BYTES,
  assertImageDimensions,
  type OutputImageInfo,
} from "./types.ts";

const HEADER_BYTES = 6;
const LOGICAL_SCREEN_END = HEADER_BYTES + 7;
const IMAGE_DESCRIPTOR_BYTES = 10;
const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2c;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const GRAPHIC_CONTROL_BLOCK_SIZE = 4;
const COLOR_TABLE_FLAG = 0x80;
const TRANSPARENCY_FLAG = 0x01;
const MIN_LZW_CODE_SIZE = 2;
const MAX_LZW_CODE_SIZE = 8;

function invalidGif(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", `Invalid GIF: ${message}`);
}

function colorTableBytes(packed: number): number {
  return (packed & COLOR_TABLE_FLAG) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

/** Skips data sub-blocks through the zero-length block terminator. */
function skipSubBlocks(buffer: Buffer, offset: number): number {
  let position = offset;
  while (true) {
    if (position >= buffer.length) invalidGif("truncated data sub-block");
    const size = buffer[position]!;
    position += 1;
    if (size === 0) return position;
    if (size > buffer.length - position) invalidGif("truncated data sub-block");
    position += size;
  }
}

/**
 * Validates GIF block structure without decoding LZW image data.
 */
export function inspectGif(bytes: Uint8Array): OutputImageInfo {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    invalidGif("encoded image exceeds the byte limit");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < HEADER_BYTES) invalidGif("signature mismatch");
  const signature = buffer.toString("latin1", 0, HEADER_BYTES);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    invalidGif("signature mismatch");
  }
  if (buffer.length < LOGICAL_SCREEN_END) {
    invalidGif("truncated logical screen descriptor");
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  assertImageDimensions(width, height, invalidGif);

  const globalColorTableEnd = LOGICAL_SCREEN_END + colorTableBytes(buffer[10]!);
  if (globalColorTableEnd > buffer.length) invalidGif("truncated global color table");

  let offset = globalColorTableEnd;
  let frameCount = 0;
  let framePixels = 0;
  let hasAlpha = false;

  while (offset < buffer.length) {
    const introducer = buffer[offset]!;
    switch (introducer) {
      case TRAILER:
        if (offset !== buffer.length - 1) invalidGif("data follows the trailer");
        if (frameCount === 0) invalidGif("no image frames");
        return {
          format: "gif",
          mimeType: "image/gif",
          width,
          height,
          hasAlpha,
          frameCount,
        };
      case EXTENSION_INTRODUCER: {
        if (buffer.length - offset < 2) invalidGif("truncated extension block");
        const label = buffer[offset + 1]!;
        offset += 2;
        if (label === GRAPHIC_CONTROL_LABEL) {
          const blockEnd = offset + 1 + GRAPHIC_CONTROL_BLOCK_SIZE;
          if (blockEnd >= buffer.length) invalidGif("truncated extension block");
          if (
            buffer[offset] !== GRAPHIC_CONTROL_BLOCK_SIZE ||
            buffer[blockEnd] !== 0
          ) {
            invalidGif("Graphic Control Extension is malformed");
          }
          if ((buffer[offset + 1]! & TRANSPARENCY_FLAG) !== 0) hasAlpha = true;
          offset = blockEnd + 1;
        } else {
          offset = skipSubBlocks(buffer, offset);
        }
        break;
      }
      case IMAGE_SEPARATOR: {
        if (buffer.length - offset < IMAGE_DESCRIPTOR_BYTES) {
          invalidGif("truncated image descriptor");
        }
        const left = buffer.readUInt16LE(offset + 1);
        const top = buffer.readUInt16LE(offset + 3);
        const frameWidth = buffer.readUInt16LE(offset + 5);
        const frameHeight = buffer.readUInt16LE(offset + 7);
        const packed = buffer[offset + 9]!;
        if (frameWidth === 0 || frameHeight === 0) {
          invalidGif("frame dimensions must be nonzero");
        }
        if (left + frameWidth > width || top + frameHeight > height) {
          invalidGif("frame lies outside the logical screen");
        }
        // Each frame is at most MAX_IMAGE_PIXELS, so the sum stays exact.
        framePixels += frameWidth * frameHeight;
        if (framePixels > MAX_GIF_TOTAL_FRAME_PIXELS) {
          invalidGif("frames exceed the total pixel limit");
        }

        offset += IMAGE_DESCRIPTOR_BYTES;
        const localColorTableEnd = offset + colorTableBytes(packed);
        if (localColorTableEnd > buffer.length) invalidGif("truncated local color table");
        offset = localColorTableEnd;

        if (offset >= buffer.length) invalidGif("truncated image data");
        const codeSize = buffer[offset]!;
        if (codeSize < MIN_LZW_CODE_SIZE || codeSize > MAX_LZW_CODE_SIZE) {
          invalidGif("LZW minimum code size is invalid");
        }
        offset += 1;
        if (offset >= buffer.length) invalidGif("truncated data sub-block");
        if (buffer[offset] === 0) invalidGif("frame has no image data");
        offset = skipSubBlocks(buffer, offset);

        frameCount += 1;
        if (frameCount > MAX_GIF_FRAMES) invalidGif("frame count exceeds the limit");
        break;
      }
      default:
        invalidGif("unknown block introducer");
    }
  }

  invalidGif("missing trailer");
}
