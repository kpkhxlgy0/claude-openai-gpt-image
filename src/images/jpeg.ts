import { AppError } from "../errors.ts";
import { assertImageDimensions, type ImageInfo } from "./types.ts";

const MAX_SEGMENTS = 4096;
const MAX_SCANS = 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const SUPPORTED_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);
const ALL_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);
const LENGTH_DELIMITED_MARKERS = new Set([0xc4, 0xcc, 0xda, 0xdb, 0xdd, 0xfe]);

interface JpegFrame {
  width: number;
  height: number;
  progressive: boolean;
  componentIds: ReadonlySet<number>;
}

function invalidJpeg(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", `Invalid JPEG: ${message}`);
}

function parseFrame(marker: number, data: Buffer): JpegFrame {
  if (!SUPPORTED_SOF_MARKERS.has(marker)) {
    invalidJpeg("unsupported Start of Frame marker");
  }
  if (data.length < 6) invalidJpeg("truncated Start of Frame segment");

  const precision = data[0]!;
  if ((marker === 0xc0 && precision !== 8) || ![8, 12].includes(precision)) {
    invalidJpeg("unsupported sample precision");
  }
  const height = data.readUInt16BE(1);
  const width = data.readUInt16BE(3);
  const componentCount = data[5]!;
  if (componentCount === 0 || componentCount > 4) {
    invalidJpeg("invalid frame component count");
  }
  if (data.length !== 6 + componentCount * 3) {
    invalidJpeg("Start of Frame length does not match its component count");
  }
  assertImageDimensions(width, height, invalidJpeg);

  const componentIds = new Set<number>();
  for (let index = 0; index < componentCount; index += 1) {
    const componentOffset = 6 + index * 3;
    const id = data[componentOffset]!;
    const sampling = data[componentOffset + 1]!;
    const horizontal = sampling >>> 4;
    const vertical = sampling & 0x0f;
    const quantizationTable = data[componentOffset + 2]!;
    if (componentIds.has(id)) invalidJpeg("duplicate frame component ID");
    if (horizontal === 0 || horizontal > 4 || vertical === 0 || vertical > 4) {
      invalidJpeg("invalid frame sampling factor");
    }
    if (quantizationTable > 3) invalidJpeg("invalid quantization table selector");
    componentIds.add(id);
  }

  return {
    width,
    height,
    progressive: marker === 0xc2,
    componentIds,
  };
}

function validateQuantizationTables(data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const descriptor = data[offset++]!;
    const precision = descriptor >>> 4;
    const tableId = descriptor & 0x0f;
    if (precision > 1 || tableId > 3) invalidJpeg("invalid DQT table descriptor");
    const tableBytes = precision === 0 ? 64 : 128;
    if (data.length - offset < tableBytes) invalidJpeg("truncated DQT table");
    offset += tableBytes;
  }
  if (offset !== data.length) invalidJpeg("invalid DQT segment length");
}

function validateHuffmanTables(data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 17) invalidJpeg("truncated DHT table");
    const descriptor = data[offset++]!;
    if ((descriptor >>> 4) > 1 || (descriptor & 0x0f) > 3) {
      invalidJpeg("invalid DHT table descriptor");
    }
    let symbolCount = 0;
    for (let index = 0; index < 16; index += 1) {
      symbolCount += data[offset + index]!;
    }
    offset += 16;
    if (symbolCount === 0 || symbolCount > 256 || data.length - offset < symbolCount) {
      invalidJpeg("invalid DHT symbol count");
    }
    offset += symbolCount;
  }
  if (offset !== data.length) invalidJpeg("invalid DHT segment length");
}

