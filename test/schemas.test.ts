import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  EXTENDED_QUALITY_MODELS,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  TRANSPARENT_BACKGROUND_MODELS,
} from "../src/openai/types.ts";
import {
  editImageSchema,
  generateImageSchema,
  parseImageSize,
  statusSchema,
} from "../src/schemas.ts";

function assertThrowsValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof Error);
}

function assertInvalidInput(fn: () => unknown, message: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "INVALID_INPUT" &&
      message.test(error.message),
  );
}

const editBase = { prompt: "edit this", image_paths: ["a.png"] } as const;

test("statusSchema accepts empty objects and rejects unknown fields", () => {
  assert.deepEqual(statusSchema.parse({}), {});
  assertThrowsValidation(() => statusSchema.parse({ unexpected: true }));
});

test("generateImageSchema applies defaults and trims prompts", () => {
  const parsed = generateImageSchema.parse({
    prompt: "  a red cube  ",
  });
  assert.equal(parsed.prompt, "a red cube");
  assert.equal(parsed.quality, "high");
  assert.equal(parsed.size, "1024x1024");
  assert.equal(parsed.output_format, "png");
  assert.equal(parsed.moderation, "auto");
  assert.equal(parsed.model, "gpt-image-2.5-flare");
  assert.equal(parsed.background, "auto");
  assert.equal("output_compression" in parsed, false);
  assert.equal("output_path" in parsed, false);
  assert.equal("workspace_root" in parsed, false);
});

test("model constants expose exactly the supported models and transparent allowlist", () => {
  assert.deepEqual(
    [...IMAGE_MODELS],
    ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
  );
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2.5-flare");
  assert.deepEqual(
    [...TRANSPARENT_BACKGROUND_MODELS],
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
  );
});

