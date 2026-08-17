import assert from "node:assert/strict";
import test from "node:test";
import {
  editImageSchema,
  generateImageSchema,
  parseImageSize,
  statusSchema,
} from "../src/schemas.ts";

function assertThrowsValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof Error);
}

test("statusSchema accepts empty objects and rejects unknown fields", () => {
  assert.deepEqual(statusSchema.parse({}), {});
  assertThrowsValidation(() => statusSchema.parse({ unexpected: true }));
});

test("generateImageSchema applies defaults and trims prompts", () => {
  const parsed = generateImageSchema.parse({
    prompt: "  a red cube  ",
  });
  assert.equal(parsed.prompt, "a red cube");
  assert.equal(parsed.quality, "auto");
  assert.equal(parsed.size, "1024x1024");
  assert.equal(parsed.output_format, "png");
  assert.equal(parsed.moderation, "auto");
  assert.equal("output_compression" in parsed, false);
  assert.equal("output_path" in parsed, false);
  assert.equal("workspace_root" in parsed, false);
});

test("generateImageSchema enforces prompt limits and rejects unknown fields", () => {
  assertThrowsValidation(() => generateImageSchema.parse({ prompt: "" }));
  assertThrowsValidation(() => generateImageSchema.parse({ prompt: "   " }));
  assertThrowsValidation(() =>
    generateImageSchema.parse({ prompt: "x".repeat(32_001) }),
  );
  assertThrowsValidation(() =>
    generateImageSchema.parse({
      prompt: "ok",
      unexpected: true,
    }),
  );
  const max = generateImageSchema.parse({ prompt: "x".repeat(32_000) });
  assert.equal(max.prompt.length, 32_000);
});

test("parseImageSize accepts auto, presets, and valid custom sizes", () => {
  assert.equal(parseImageSize("auto"), null);
  assert.deepEqual(parseImageSize("1024x1024"), { width: 1024, height: 1024 });
  assert.deepEqual(parseImageSize("1536x1024"), { width: 1536, height: 1024 });
  assert.deepEqual(parseImageSize("1024x1536"), { width: 1024, height: 1536 });
  assert.deepEqual(parseImageSize("1280x720"), { width: 1280, height: 720 });
  assert.deepEqual(parseImageSize("3840x1280"), { width: 3840, height: 1280 });
});

test("parseImageSize and generate schema reject invalid sizes", () => {
  for (const size of [
    "100x100",
    "1025x1024",
    "4000x4000",
    "3840x1008",
    "16x16",
    "1024",
    "1024x",
    "x1024",
    "1024X1024",
  ]) {
    assert.throws(() => parseImageSize(size), (error: unknown) => {
      return error instanceof Error && /INVALID_INPUT|invalid/i.test(error.message);
    });
    assertThrowsValidation(() =>
      generateImageSchema.parse({ prompt: "ok", size }),
    );
  }
});

test("PNG compression zero is omitted while nonzero PNG compression is rejected", () => {
  const normalized = generateImageSchema.parse({
    prompt: "ok",
    output_format: "png",
    output_compression: 0,
  });
  assert.equal("output_compression" in normalized, false);

  assertThrowsValidation(() =>
    generateImageSchema.parse({
      prompt: "ok",
      output_format: "png",
      output_compression: 1,
    }),
  );

  const implicitPng = generateImageSchema.parse({
    prompt: "ok",
    output_compression: 0,
  });
  assert.equal(implicitPng.output_format, "png");
  assert.equal("output_compression" in implicitPng, false);
});

test("JPEG and WebP accept compression 0-100", () => {
  for (const format of ["jpeg", "webp"] as const) {
    const zero = generateImageSchema.parse({
      prompt: "ok",
      output_format: format,
      output_compression: 0,
    });
    assert.equal(zero.output_compression, 0);

    const max = generateImageSchema.parse({
      prompt: "ok",
      output_format: format,
      output_compression: 100,
    });
    assert.equal(max.output_compression, 100);
  }

  assertThrowsValidation(() =>
    generateImageSchema.parse({
      prompt: "ok",
      output_format: "jpeg",
      output_compression: 101,
    }),
  );
  assertThrowsValidation(() =>
    generateImageSchema.parse({
      prompt: "ok",
      output_format: "webp",
      output_compression: -1,
    }),
  );
});

test("editImageSchema validates image counts, mask path type, and omits moderation", () => {
  const parsed = editImageSchema.parse({
    prompt: "edit this",
    image_paths: ["a.png"],
  });
  assert.deepEqual(parsed.image_paths, ["a.png"]);
  assert.equal("mask_path" in parsed, false);
  assert.equal("moderation" in parsed, false);

  const withMask = editImageSchema.parse({
    prompt: "edit this",
    image_paths: ["a.png", "b.jpg", "c.webp"],
    mask_path: "mask.png",
    output_path: "out/result.png",
    workspace_root: "D:\\project",
  });
  assert.equal(withMask.mask_path, "mask.png");
  assert.equal(withMask.output_path, "out/result.png");
  assert.equal(withMask.workspace_root, "D:\\project");

  assertThrowsValidation(() =>
    editImageSchema.parse({
      prompt: "edit this",
      image_paths: [],
    }),
  );
  assertThrowsValidation(() =>
    editImageSchema.parse({
      prompt: "edit this",
      image_paths: Array.from({ length: 9 }, (_, i) => `${i}.png`),
    }),
  );
  assertThrowsValidation(() =>
    editImageSchema.parse({
      prompt: "edit this",
      image_paths: ["a.png"],
      mask_path: 123,
    }),
  );
  assertThrowsValidation(() =>
    editImageSchema.parse({
      prompt: "edit this",
      image_paths: ["a.png"],
      moderation: "auto",
    }),
  );
});
