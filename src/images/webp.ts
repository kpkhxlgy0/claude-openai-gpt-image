import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import decodeWebP, { init as initWebP } from "@jsquash/webp/decode.js";
import { AppError } from "../errors.ts";
import { assertImageDimensions, type ImageInfo } from "./types.ts";

const MAX_CHUNKS = 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const require = createRequire(import.meta.url);
const VP8X_RESERVED_FLAGS = 0xc1;
const VP8X_ICC_FLAG = 0x20;
const VP8X_ALPHA_FLAG = 0x10;
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;
const VP8X_ANIMATION_FLAG = 0x02;

interface WebPContainerInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
}

interface ImageChunkInfo extends WebPContainerInfo {
  type: "VP8 " | "VP8L";
}

type InitWebPWithModule = (module: WebAssembly.Module) => Promise<void>;

let decoderInitialization: Promise<void> | undefined;

function invalidWebP(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", `Invalid WebP: ${message}`);
}

async function loadDecoderWasmBytes(): Promise<Uint8Array> {
  if (
    typeof __BUNDLED_WEBP_WASM__ !== "undefined" &&
    __BUNDLED_WEBP_WASM__
  ) {
    const { default: decoderWasmBase64 } = await import(
      "@jsquash/webp/codec/dec/webp_dec.wasm"
    );
    return Buffer.from(decoderWasmBase64, "base64");
  }

  return readFile(
    require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"),
  );
}

function ensureDecoderInitialized(): Promise<void> {
  decoderInitialization ??= (async () => {
    const wasmBytes = await loadDecoderWasmBytes();
    const module = await WebAssembly.compile(toExactArrayBuffer(wasmBytes));
    await (initWebP as unknown as InitWebPWithModule)(module);
  })();
  return decoderInitialization;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return Uint8Array.from(bytes).buffer;
}

function readUint24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function parseVp8(payload: Buffer): ImageChunkInfo {
  if (payload.length < 10) invalidWebP("VP8 chunk is too short");
  if ((payload[0]! & 0x01) !== 0) invalidWebP("VP8 frame is not a key frame");
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
    invalidWebP("VP8 frame signature mismatch");
  }
  const width = payload.readUInt16LE(6) & 0x3fff;
  const height = payload.readUInt16LE(8) & 0x3fff;
  assertImageDimensions(width, height, invalidWebP);
  return { type: "VP8 ", width, height, hasAlpha: false };
}

function parseVp8l(payload: Buffer): ImageChunkInfo {
  if (payload.length < 5 || payload[0] !== 0x2f) {
    invalidWebP("VP8L frame signature mismatch");
  }
  const bits = payload.readUInt32LE(1);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  const hasAlpha = ((bits >>> 28) & 0x01) === 1;
  const version = bits >>> 29;
  if (version !== 0) invalidWebP("unsupported VP8L version");
  assertImageDimensions(width, height, invalidWebP);
  return { type: "VP8L", width, height, hasAlpha };
}