function validateScanHeader(data: Buffer, frame: JpegFrame): void {
  if (data.length < 4) invalidJpeg("truncated Start of Scan segment");
  const componentCount = data[0]!;
  if (componentCount === 0 || componentCount > frame.componentIds.size) {
    invalidJpeg("invalid scan component count");
  }
  if (data.length !== 4 + componentCount * 2) {
    invalidJpeg("Start of Scan length does not match its component count");
  }

  const scanComponents = new Set<number>();
  for (let index = 0; index < componentCount; index += 1) {
    const componentOffset = 1 + index * 2;
    const id = data[componentOffset]!;
    const selectors = data[componentOffset + 1]!;
    if (!frame.componentIds.has(id) || scanComponents.has(id)) {
      invalidJpeg("scan references an invalid or duplicate component");
    }
    if ((selectors >>> 4) > 3 || (selectors & 0x0f) > 3) {
      invalidJpeg("invalid Huffman table selector");
    }
    scanComponents.add(id);
  }

  const spectralOffset = 1 + componentCount * 2;
  const spectralStart = data[spectralOffset]!;
  const spectralEnd = data[spectralOffset + 1]!;
  const approximation = data[spectralOffset + 2]!;
  const successiveHigh = approximation >>> 4;
  const successiveLow = approximation & 0x0f;

  if (!frame.progressive) {
    if (
      spectralStart !== 0 ||
      spectralEnd !== 63 ||
      successiveHigh !== 0 ||
      successiveLow !== 0
    ) {
      invalidJpeg("sequential scan has invalid spectral parameters");
    }
    return;
  }

  if (spectralStart > spectralEnd || spectralEnd > 63) {
    invalidJpeg("progressive scan has invalid spectral bounds");
  }
  if (spectralStart === 0 && spectralEnd !== 0) {
    invalidJpeg("progressive DC scan must end at coefficient zero");
  }
  if (spectralStart > 0 && componentCount !== 1) {
    invalidJpeg("progressive AC scans must contain exactly one component");
  }
  if (successiveHigh > 13 || successiveLow > 13) {
    invalidJpeg("progressive successive approximation is out of range");
  }
  if (successiveHigh !== 0 && successiveHigh !== successiveLow + 1) {
    invalidJpeg("progressive successive approximation order is invalid");
  }
}

function findEntropyEnd(buffer: Buffer, start: number): number {
  let offset = start;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const markerStart = offset;
    offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) invalidJpeg("truncated entropy marker");

    const marker = buffer[offset]!;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerStart;
  }

  invalidJpeg("entropy stream is missing a terminating marker");
}

function assertTrailingPadding(buffer: Buffer, offset: number): void {
  for (let index = offset; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x00 && buffer[index] !== 0xff) {
      invalidJpeg("non-padding data follows End of Image");
    }
  }
}

export function inspectJpeg(buffer: Buffer): ImageInfo {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    invalidJpeg("missing Start of Image marker");
  }

  let offset = 2;
  let segmentCount = 0;
  let scanCount = 0;
  let metadataBytes = 0;
  let frame: JpegFrame | undefined;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) invalidJpeg("marker prefix is missing");
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) invalidJpeg("truncated marker");

    const marker = buffer[offset++]!;
    if (marker === 0x00) invalidJpeg("stuffed byte appears outside entropy data");
    if (marker === 0xd9) {
      if (!frame || scanCount === 0) invalidJpeg("End of Image is premature");
      assertTrailingPadding(buffer, offset);
      return {
        format: "jpeg",
        mimeType: "image/jpeg",
        width: frame.width,
        height: frame.height,
        hasAlpha: false,
      };
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      invalidJpeg("standalone marker appears outside entropy data");
    }
    const isApplicationMarker = marker >= 0xe0 && marker <= 0xef;
    if (
      !ALL_SOF_MARKERS.has(marker) &&
      !LENGTH_DELIMITED_MARKERS.has(marker) &&
      !isApplicationMarker
    ) {
      invalidJpeg("reserved or unsupported marker");
    }

    segmentCount += 1;
    if (segmentCount > MAX_SEGMENTS) invalidJpeg("segment count exceeds the limit");
    if (buffer.length - offset < 2) invalidJpeg("truncated segment length");
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || segmentLength > buffer.length - offset) {
      invalidJpeg("invalid or truncated segment length");
    }
    const dataStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    const data = buffer.subarray(dataStart, segmentEnd);

    if (ALL_SOF_MARKERS.has(marker)) {
      if (frame) invalidJpeg("multiple Start of Frame segments are not supported");
      frame = parseFrame(marker, data);
    } else if (marker === 0xdb) {
      validateQuantizationTables(data);
    } else if (marker === 0xc4) {
      validateHuffmanTables(data);
    } else if (marker === 0xdd) {
      if (data.length !== 2) invalidJpeg("DRI must contain exactly two bytes");
    } else if (marker === 0xda) {
      if (!frame) invalidJpeg("Start of Scan appears before Start of Frame");
      scanCount += 1;
      if (scanCount > MAX_SCANS) invalidJpeg("scan count exceeds the limit");
      validateScanHeader(data, frame);
      const entropyStart = segmentEnd;
      const entropyEnd = findEntropyEnd(buffer, entropyStart);
      if (entropyEnd === entropyStart) invalidJpeg("entropy stream is empty");
      offset = entropyEnd;
      continue;
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      metadataBytes += data.length;
      if (metadataBytes > MAX_METADATA_BYTES) {
        invalidJpeg("metadata exceeds the byte limit");
      }
    } else if (marker === 0xcc) {
      invalidJpeg("arithmetic coding is not supported");
    }

    offset = segmentEnd;
  }

  invalidJpeg("missing End of Image marker");
}
