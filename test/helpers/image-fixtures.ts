import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const BASELINE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";

const PROGRESSIVE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wgARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABUBAQEAAAAAAAAAAAAAAAAAAAYI/9oADAMBAAIQAxAAAAE5C1T/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQ/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==";

const LOSSY_WEBP_BASE64 =
  "UklGRl4AAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAwAAAA0AEAnQEqAwACAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA";

const LOSSLESS_WEBP_BASE64 =
  "UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAEAfQ/4gCBiKi/wEA";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface PngChunkFixture {
  type: string;
  data: Uint8Array;
}

export function makePngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return chunk;
}

export function makePngIhdr(options: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
}): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(options.width, 0);
  data.writeUInt32BE(options.height, 4);
  data[8] = options.bitDepth ?? 8;
  data[9] = options.colorType ?? 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = options.interlace ?? 0;
  return data;
}

export function buildPng(chunks: readonly PngChunkFixture[]): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ...chunks.map(({ type, data }) => makePngChunk(type, data)),
  ]);
}

function channelsForColorType(colorType: number): number {
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
      throw new Error(`unsupported fixture color type ${colorType}`);
  }
}

export function makePng(options: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  rawScanlines?: Uint8Array;
  extraChunks?: readonly PngChunkFixture[];
} = {}): Buffer {
  const width = options.width ?? 3;
  const height = options.height ?? 2;
  const bitDepth = options.bitDepth ?? 8;
  const colorType = options.colorType ?? 6;
  const rowBytes = Math.ceil((width * channelsForColorType(colorType) * bitDepth) / 8);
  const raw = options.rawScanlines
    ? Buffer.from(options.rawScanlines)
    : Buffer.alloc((rowBytes + 1) * height);

  if (!options.rawScanlines) {
    for (let row = 0; row < height; row += 1) {
      const start = row * (rowBytes + 1);
      raw[start] = 0;
      raw.fill(0x7f, start + 1, start + rowBytes + 1);
    }
  }

  return buildPng([
    {
      type: "IHDR",
      data: makePngIhdr({
        width,
        height,
        bitDepth,
        colorType,
        ...(options.interlace === undefined
          ? {}
          : { interlace: options.interlace }),
      }),
    },
    ...(options.extraChunks ?? []),
    { type: "IDAT", data: deflateSync(raw) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
}

export function makeBaselineJpeg(): Buffer {
  return Buffer.from(BASELINE_JPEG_BASE64, "base64");
}

export function makeProgressiveJpeg(): Buffer {
  return Buffer.from(PROGRESSIVE_JPEG_BASE64, "base64");
}

export function makeLossyWebP(): Buffer {
  return Buffer.from(LOSSY_WEBP_BASE64, "base64");
}

export function makeLosslessWebP(): Buffer {
  return Buffer.from(LOSSLESS_WEBP_BASE64, "base64");
}

export function makeTruncatedWebP(bytes: Buffer): Buffer {
  const truncated = Buffer.from(bytes.subarray(0, -2));
  truncated.writeUInt32LE(truncated.length - 8, 4);
  return truncated;
}

export function corruptWebPBitstream(bytes: Buffer): Buffer {
  const corrupted = Buffer.from(bytes);
  const imageChunk = corrupted.indexOf("VP8L", 12, "ascii");
  if (imageChunk < 0) {
    throw new Error("fixture has no VP8L chunk");
  }
  const payloadLength = corrupted.readUInt32LE(imageChunk + 4);
  const payloadStart = imageChunk + 8;
  const corruptionStart = payloadStart + 5;
  corrupted.fill(0xff, corruptionStart, payloadStart + payloadLength);
  return corrupted;
}