test("quality constants expose exactly the supported tiers, the default, and the extended allowlist", () => {
  assert.deepEqual(
    [...IMAGE_QUALITIES],
    ["auto", "low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(DEFAULT_IMAGE_QUALITY, "high");
  assert.deepEqual(
    [...EXTENDED_QUALITY_MODELS],
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
  );
});

test("generate and edit schemas default model and background and accept every supported model", () => {
  const edit = editImageSchema.parse(editBase);
  assert.equal(edit.model, "gpt-image-2.5-flare");
  assert.equal(edit.quality, "high");
  assert.equal(edit.background, "auto");

  for (const model of [
    "gpt-image-2",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
  ] as const) {
    assert.equal(generateImageSchema.parse({ prompt: "ok", model }).model, model);
    assert.equal(editImageSchema.parse({ ...editBase, model }).model, model);
    for (const background of ["auto", "opaque"] as const) {
      for (const output_format of ["png", "jpeg", "webp"] as const) {
        const generated = generateImageSchema.parse({
          prompt: "ok",
          model,
          background,
          output_format,
        });
        assert.equal(generated.background, background);
        const edited = editImageSchema.parse({
          ...editBase,
          model,
          background,
          output_format,
        });
        assert.equal(edited.background, background);
      }
    }
  }
});

test("generate and edit schemas reject unknown models and backgrounds", () => {
  for (const model of [
    "gpt-image-1",
    "gpt-image-1.5",
    "dall-e-3",
    "gpt-image-2.5",
    "gpt-image-2-2026-04-21",
    "GPT-IMAGE-2",
    "",
  ]) {
    assertThrowsValidation(() => generateImageSchema.parse({ prompt: "ok", model }));
    assertThrowsValidation(() => editImageSchema.parse({ ...editBase, model }));
  }
  for (const background of ["none", "Transparent", ""]) {
    assertThrowsValidation(() =>
      generateImageSchema.parse({ prompt: "ok", background }),
    );
    assertThrowsValidation(() =>
      editImageSchema.parse({ ...editBase, background }),
    );
  }
});

test("transparent backgrounds are accepted only for GPT Image 2.5 models with PNG or WebP", () => {
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const) {
    for (const output_format of ["png", "webp"] as const) {
      const generated = generateImageSchema.parse({
        prompt: "ok",
        model,
        background: "transparent",
        output_format,
      });
      assert.equal(generated.model, model);
      assert.equal(generated.background, "transparent");
      assert.equal(generated.output_format, output_format);

      const edited = editImageSchema.parse({
        ...editBase,
        model,
        background: "transparent",
        output_format,
      });
      assert.equal(edited.model, model);
      assert.equal(edited.background, "transparent");
      assert.equal(edited.output_format, output_format);
    }

    const implicitPng = generateImageSchema.parse({
      prompt: "ok",
      model,
      background: "transparent",
    });
    assert.equal(implicitPng.output_format, "png");

    assertInvalidInput(
      () =>
        generateImageSchema.parse({
          prompt: "ok",
          model,
          background: "transparent",
          output_format: "jpeg",
        }),
      /^INVALID_INPUT: background "transparent" requires output_format "png" or "webp"$/,
    );
    assertInvalidInput(
      () =>
        editImageSchema.parse({
          ...editBase,
          model,
          background: "transparent",
          output_format: "jpeg",
        }),
      /^INVALID_INPUT: background "transparent" requires output_format "png" or "webp"$/,
    );
  }
});

test("transparent backgrounds are rejected for gpt-image-2 in every format", () => {
  const message =
    /^INVALID_INPUT: background "transparent" requires model gpt-image-2\.5-sunburst or gpt-image-2\.5-flare$/;
  for (const output_format of [undefined, "png", "jpeg", "webp"] as const) {
    const fields = {
      model: "gpt-image-2",
      background: "transparent",
      ...(output_format === undefined ? {} : { output_format }),
    };
    assertInvalidInput(
      () => generateImageSchema.parse({ prompt: "ok", ...fields }),
      message,
    );
    assertInvalidInput(
      () => editImageSchema.parse({ ...editBase, ...fields }),
      message,
    );
  }

  const opaqueJpeg = generateImageSchema.parse({
    prompt: "ok",
    model: "gpt-image-2",
    background: "opaque",
    output_format: "jpeg",
  });
  assert.equal(opaqueJpeg.background, "opaque");
  const opaqueJpegEdit = editImageSchema.parse({
    ...editBase,
    model: "gpt-image-2",
    background: "opaque",
    output_format: "jpeg",
  });
  assert.equal(opaqueJpegEdit.background, "opaque");
});

test("the default model accepts transparent PNG and WebP output", () => {
  for (const output_format of [undefined, "png", "webp"] as const) {
    const fields = {
      background: "transparent",
      ...(output_format === undefined ? {} : { output_format }),
    };
    const generated = generateImageSchema.parse({ prompt: "ok", ...fields });
    assert.equal(generated.model, "gpt-image-2.5-flare");
    assert.equal(generated.background, "transparent");
    const edited = editImageSchema.parse({ ...editBase, ...fields });
    assert.equal(edited.model, "gpt-image-2.5-flare");
    assert.equal(edited.background, "transparent");
  }
});

test("every quality tier is accepted on GPT Image 2.5 models, including the default model", () => {
  for (const model of [
    undefined,
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
  ] as const) {
    for (const quality of IMAGE_QUALITIES) {
      const fields = { quality, ...(model === undefined ? {} : { model }) };
      const generated = generateImageSchema.parse({ prompt: "ok", ...fields });
      assert.equal(generated.model, model ?? "gpt-image-2.5-flare");
      assert.equal(generated.quality, quality);
      const edited = editImageSchema.parse({ ...editBase, ...fields });
      assert.equal(edited.model, model ?? "gpt-image-2.5-flare");
      assert.equal(edited.quality, quality);
    }
  }
});

test("xhigh and max quality are rejected for gpt-image-2 while standard tiers are accepted", () => {
  for (const quality of ["xhigh", "max"] as const) {
    const message = new RegExp(
      `^INVALID_INPUT: quality "${quality}" requires model gpt-image-2\\.5-sunburst or gpt-image-2\\.5-flare$`,
    );
    assertInvalidInput(
      () =>
        generateImageSchema.parse({
          prompt: "ok",
          model: "gpt-image-2",
          quality,
        }),
      message,
    );
    assertInvalidInput(
      () =>
        editImageSchema.parse({
          ...editBase,
          model: "gpt-image-2",
          quality,
        }),
      message,
    );
  }

  for (const quality of ["auto", "low", "medium", "high"] as const) {
    assert.equal(
      generateImageSchema.parse({ prompt: "ok", model: "gpt-image-2", quality })
        .quality,
      quality,
    );
    assert.equal(
      editImageSchema.parse({ ...editBase, model: "gpt-image-2", quality })
        .quality,
      quality,
    );
  }
});

test("generate and edit schemas reject unknown quality values", () => {
  for (const quality of ["standard", "hd", "ultra", "XHIGH", "Max", ""]) {
    assertThrowsValidation(() =>
      generateImageSchema.parse({ prompt: "ok", quality }),
    );
    assertThrowsValidation(() =>
      editImageSchema.parse({ ...editBase, quality }),
    );
  }
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
