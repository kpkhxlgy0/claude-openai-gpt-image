import { inflateSync } from "node:zlib";
import { AppError } from "../errors.ts";
import {
  MAX_DECODED_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
  assertImageDimensions,
  type ImageInfo,
} from "./types.ts";

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHUNKS = 4096;
const MAX_ANCILLARY_BYTES = 8 * 1024 * 1024;

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

interface InflateInfoResult {
  buffer: Buffer;
  engine: { readonly bytesWritten: number };
}

type InflateSyncWithInfo = (
  buffer: Uint8Array,
  options: { info: true; maxOutputLength: number },
) => InflateInfoResult;

const inflateSyncWithInfo = inflateSync as unknown as InflateSyncWithInfo;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  CRC_TABLE[index] = value >>> 0;
}

function invalidPng(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", `Invalid PNG: ${message}`);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ CRC_TABLE[tableIndex]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function samplesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      invalidPng("unsupported color type");
  }
}

function assertBitDepth(colorType: number, bitDepth: number): void {
  const valid =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
  if (!valid) {
    invalidPng("bit depth is invalid for the color type");
  }
}

function parseHeader(data: Buffer): PngHeader {
  if (data.length !== 13) {
    invalidPng("IHDR must contain exactly 13 bytes");
  }

  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  assertImageDimensions(width, height, invalidPng);
  assertBitDepth(colorType, bitDepth);

  if (data[10] !== 0 || data[11] !== 0) {
    invalidPng("unsupported compression or filter method");
  }
  if (data[12] !== 0) {
    invalidPng("interlaced PNG data is not supported");
  }

  return { width, height, bitDepth, colorType };
}

function assertPalette(data: Buffer, header: PngHeader): number {
  if (header.colorType === 0 || header.colorType === 4) {
    invalidPng("PLTE is forbidden for grayscale color types");
  }
  if (data.length === 0 || data.length % 3 !== 0 || data.length > 768) {
    invalidPng("PLTE has an invalid length");
  }
  const entries = data.length / 3;
  if (header.colorType === 3 && entries > 2 ** header.bitDepth) {
    invalidPng("PLTE has more entries than the indexed bit depth permits");
  }
  return entries;
}

