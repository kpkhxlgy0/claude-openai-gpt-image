import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { inspectGif } from "../src/images/gif.ts";
import { inspectImage } from "../src/images/inspect-image.ts";
import { inspectOutputImage } from "../src/images/inspect-output.ts";
import {
  MAX_GIF_FRAMES,
  MAX_GIF_TOTAL_FRAME_PIXELS,
  MAX_IMAGE_PIXELS,
  type OutputImageFormat,
} from "../src/images/types.ts";
import {
  makeBaselineJpeg,
  makeGif,
  makeLosslessWebP,
  makePng,
} from "./helpers/image-fixtures.ts";

// Fixture layout: 6-byte signature, 7-byte logical screen descriptor, and a
// two-entry global color table. A single-frame, opaque fixture has no
// extensions, so its image descriptor starts right after the color table.
const FIRST_BLOCK = 6 + 7 + 6;

function isInputImageError(error: unknown): boolean {
  return error instanceof AppError && error.code === "INPUT_FILE_INVALID";
}

function rejectsGif(bytes: Uint8Array, pattern: RegExp): void {
  assert.throws(
    () => inspectGif(bytes),
    (error: unknown) =>
      isInputImageError(error) &&
      (error as AppError).message.startsWith("INPUT_FILE_INVALID: Invalid GIF: ") &&
      pattern.test((error as AppError).message),
  );
}

/**
 * Builds a GIF of `frames` full-screen frames whose image data is only a
 * clear code and an end code, so huge frames cost a few bytes each.
 */
