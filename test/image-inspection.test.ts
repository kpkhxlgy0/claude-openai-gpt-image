import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { inspectImage } from "../src/images/inspect-image.ts";
import { decodeStrictBase64 } from "../src/images/strict-base64.ts";
import {
  buildPng,
  corruptWebPBitstream,
  makeBaselineJpeg,
  makeLosslessWebP,
  makeLossyWebP,
  makePng,
  makePngIhdr,
  makeProgressiveJpeg,
  makeTruncatedWebP,
} from "./helpers/image-fixtures.ts";

function isInputImageError(error: unknown): boolean {
  return error instanceof AppError && error.code === "INPUT_FILE_INVALID";
}

function isProviderPayloadError(error: unknown): boolean {
  return error instanceof AppError && error.code === "INVALID_PROVIDER_RESPONSE";
}

test("decodeStrictBase64 accepts canonical padded and unpadded encodings", () => {
  assert.deepEqual(decodeStrictBase64("TQ==", 1), Buffer.from("M"));
  assert.deepEqual(decodeStrictBase64("TWE=", 2), Buffer.from("Ma"));
  assert.deepEqual(decodeStrictBase64("TWFu", 3), Buffer.from("Man"));
});

test("decodeStrictBase64 rejects whitespace, nonalphabet bytes, and noncanonical padding", () => {
  for (const value of [
    " TQ==",
    "TQ==\n",
    "T Q==",
    "TQ-_",
    "TQ!=",
    "TQ",
    "TQ=",
    "TQ===",
    "A===",
    "TR==",
    "TWF=",
  ]) {
    assert.throws(() => decodeStrictBase64(value, 32), isProviderPayloadError, value);
  }
});

test("decodeStrictBase64 enforces the decoded byte limit before accepting data", () => {
  assert.throws(() => decodeStrictBase64("AQID", 2), isProviderPayloadError);
  assert.throws(() => decodeStrictBase64("", -1), isProviderPayloadError);
});

test("inspectImage extracts trusted PNG dimensions, MIME, and alpha capability", async () => {
  assert.deepEqual(await inspectImage(makePng({ width: 3, height: 2 })), {
    format: "png",
    mimeType: "image/png",
    width: 3,
    height: 2,
    hasAlpha: true,
  });

  assert.equal(
    (await inspectImage(makePng({ width: 2, height: 1, colorType: 2 }))).hasAlpha,
    false,
  );
});

test("inspectImage rejects PNG CRC corruption and truncated chunks", async () => {
  const corrupted = Buffer.from(makePng());
  corrupted[20] = corrupted[20]! ^ 0x01;
  await assert.rejects(() => inspectImage(corrupted), isInputImageError);

  const truncated = makePng().subarray(0, -2);
  await assert.rejects(() => inspectImage(truncated), isInputImageError);
});