function parseContainer(buffer: Buffer): WebPContainerInfo {
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    invalidWebP("RIFF or WEBP signature mismatch");
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
    invalidWebP("RIFF length does not match the payload");
  }

  let offset = 12;
  let chunkCount = 0;
  let metadataBytes = 0;
  let vp8xFlags: number | undefined;
  let canvasWidth: number | undefined;
  let canvasHeight: number | undefined;
  let image: ImageChunkInfo | undefined;
  let previousType: string | undefined;
  let seenAlphaChunk = false;
  let seenIcc = false;
  let seenExif = false;
  let seenXmp = false;

  while (offset < buffer.length) {
    chunkCount += 1;
    if (chunkCount > MAX_CHUNKS) invalidWebP("chunk count exceeds the limit");
    if (buffer.length - offset < 8) invalidWebP("truncated chunk header");

    for (let index = offset; index < offset + 4; index += 1) {
      const byte = buffer[index]!;
      if (byte < 0x20 || byte > 0x7e) {
        invalidWebP("chunk type is invalid");
      }
    }
    const type = buffer.toString("latin1", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (length > buffer.length - payloadStart) invalidWebP("truncated chunk payload");
    const payloadEnd = payloadStart + length;
    const paddedEnd = payloadEnd + (length & 1);
    if (paddedEnd > buffer.length) invalidWebP("truncated chunk padding");
    if ((length & 1) === 1 && buffer[payloadEnd] !== 0) {
      invalidWebP("chunk padding byte must be zero");
    }
    const payload = buffer.subarray(payloadStart, payloadEnd);

    switch (type) {
      case "VP8X": {
        if (chunkCount !== 1 || vp8xFlags !== undefined || payload.length !== 10) {
          invalidWebP("VP8X must be the first chunk and exactly 10 bytes");
        }
        vp8xFlags = payload[0]!;
        if ((vp8xFlags & VP8X_RESERVED_FLAGS) !== 0) {
          invalidWebP("VP8X reserved flags are set");
        }
        if ((vp8xFlags & VP8X_ANIMATION_FLAG) !== 0) {
          invalidWebP("animated WebP is not supported");
        }
        if (payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) {
          invalidWebP("VP8X reserved bytes are nonzero");
        }
        canvasWidth = readUint24LE(payload, 4) + 1;
        canvasHeight = readUint24LE(payload, 7) + 1;
        assertImageDimensions(canvasWidth, canvasHeight, invalidWebP);
        break;
      }
      case "ALPH":
        if (vp8xFlags === undefined || seenAlphaChunk || image || payload.length === 0) {
          invalidWebP("ALPH chunk is invalid or out of order");
        }
        seenAlphaChunk = true;
        break;
      case "VP8 ":
      case "VP8L":
        if (image) invalidWebP("multiple image bitstream chunks are not supported");
        image = type === "VP8 " ? parseVp8(payload) : parseVp8l(payload);
        if (type === "VP8 " && seenAlphaChunk && previousType !== "ALPH") {
          invalidWebP("ALPH must immediately precede VP8");
        }
        if (type === "VP8L" && seenAlphaChunk) {
          invalidWebP("ALPH cannot accompany VP8L");
        }
        break;
      case "ICCP":
        if (vp8xFlags === undefined || seenIcc || image) {
          invalidWebP("ICCP chunk is invalid or out of order");
        }
        seenIcc = true;
        metadataBytes += length;
        break;
      case "EXIF":
        if (vp8xFlags === undefined || seenExif || !image) {
          invalidWebP("EXIF chunk is invalid or out of order");
        }
        seenExif = true;
        metadataBytes += length;
        break;
      case "XMP ":
        if (vp8xFlags === undefined || seenXmp || !image) {
          invalidWebP("XMP chunk is invalid or out of order");
        }
        seenXmp = true;
        metadataBytes += length;
        break;
      case "ANIM":
      case "ANMF":
        invalidWebP("animated WebP is not supported");
        break;
      default:
        if (vp8xFlags === undefined) {
          invalidWebP("simple WebP contains an unsupported extra chunk");
        }
        metadataBytes += length;
        break;
    }

    if (metadataBytes > MAX_METADATA_BYTES) {
      invalidWebP("metadata exceeds the byte limit");
    }
    previousType = type;
    offset = paddedEnd;
  }

  if (!image) invalidWebP("missing VP8 or VP8L image chunk");
  if (vp8xFlags === undefined) {
    if (chunkCount !== 1) invalidWebP("simple WebP must contain exactly one image chunk");
    return image;
  }

  if (image.width !== canvasWidth || image.height !== canvasHeight) {
    invalidWebP("VP8X canvas dimensions do not match the image bitstream");
  }
  const alphaFlag = (vp8xFlags & VP8X_ALPHA_FLAG) !== 0;
  const actualAlpha = image.type === "VP8 " ? seenAlphaChunk : image.hasAlpha;
  if (alphaFlag !== actualAlpha) invalidWebP("VP8X alpha flag does not match the image chunks");
  if (((vp8xFlags & VP8X_ICC_FLAG) !== 0) !== seenIcc) {
    invalidWebP("VP8X ICC flag does not match ICCP chunks");
  }
  if (((vp8xFlags & VP8X_EXIF_FLAG) !== 0) !== seenExif) {
    invalidWebP("VP8X EXIF flag does not match EXIF chunks");
  }
  if (((vp8xFlags & VP8X_XMP_FLAG) !== 0) !== seenXmp) {
    invalidWebP("VP8X XMP flag does not match XMP chunks");
  }

  return {
    width: image.width,
    height: image.height,
    hasAlpha: actualAlpha,
  };
}

export async function inspectWebP(buffer: Buffer): Promise<ImageInfo> {
  const container = parseContainer(buffer);

  try {
    await ensureDecoderInitialized();
    const input = toExactArrayBuffer(buffer);
    let decoded: ImageData | undefined = await decodeWebP(input);
    const decodedWidth = decoded.width;
    const decodedHeight = decoded.height;
    const decodedBytes = decoded.data.byteLength;
    decoded = undefined;

    if (
      decodedWidth !== container.width ||
      decodedHeight !== container.height ||
      decodedBytes !== container.width * container.height * 4
    ) {
      invalidWebP("decoded pixels do not match the container dimensions");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalidWebP("libwebp could not decode the image bitstream");
  }

  return {
    format: "webp",
    mimeType: "image/webp",
    width: container.width,
    height: container.height,
    hasAlpha: container.hasAlpha,
  };
}