function makeFrameHeavyGif(width: number, height: number, frames: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80;
  const globalColorTable = Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  // LZW minimum code size 2, one sub-block holding codes 4 (clear) and 5 (end).
  const imageData = Buffer.from([0x02, 0x01, 0x2c, 0x00]);
  const frame = Buffer.concat([descriptor, imageData]);
  return Buffer.concat([
    header,
    globalColorTable,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

function singleFrame(): Buffer {
  const bytes = makeGif({ width: 32, height: 16 });
  assert.equal(bytes[FIRST_BLOCK], 0x2c, "fixture image descriptor position");
  return Buffer.from(bytes);
}

test("inspectGif reports a single-frame GIF89a", () => {
  const bytes = makeGif({ width: 32, height: 16 });
  assert.equal(bytes.toString("ascii", 0, 6), "GIF89a");
  assert.deepEqual(inspectGif(bytes), {
    format: "gif",
    mimeType: "image/gif",
    width: 32,
    height: 16,
    hasAlpha: false,
    frameCount: 1,
  });
});

test("inspectGif counts frames and reports transparency from the Graphic Control Extension", () => {
  const bytes = makeGif({ width: 8, height: 4, frames: 3, transparent: true });
  assert.ok(bytes.includes("NETSCAPE2.0", 0, "ascii"), "fixture has a looping extension");
  assert.deepEqual(inspectGif(bytes), {
    format: "gif",
    mimeType: "image/gif",
    width: 8,
    height: 4,
    hasAlpha: true,
    frameCount: 3,
  });
});

test("inspectGif reports opaque multi-frame GIFs without alpha", () => {
  const info = inspectGif(makeGif({ width: 8, height: 4, frames: 3 }));
  assert.equal(info.frameCount, 3);
  assert.equal(info.hasAlpha, false);
});

test("inspectGif accepts GIF87a", () => {
  const bytes = makeGif({ width: 5, height: 3, version: "87a" });
  assert.equal(bytes.toString("ascii", 0, 6), "GIF87a");
  assert.deepEqual(inspectGif(bytes), {
    format: "gif",
    mimeType: "image/gif",
    width: 5,
    height: 3,
    hasAlpha: false,
    frameCount: 1,
  });
});

test("inspectGif accepts exactly the frame limit", () => {
  const info = inspectGif(makeGif({ width: 1, height: 1, frames: MAX_GIF_FRAMES }));
  assert.equal(info.frameCount, MAX_GIF_FRAMES);
});

test("inspectGif rejects truncation after the header", () => {
  const bytes = singleFrame();
  rejectsGif(bytes.subarray(0, 6), /logical screen/);
  rejectsGif(bytes.subarray(0, 13), /global color table/);
  rejectsGif(bytes.subarray(0, FIRST_BLOCK), /missing trailer/);
});

test("inspectGif rejects a missing trailer", () => {
  rejectsGif(singleFrame().subarray(0, -1), /missing trailer/);
});

test("inspectGif rejects bytes after the trailer", () => {
  rejectsGif(Buffer.concat([singleFrame(), Buffer.from([0x00])]), /follows the trailer/);
});

test("inspectGif rejects a GIF with zero frames", () => {
  const bytes = Buffer.concat([singleFrame().subarray(0, FIRST_BLOCK), Buffer.from([0x3b])]);
  rejectsGif(bytes, /no image frames/);
});

test("inspectGif rejects frames outside the logical screen", () => {
  const shiftedLeft = singleFrame();
  shiftedLeft.writeUInt16LE(1, FIRST_BLOCK + 1);
  rejectsGif(shiftedLeft, /outside the logical screen/);

  const shiftedDown = singleFrame();
  shiftedDown.writeUInt16LE(1, FIRST_BLOCK + 3);
  rejectsGif(shiftedDown, /outside the logical screen/);

  const tooWide = singleFrame();
  tooWide.writeUInt16LE(33, FIRST_BLOCK + 5);
  rejectsGif(tooWide, /outside the logical screen/);
});

test("inspectGif rejects zero-sized frames", () => {
  const zeroWidth = singleFrame();
  zeroWidth.writeUInt16LE(0, FIRST_BLOCK + 5);
  rejectsGif(zeroWidth, /frame dimensions must be nonzero/);

  const zeroHeight = singleFrame();
  zeroHeight.writeUInt16LE(0, FIRST_BLOCK + 7);
  rejectsGif(zeroHeight, /frame dimensions must be nonzero/);
});

test("inspectGif rejects LZW minimum code sizes outside 2 through 8", () => {
  for (const codeSize of [0, 1, 9, 12]) {
    const bytes = singleFrame();
    bytes[FIRST_BLOCK + 10] = codeSize;
    rejectsGif(bytes, /LZW minimum code size/);
  }
});

test("inspectGif rejects a frame without image data sub-blocks", () => {
  const bytes = Buffer.concat([
    singleFrame().subarray(0, FIRST_BLOCK + 11),
    Buffer.from([0x00, 0x3b]),
  ]);
  rejectsGif(bytes, /no image data/);
});

test("inspectGif rejects truncation inside image data", () => {
  const bytes = singleFrame();
  rejectsGif(bytes.subarray(0, FIRST_BLOCK + 20), /truncated data sub-block/);
  rejectsGif(bytes.subarray(0, FIRST_BLOCK + 5), /truncated image descriptor/);
});

test("inspectGif rejects an unknown block introducer", () => {
  const bytes = singleFrame();
  bytes[FIRST_BLOCK] = 0x99;
  rejectsGif(bytes, /unknown block introducer/);
});

test("inspectGif rejects a malformed Graphic Control Extension", () => {
  const bytes = makeGif({ width: 4, height: 4, transparent: true });
  const extension = bytes.indexOf(Buffer.from([0x21, 0xf9]), FIRST_BLOCK);
  assert.equal(extension, FIRST_BLOCK, "fixture Graphic Control Extension position");

  const wrongSize = Buffer.from(bytes);
  wrongSize[extension + 2] = 5;
  rejectsGif(wrongSize, /Graphic Control Extension/);

  const missingTerminator = Buffer.from(bytes);
  missingTerminator[extension + 7] = 1;
  rejectsGif(missingTerminator, /Graphic Control Extension/);
});

test("inspectGif rejects a truncated local color table", () => {
  const bytes = singleFrame();
  // Local color table flag with 256 entries (768 bytes), more than remain in the file.
  bytes[FIRST_BLOCK + 9] = 0x87;
  rejectsGif(bytes, /truncated local color table/);
});

test("inspectGif bounds the total pixels declared by all frames", () => {
  assert.equal(MAX_GIF_TOTAL_FRAME_PIXELS, 16 * MAX_IMAGE_PIXELS);
  assert.equal(16_384 * 1024, MAX_IMAGE_PIXELS);

  const atLimit = makeFrameHeavyGif(16_384, 1024, 16);
  assert.equal(inspectGif(atLimit).frameCount, 16);

  rejectsGif(makeFrameHeavyGif(16_384, 1024, 17), /frames exceed the total pixel limit/);

  const audited = makeFrameHeavyGif(16_384, 1024, MAX_GIF_FRAMES);
  assert.ok(audited.length < 4096, `audit example is ${audited.length} bytes`);
  rejectsGif(audited, /frames exceed the total pixel limit/);
});

test("inspectGif rejects truncated extensions", () => {
  const bytes = makeGif({ width: 4, height: 4, frames: 2 });
  rejectsGif(bytes.subarray(0, FIRST_BLOCK + 1), /truncated extension/);
  rejectsGif(bytes.subarray(0, FIRST_BLOCK + 8), /truncated data sub-block/);
});

test("inspectGif rejects more frames than the limit", () => {
  rejectsGif(makeGif({ width: 1, height: 1, frames: MAX_GIF_FRAMES + 1 }), /frame count/);
});

test("inspectGif rejects invalid logical screen dimensions", () => {
  const zero = singleFrame();
  zero.writeUInt16LE(0, 6);
  rejectsGif(zero, /nonzero/);

  const tooWide = singleFrame();
  tooWide.writeUInt16LE(16_385, 6);
  rejectsGif(tooWide, /edge limit/);

  const tooManyPixels = singleFrame();
  tooManyPixels.writeUInt16LE(8192, 6);
  tooManyPixels.writeUInt16LE(4096, 8);
  rejectsGif(tooManyPixels, /pixel count/);
});

test("inspectGif rejects other image formats", () => {
  rejectsGif(makePng(), /signature/);
  rejectsGif(makeBaselineJpeg(), /signature/);
  rejectsGif(Buffer.from("GIF90a"), /signature/);
});

test("inspectOutputImage delegates raster formats to inspectImage", async () => {
  const png = makePng({ width: 3, height: 2 });
  assert.deepEqual(await inspectOutputImage(png, "png"), await inspectImage(png));

  const jpeg = makeBaselineJpeg();
  assert.deepEqual(await inspectOutputImage(jpeg, "jpeg"), await inspectImage(jpeg));

  const webp = makeLosslessWebP();
  assert.deepEqual(await inspectOutputImage(webp, "webp"), await inspectImage(webp));
});

test("inspectOutputImage enforces the expected format", async () => {
  const gif = makeGif({ width: 32, height: 16, frames: 2 });
  assert.deepEqual(await inspectOutputImage(gif, "gif"), inspectGif(gif));
  await assert.rejects(() => inspectOutputImage(gif, "png"), isInputImageError);
  await assert.rejects(() => inspectOutputImage(makePng(), "gif"), isInputImageError);
  await assert.rejects(() => inspectOutputImage(gif, "svg"), isInputImageError);
});

test("inspectOutputImage rejects formats outside the output format union", async () => {
  for (const format of ["SVG", "bmp", "", "GIF", "image/png"]) {
    await assert.rejects(
      () => inspectOutputImage(makeGif(), format as OutputImageFormat),
      (error: unknown) =>
        isInputImageError(error) &&
        (error as AppError).message === "INPUT_FILE_INVALID: Unsupported output image format",
      JSON.stringify(format),
    );
  }
});

test("inspectImage still rejects GIF input", async () => {
  await assert.rejects(() => inspectImage(makeGif()), isInputImageError);
});