test("inspectImage rejects illegal PNG chunk order", async () => {
  const image = buildPng([
    { type: "IDAT", data: deflateSync(Buffer.from([0, 0, 0, 0, 0])) },
    { type: "IHDR", data: makePngIhdr({ width: 1, height: 1 }) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage rejects PNG chunks ordered PLTE after tRNS", async () => {
  const image = buildPng([
    { type: "IHDR", data: makePngIhdr({ width: 1, height: 1, colorType: 2 }) },
    { type: "tRNS", data: Buffer.alloc(6) },
    { type: "PLTE", data: Buffer.from([0, 0, 0]) },
    { type: "IDAT", data: deflateSync(Buffer.from([0, 0, 0, 0])) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage rejects PNG chunk types with the reserved lowercase bit", async () => {
  const image = buildPng([
    { type: "IHDR", data: makePngIhdr({ width: 1, height: 1 }) },
    { type: "abca", data: Buffer.alloc(0) },
    { type: "IDAT", data: deflateSync(Buffer.from([0, 0, 0, 0, 0])) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage rejects bytes after the complete PNG zlib stream", async () => {
  const compressed = deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  const image = buildPng([
    { type: "IHDR", data: makePngIhdr({ width: 1, height: 1 }) },
    { type: "IDAT", data: Buffer.concat([compressed, Buffer.from([1, 2, 3])]) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage validates indexed PNG pixels against PLTE after filter reconstruction", async () => {
  const palette = [
    { type: "PLTE", data: Buffer.from([0, 0, 0, 255, 255, 255]) },
  ];
  assert.deepEqual(
    await inspectImage(
      makePng({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 3,
        rawScanlines: Buffer.from([0, 0]),
        extraChunks: palette,
      }),
    ),
    {
      format: "png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      hasAlpha: false,
    },
  );
  await assert.rejects(
    () =>
      inspectImage(
        makePng({
          width: 2,
          height: 1,
          bitDepth: 8,
          colorType: 3,
          rawScanlines: Buffer.from([1, 1, 1]),
          extraChunks: palette,
        }),
      ),
    isInputImageError,
  );
});

test("inspectImage rejects oversized and interlaced PNG headers", async () => {
  const oversized = makePng({
    width: 20_000,
    height: 20_000,
    rawScanlines: Buffer.from([0]),
  });
  await assert.rejects(() => inspectImage(oversized), isInputImageError);
  await assert.rejects(
    () => inspectImage(makePng({ interlace: 1 })),
    isInputImageError,
  );
});

test("inspectImage bounds PNG inflation and validates scanline filters", async () => {
  const overInflated = makePng({
    width: 1,
    height: 1,
    rawScanlines: Buffer.alloc(1024),
  });
  await assert.rejects(() => inspectImage(overInflated), isInputImageError);

  const invalidFilter = makePng({
    width: 1,
    height: 1,
    rawScanlines: Buffer.from([5, 0, 0, 0, 0]),
  });
  await assert.rejects(() => inspectImage(invalidFilter), isInputImageError);
});

test("inspectImage validates baseline and progressive JPEG marker streams", async () => {
  assert.deepEqual(await inspectImage(makeBaselineJpeg()), {
    format: "jpeg",
    mimeType: "image/jpeg",
    width: 3,
    height: 2,
    hasAlpha: false,
  });
  assert.deepEqual(await inspectImage(makeProgressiveJpeg()), {
    format: "jpeg",
    mimeType: "image/jpeg",
    width: 3,
    height: 2,
    hasAlpha: false,
  });
});

test("inspectImage rejects reserved JPEG markers", async () => {
  const valid = makeBaselineJpeg();
  const image = Buffer.concat([
    valid.subarray(0, 2),
    Buffer.from([0xff, 0x02, 0x00, 0x02]),
    valid.subarray(2),
  ]);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage rejects invalid JPEG segment lengths", async () => {
  const image = makeBaselineJpeg();
  image.writeUInt16BE(1, 4);
  await assert.rejects(() => inspectImage(image), isInputImageError);
});

test("inspectImage rejects JPEG streams without EOI and truncated entropy data", async () => {
  const missingEoi = Buffer.from(makeBaselineJpeg());
  missingEoi.fill(0, missingEoi.length - 2);
  await assert.rejects(() => inspectImage(missingEoi), isInputImageError);

  const complete = makeBaselineJpeg();
  const sos = complete.indexOf(Buffer.from([0xff, 0xda]));
  assert.notEqual(sos, -1);
  const entropyStart = sos + 2 + complete.readUInt16BE(sos + 2);
  const truncatedEntropy = complete.subarray(0, entropyStart + 1);
  await assert.rejects(() => inspectImage(truncatedEntropy), isInputImageError);
});

test("inspectImage rejects non-padding data after JPEG EOI", async () => {
  await assert.rejects(
    () => inspectImage(Buffer.concat([makeBaselineJpeg(), Buffer.from([0x01])])),
    isInputImageError,
  );
});

test("inspectImage fully decodes lossy and lossless WebP fixtures", async () => {
  assert.deepEqual(await inspectImage(makeLossyWebP()), {
    format: "webp",
    mimeType: "image/webp",
    width: 3,
    height: 2,
    hasAlpha: true,
  });
  assert.deepEqual(await inspectImage(makeLosslessWebP()), {
    format: "webp",
    mimeType: "image/webp",
    width: 3,
    height: 2,
    hasAlpha: true,
  });
});

test("inspectImage rejects WebP RIFF length mismatch and truncated chunks", async () => {
  const mismatched = makeLossyWebP();
  mismatched.writeUInt32LE(mismatched.readUInt32LE(4) + 1, 4);
  await assert.rejects(() => inspectImage(mismatched), isInputImageError);

  await assert.rejects(
    () => inspectImage(makeTruncatedWebP(makeLosslessWebP())),
    isInputImageError,
  );
});

test("inspectImage rejects a framed WebP whose libwebp bitstream decode fails", async () => {
  await assert.rejects(
    () => inspectImage(corruptWebPBitstream(makeLosslessWebP())),
    isInputImageError,
  );
});

test("inspectImage rejects malformed provider bytes and expected-format mismatch", async () => {
  const malformedBytes = decodeStrictBase64(
    corruptWebPBitstream(makeLosslessWebP()).toString("base64"),
    1024,
  );
  await assert.rejects(
    () => inspectImage(malformedBytes, "webp"),
    isInputImageError,
  );
  await assert.rejects(
    () => inspectImage(makePng(), "jpeg"),
    isInputImageError,
  );
  await assert.rejects(
    () => inspectImage(Buffer.from("not an image")),
    isInputImageError,
  );
});