function assertTransparency(
  data: Buffer,
  header: PngHeader,
  paletteEntries: number | undefined,
): void {
  switch (header.colorType) {
    case 0:
      if (data.length !== 2) invalidPng("grayscale tRNS must be 2 bytes");
      return;
    case 2:
      if (data.length !== 6) invalidPng("truecolor tRNS must be 6 bytes");
      return;
    case 3:
      if (paletteEntries === undefined) {
        invalidPng("indexed tRNS requires an earlier PLTE chunk");
      }
      if (data.length === 0 || data.length > paletteEntries) {
        invalidPng("indexed tRNS has an invalid length");
      }
      return;
    default:
      invalidPng("tRNS is forbidden for color types with an alpha channel");
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function validateIndexedPixels(
  header: PngHeader,
  inflated: Buffer,
  rowBytes: number,
  paletteEntries: number,
): void {
  const bytesPerPixel = Math.max(1, Math.ceil(header.bitDepth / 8));
  const indexMask = (1 << header.bitDepth) - 1;
  let previousRow: Buffer | undefined;

  for (let row = 0; row < header.height; row += 1) {
    const scanlineOffset = row * (rowBytes + 1);
    const filter = inflated[scanlineOffset]!;
    const reconstructed = Buffer.alloc(rowBytes);
    for (let byteIndex = 0; byteIndex < rowBytes; byteIndex += 1) {
      const raw = inflated[scanlineOffset + 1 + byteIndex]!;
      const left = byteIndex >= bytesPerPixel ? reconstructed[byteIndex - bytesPerPixel]! : 0;
      const above = previousRow?.[byteIndex] ?? 0;
      const upperLeft =
        byteIndex >= bytesPerPixel ? (previousRow?.[byteIndex - bytesPerPixel] ?? 0) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      reconstructed[byteIndex] = (raw + predictor) & 0xff;
    }

    for (let pixel = 0; pixel < header.width; pixel += 1) {
      const bitOffset = pixel * header.bitDepth;
      const byte = reconstructed[Math.floor(bitOffset / 8)]!;
      const shift = 8 - header.bitDepth - (bitOffset % 8);
      const paletteIndex = (byte >>> shift) & indexMask;
      if (paletteIndex >= paletteEntries) {
        invalidPng("indexed pixel references a missing PLTE entry");
      }
    }
    previousRow = reconstructed;
  }
}

function validateScanlines(
  header: PngHeader,
  compressedParts: readonly Buffer[],
  paletteEntries: number | undefined,
): void {
  const samples = samplesPerPixel(header.colorType);
  const rowBits = header.width * samples * header.bitDepth;
  const rowBytes = Math.ceil(rowBits / 8);
  const expectedBytes = (rowBytes + 1) * header.height;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > MAX_DECODED_IMAGE_BYTES
  ) {
    invalidPng("decompressed scanlines exceed the supported limit");
  }

  const compressed =
    compressedParts.length === 1
      ? compressedParts[0]!
      : Buffer.concat(compressedParts);
  let inflated: Buffer;
  let consumedBytes: number;
  try {
    const result = inflateSyncWithInfo(compressed, {
      info: true,
      maxOutputLength: expectedBytes,
    });
    inflated = result.buffer;
    consumedBytes = result.engine.bytesWritten;
  } catch {
    invalidPng("IDAT data could not be inflated within the expected bound");
  }

  if (consumedBytes !== compressed.length) {
    invalidPng("IDAT contains bytes after the zlib stream");
  }
  if (inflated.length !== expectedBytes) {
    invalidPng("decompressed scanline length does not match IHDR");
  }
  for (let row = 0; row < header.height; row += 1) {
    if (inflated[row * (rowBytes + 1)]! > 4) {
      invalidPng("scanline uses an invalid filter type");
    }
  }
  if (header.colorType === 3) {
    if (paletteEntries === undefined) invalidPng("indexed PNG requires PLTE");
    validateIndexedPixels(header, inflated, rowBytes, paletteEntries);
  }
}

export function inspectPng(buffer: Buffer): ImageInfo {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    invalidPng("signature mismatch");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let ancillaryBytes = 0;
  let idatBytes = 0;
  let header: PngHeader | undefined;
  let paletteEntries: number | undefined;
  let seenTransparency = false;
  let seenIdat = false;
  let idatEnded = false;
  const compressedParts: Buffer[] = [];

  while (offset < buffer.length) {
    chunkCount += 1;
    if (chunkCount > MAX_CHUNKS) invalidPng("chunk count exceeds the limit");
    if (buffer.length - offset < 12) invalidPng("truncated chunk header");

    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    if (length > buffer.length - dataStart - 4) {
      invalidPng("truncated chunk payload");
    }
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    const typeBytes = buffer.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) invalidPng("chunk type is invalid");
    if ((typeBytes[2]! & 0x20) !== 0) {
      invalidPng("chunk type uses the reserved lowercase bit");
    }

    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) invalidPng(`${type} CRC mismatch`);

    const data = buffer.subarray(dataStart, dataEnd);
    if (chunkCount === 1 && type !== "IHDR") invalidPng("IHDR must be first");
    if (seenIdat && type !== "IDAT" && type !== "IEND") idatEnded = true;

    switch (type) {
      case "IHDR":
        if (chunkCount !== 1 || header) invalidPng("IHDR must appear exactly once first");
        header = parseHeader(data);
        break;
      case "PLTE":
        if (!header || paletteEntries !== undefined || seenTransparency || seenIdat) {
          invalidPng("PLTE is out of order");
        }
        paletteEntries = assertPalette(data, header);
        break;
      case "tRNS":
        if (!header || seenTransparency || seenIdat) invalidPng("tRNS is out of order");
        assertTransparency(data, header, paletteEntries);
        seenTransparency = true;
        ancillaryBytes += length;
        break;
      case "IDAT":
        if (!header || idatEnded) invalidPng("IDAT chunks must be consecutive");
        if (header.colorType === 3 && paletteEntries === undefined) {
          invalidPng("indexed PNG requires PLTE before IDAT");
        }
        seenIdat = true;
        idatBytes += length;
        if (idatBytes > MAX_IMAGE_BYTES) invalidPng("IDAT data exceeds the byte limit");
        compressedParts.push(data);
        break;
      case "IEND":
        if (!header || !seenIdat || length !== 0) invalidPng("IEND is invalid or premature");
        if (chunkEnd !== buffer.length) invalidPng("IEND must be the final chunk");
        validateScanlines(header, compressedParts, paletteEntries);
        return {
          format: "png",
          mimeType: "image/png",
          width: header.width,
          height: header.height,
          hasAlpha: header.colorType === 4 || header.colorType === 6 || seenTransparency,
        };
      default:
        if ((typeBytes[0]! & 0x20) === 0) {
          invalidPng(`unsupported critical chunk ${type}`);
        }
        ancillaryBytes += length;
        break;
    }

    if (ancillaryBytes > MAX_ANCILLARY_BYTES) {
      invalidPng("ancillary metadata exceeds the byte limit");
    }
    offset = chunkEnd;
  }

  invalidPng("missing IEND");
}
