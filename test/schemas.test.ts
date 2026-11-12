import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  EXTENDED_QUALITY_MODELS,
  GPT_IMAGE_2_6_MODELS,
  IMAGE_COMPLEXITIES,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  MARKUP_MODELS,
  TRANSPARENT_BACKGROUND_MODELS,
} from "../src/openai/types.ts";
import {
  editImageSchema,
  generateImageSchema,
  parseAnimationFrameSize,
  parseImageSize,
  statusSchema,
} from "../src/schemas.ts";

function assertThrowsValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof Error);
}

// A structural (zod) failure, which the protocol boundary reports with the
// generic "Image tool input is invalid" message, as opposed to an AppError.
function assertSchemaIssue(fn: () => unknown): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof Error && !(error instanceof AppError),
  );
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
  assert.equal(parsed.model, "gpt-image-2.6-flare");
  assert.equal(parsed.background, "auto");
  assert.equal("output_compression" in parsed, false);
  assert.equal("complexity" in parsed, false);
  assert.equal("output_path" in parsed, false);
  assert.equal("workspace_root" in parsed, false);
});

test("model constants expose exactly the supported models and transparent allowlist", () => {
  assert.deepEqual(
    [...IMAGE_MODELS],
    [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ],
  );
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2.6-flare");
  assert.deepEqual(
    [...TRANSPARENT_BACKGROUND_MODELS],
    [
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ],
  );
  assert.ok(Object.isFrozen(TRANSPARENT_BACKGROUND_MODELS));
});

test("complexity constants expose exactly the supported values and the GPT Image 2.6 allowlist", () => {
  assert.deepEqual([...IMAGE_COMPLEXITIES], ["low", "medium", "high"]);
  assert.deepEqual(
    [...GPT_IMAGE_2_6_MODELS],
    ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"],
  );
  assert.ok(Object.isFrozen(GPT_IMAGE_2_6_MODELS));
});

test("quality constants expose exactly the supported tiers, the default, and the extended allowlist", () => {
  assert.deepEqual(
    [...IMAGE_QUALITIES],
    ["auto", "low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(DEFAULT_IMAGE_QUALITY, "high");
  assert.deepEqual(
    [...EXTENDED_QUALITY_MODELS],
    [
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ],
  );
  assert.ok(Object.isFrozen(EXTENDED_QUALITY_MODELS));
});

test("generate and edit schemas default model and background and accept every supported model", () => {
  const edit = editImageSchema.parse(editBase);
  assert.equal(edit.model, "gpt-image-2.6-flare");
  assert.equal(edit.quality, "high");
  assert.equal(edit.background, "auto");
  assert.equal("complexity" in edit, false);

  for (const model of [
    "gpt-image-2",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
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
    "gpt-image-2.6",
    "GPT-IMAGE-2.6-FLARE",
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

test("transparent backgrounds are accepted only for GPT Image 2.5 and 2.6 models with PNG or WebP", () => {
  for (const model of [
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ] as const) {
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
    /^INVALID_INPUT: background "transparent" requires model gpt-image-2\.5-sunburst or gpt-image-2\.5-flare or gpt-image-2\.6-sunburst or gpt-image-2\.6-flare$/;
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
    assert.equal(generated.model, "gpt-image-2.6-flare");
    assert.equal(generated.background, "transparent");
    const edited = editImageSchema.parse({ ...editBase, ...fields });
    assert.equal(edited.model, "gpt-image-2.6-flare");
    assert.equal(edited.background, "transparent");
  }
});

test("every quality tier is accepted on GPT Image 2.5 and 2.6 models, including the default model", () => {
  for (const model of [
    undefined,
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ] as const) {
    for (const quality of IMAGE_QUALITIES) {
      const fields = { quality, ...(model === undefined ? {} : { model }) };
      const generated = generateImageSchema.parse({ prompt: "ok", ...fields });
      assert.equal(generated.model, model ?? "gpt-image-2.6-flare");
      assert.equal(generated.quality, quality);
      const edited = editImageSchema.parse({ ...editBase, ...fields });
      assert.equal(edited.model, model ?? "gpt-image-2.6-flare");
      assert.equal(edited.quality, quality);
    }
  }
});

test("xhigh and max quality are rejected for gpt-image-2 while standard tiers are accepted", () => {
  for (const quality of ["xhigh", "max"] as const) {
    const message = new RegExp(
      `^INVALID_INPUT: quality "${quality}" requires model gpt-image-2\\.5-sunburst or gpt-image-2\\.5-flare or gpt-image-2\\.6-sunburst or gpt-image-2\\.6-flare$`,
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

test("complexity is accepted on GPT Image 2.6 models, including the default model, and omitted when absent", () => {
  for (const model of [
    undefined,
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ] as const) {
    for (const complexity of IMAGE_COMPLEXITIES) {
      const fields = { complexity, ...(model === undefined ? {} : { model }) };
      const generated = generateImageSchema.parse({ prompt: "ok", ...fields });
      assert.equal(generated.model, model ?? "gpt-image-2.6-flare");
      assert.equal(generated.complexity, complexity);
      const edited = editImageSchema.parse({ ...editBase, ...fields });
      assert.equal(edited.model, model ?? "gpt-image-2.6-flare");
      assert.equal(edited.complexity, complexity);
    }

    const modelFields = model === undefined ? {} : { model };
    const generated = generateImageSchema.parse({ prompt: "ok", ...modelFields });
    assert.equal("complexity" in generated, false);
    const edited = editImageSchema.parse({ ...editBase, ...modelFields });
    assert.equal("complexity" in edited, false);
  }

  const combined = {
    model: "gpt-image-2.6-sunburst",
    complexity: "low",
    quality: "max",
    background: "transparent",
  } as const;
  const generated = generateImageSchema.parse({ prompt: "ok", ...combined });
  assert.equal(generated.complexity, "low");
  assert.equal(generated.quality, "max");
  assert.equal(generated.background, "transparent");
  const edited = editImageSchema.parse({ ...editBase, ...combined });
  assert.equal(edited.complexity, "low");
  assert.equal(edited.quality, "max");
  assert.equal(edited.background, "transparent");
});

test("complexity is rejected for models other than GPT Image 2.6", () => {
  const message =
    /^INVALID_INPUT: complexity requires model gpt-image-2\.6-sunburst or gpt-image-2\.6-flare$/;
  for (const model of [
    "gpt-image-2",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
  ] as const) {
    for (const complexity of IMAGE_COMPLEXITIES) {
      assertInvalidInput(
        () => generateImageSchema.parse({ prompt: "ok", model, complexity }),
        message,
      );
      assertInvalidInput(
        () => editImageSchema.parse({ ...editBase, model, complexity }),
        message,
      );
    }
  }

  // Complexity rules run after quality rules, so the quality error wins.
  const qualityMessage =
    /^INVALID_INPUT: quality "max" requires model gpt-image-2\.5-sunburst or gpt-image-2\.5-flare or gpt-image-2\.6-sunburst or gpt-image-2\.6-flare$/;
  assertInvalidInput(
    () =>
      generateImageSchema.parse({
        prompt: "ok",
        model: "gpt-image-2",
        quality: "max",
        complexity: "medium",
      }),
    qualityMessage,
  );
  assertInvalidInput(
    () =>
      editImageSchema.parse({
        ...editBase,
        model: "gpt-image-2",
        quality: "max",
        complexity: "medium",
      }),
    qualityMessage,
  );
});

test("generate and edit schemas reject unknown complexity values", () => {
  for (const complexity of ["extreme", "auto", "HIGH", "Low", "", null, 1]) {
    for (const model of [undefined, "gpt-image-2.6-flare"] as const) {
      const fields = { complexity, ...(model === undefined ? {} : { model }) };
      assertThrowsValidation(() =>
        generateImageSchema.parse({ prompt: "ok", ...fields }),
      );
      assertThrowsValidation(() =>
        editImageSchema.parse({ ...editBase, ...fields }),
      );
    }
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

const MODELS_WITHOUT_2_6 = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
] as const;

test("generate accepts GIF and SVG output, edit accepts GIF but not SVG, and the default stays PNG", () => {
  for (const output_format of ["png", "jpeg", "webp", "gif", "svg"] as const) {
    assert.equal(
      generateImageSchema.parse({ prompt: "ok", output_format }).output_format,
      output_format,
    );
  }
  for (const output_format of ["png", "jpeg", "webp", "gif"] as const) {
    assert.equal(
      editImageSchema.parse({ ...editBase, output_format }).output_format,
      output_format,
    );
  }
  assert.equal(generateImageSchema.parse({ prompt: "ok" }).output_format, "png");
  assert.equal(editImageSchema.parse(editBase).output_format, "png");

  assertSchemaIssue(() =>
    editImageSchema.parse({ ...editBase, output_format: "svg" }),
  );
  for (const output_format of ["GIF", "Svg", "bmp", "jpg", "apng", ""]) {
    assertSchemaIssue(() =>
      generateImageSchema.parse({ prompt: "ok", output_format }),
    );
    assertSchemaIssue(() =>
      editImageSchema.parse({ ...editBase, output_format }),
    );
  }
});

test("GIF frame_count and frame_duration_ms accept only integers inside their bounds", () => {
  for (const [frame_count, frame_duration_ms] of [
    [2, 20],
    [9, 200],
    [16, 2000],
  ] as const) {
    const generated = generateImageSchema.parse({
      prompt: "ok",
      output_format: "gif",
      frame_count,
      frame_duration_ms,
    });
    assert.equal(generated.frame_count, frame_count);
    assert.equal(generated.frame_duration_ms, frame_duration_ms);
    const edited = editImageSchema.parse({
      ...editBase,
      output_format: "gif",
      frame_count,
      frame_duration_ms,
    });
    assert.equal(edited.frame_count, frame_count);
    assert.equal(edited.frame_duration_ms, frame_duration_ms);
  }

  const omitted = generateImageSchema.parse({ prompt: "ok", output_format: "gif" });
  assert.equal("frame_count" in omitted, false);
  assert.equal("frame_duration_ms" in omitted, false);
  const omittedPng = generateImageSchema.parse({ prompt: "ok" });
  assert.equal("frame_count" in omittedPng, false);
  assert.equal("frame_duration_ms" in omittedPng, false);

  for (const frame_count of [1, 17, 0, -2, 2.5, "9", null]) {
    assertSchemaIssue(() =>
      generateImageSchema.parse({ prompt: "ok", output_format: "gif", frame_count }),
    );
    assertSchemaIssue(() =>
      editImageSchema.parse({ ...editBase, output_format: "gif", frame_count }),
    );
  }
  for (const frame_duration_ms of [19, 2001, 0, 20.5, "200", null]) {
    assertSchemaIssue(() =>
      generateImageSchema.parse({
        prompt: "ok",
        output_format: "gif",
        frame_duration_ms,
      }),
    );
    assertSchemaIssue(() =>
      editImageSchema.parse({ ...editBase, output_format: "gif", frame_duration_ms }),
    );
  }
});

test("GIF and SVG output require a GPT Image 2.6 model", () => {
  for (const model of MODELS_WITHOUT_2_6) {
    for (const output_format of ["gif", "svg"] as const) {
      assertInvalidInput(
        () => generateImageSchema.parse({ prompt: "ok", model, output_format }),
        new RegExp(
          `^INVALID_INPUT: output_format "${output_format}" requires model gpt-image-2\\.6-sunburst or gpt-image-2\\.6-flare$`,
        ),
      );
    }
    assertInvalidInput(
      () => editImageSchema.parse({ ...editBase, model, output_format: "gif" }),
      /^INVALID_INPUT: output_format "gif" requires model gpt-image-2\.6-sunburst or gpt-image-2\.6-flare$/,
    );
  }

  for (const model of GPT_IMAGE_2_6_MODELS) {
    for (const output_format of ["gif", "svg"] as const) {
      assert.equal(
        generateImageSchema.parse({ prompt: "ok", model, output_format }).model,
        model,
      );
    }
    assert.equal(
      editImageSchema.parse({ ...editBase, model, output_format: "gif" }).model,
      model,
    );
  }
});

test("frame_count and frame_duration_ms require GIF output", () => {
  const message =
    /^INVALID_INPUT: frame_count and frame_duration_ms require output_format "gif"$/;
  const frameFieldSets = [
    { frame_count: 4 },
    { frame_duration_ms: 100 },
    { frame_count: 4, frame_duration_ms: 100 },
  ] as const;
  for (const frameFields of frameFieldSets) {
    for (const output_format of [undefined, "png", "jpeg", "webp", "svg"] as const) {
      const formatField = output_format === undefined ? {} : { output_format };
      assertInvalidInput(
        () =>
          generateImageSchema.parse({ prompt: "ok", ...formatField, ...frameFields }),
        message,
      );
      if (output_format !== "svg") {
        assertInvalidInput(
          () =>
            editImageSchema.parse({ ...editBase, ...formatField, ...frameFields }),
          message,
        );
      }
    }
  }
});

test("GIF and SVG ignore only zero compression, and the rejection names the upper-cased format", () => {
  for (const output_format of ["png", "gif", "svg"] as const) {
    const zero = generateImageSchema.parse({
      prompt: "ok",
      output_format,
      output_compression: 0,
    });
    assert.equal("output_compression" in zero, false);
    for (const output_compression of [1, 50, 100]) {
      assertInvalidInput(
        () =>
          generateImageSchema.parse({ prompt: "ok", output_format, output_compression }),
        new RegExp(
          `^INVALID_INPUT: output_compression is not supported for ${output_format.toUpperCase()} except the ignored zero default$`,
        ),
      );
    }
  }

  const zeroGifEdit = editImageSchema.parse({
    ...editBase,
    output_format: "gif",
    output_compression: 0,
  });
  assert.equal("output_compression" in zeroGifEdit, false);
  assertInvalidInput(
    () =>
      editImageSchema.parse({
        ...editBase,
        output_format: "gif",
        output_compression: 40,
      }),
    /^INVALID_INPUT: output_compression is not supported for GIF except the ignored zero default$/,
  );
  assertInvalidInput(
    () =>
      generateImageSchema.parse({
        prompt: "ok",
        output_format: "png",
        output_compression: 1,
      }),
    /^INVALID_INPUT: output_compression is not supported for PNG except the ignored zero default$/,
  );
});

test("transparent backgrounds are rejected for GIF and SVG output on GPT Image 2.6 models", () => {
  const message =
    /^INVALID_INPUT: background "transparent" requires output_format "png" or "webp"$/;
  for (const model of GPT_IMAGE_2_6_MODELS) {
    for (const output_format of ["gif", "svg"] as const) {
      assertInvalidInput(
        () =>
          generateImageSchema.parse({
            prompt: "ok",
            model,
            output_format,
            background: "transparent",
          }),
        message,
      );
    }
    assertInvalidInput(
      () =>
        editImageSchema.parse({
          ...editBase,
          model,
          output_format: "gif",
          background: "transparent",
        }),
      message,
    );
    for (const output_format of ["gif", "svg"] as const) {
      assert.equal(
        generateImageSchema.parse({
          prompt: "ok",
          model,
          output_format,
          background: "opaque",
        }).background,
        "opaque",
      );
    }
  }
});

test("mask_path is rejected with GIF edit output", () => {
  assertInvalidInput(
    () =>
      editImageSchema.parse({
        ...editBase,
        output_format: "gif",
        mask_path: "mask.png",
      }),
    /^INVALID_INPUT: mask_path is not supported with output_format "gif"$/,
  );
  for (const output_format of ["png", "jpeg", "webp"] as const) {
    assert.equal(
      editImageSchema.parse({ ...editBase, output_format, mask_path: "mask.png" })
        .mask_path,
      "mask.png",
    );
  }
});

test("markup constants expose exactly the GPT Image 2.5 and 2.6 Sunburst and Flare models", () => {
  assert.deepEqual(
    [...MARKUP_MODELS],
    [
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ],
  );
  assert.ok(Object.isFrozen(MARKUP_MODELS));
});

test("editImageSchema accepts markup_path on markup models, including GIF output, and omits it when absent", () => {
  assert.equal("markup_path" in editImageSchema.parse(editBase), false);
  assert.equal(
    editImageSchema.parse({ ...editBase, markup_path: "markup.png" }).markup_path,
    "markup.png",
  );
  for (const model of MARKUP_MODELS) {
    for (const output_format of ["png", "jpeg", "webp"] as const) {
      const parsed = editImageSchema.parse({
        ...editBase,
        model,
        output_format,
        markup_path: "markup.png",
      });
      assert.equal(parsed.markup_path, "markup.png");
      assert.equal(parsed.model, model);
      assert.equal("mask_path" in parsed, false);
    }
  }
  for (const model of GPT_IMAGE_2_6_MODELS) {
    const parsed = editImageSchema.parse({
      ...editBase,
      model,
      output_format: "gif",
      markup_path: "markup.png",
    });
    assert.equal(parsed.markup_path, "markup.png");
    assert.equal(parsed.output_format, "gif");
  }

  assertSchemaIssue(() => editImageSchema.parse({ ...editBase, markup_path: "" }));
  assertSchemaIssue(() => editImageSchema.parse({ ...editBase, markup_path: 123 }));
  assertSchemaIssue(() =>
    generateImageSchema.parse({ prompt: "ok", markup_path: "markup.png" }),
  );
});

test("markup_path cannot be combined with mask_path", () => {
  for (const model of MARKUP_MODELS) {
    for (const output_format of ["png", "jpeg", "webp"] as const) {
      assertInvalidInput(
        () =>
          editImageSchema.parse({
            ...editBase,
            model,
            output_format,
            mask_path: "mask.png",
            markup_path: "markup.png",
          }),
        /^INVALID_INPUT: markup_path cannot be combined with mask_path$/,
      );
    }
  }
});

test("markup_path requires a GPT Image 2.5 or 2.6 model", () => {
  for (const output_format of ["png", "jpeg", "webp"] as const) {
    assertInvalidInput(
      () =>
        editImageSchema.parse({
          ...editBase,
          model: "gpt-image-2",
          output_format,
          markup_path: "markup.png",
        }),
      /^INVALID_INPUT: markup_path requires model gpt-image-2\.5-sunburst or gpt-image-2\.5-flare or gpt-image-2\.6-sunburst or gpt-image-2\.6-flare$/,
    );
  }
  assert.equal(
    editImageSchema.parse({
      ...editBase,
      model: "gpt-image-2",
      mask_path: "mask.png",
    }).mask_path,
    "mask.png",
  );
});

test("markup rules run after the mask rule, and the mask conflict is reported before the model rule", () => {
  assertInvalidInput(
    () =>
      editImageSchema.parse({
        ...editBase,
        output_format: "gif",
        mask_path: "mask.png",
        markup_path: "markup.png",
      }),
    /^INVALID_INPUT: mask_path is not supported with output_format "gif"$/,
  );
  assertInvalidInput(
    () =>
      editImageSchema.parse({
        ...editBase,
        model: "gpt-image-2",
        mask_path: "mask.png",
        markup_path: "markup.png",
      }),
    /^INVALID_INPUT: markup_path cannot be combined with mask_path$/,
  );
});

test("an explicit undefined size counts as omitted, so GIF output still defaults to auto", () => {
  const generateGif = Object.freeze({
    prompt: "ok",
    output_format: "gif",
    size: undefined,
  });
  assert.equal(generateImageSchema.parse(generateGif).size, "auto");
  assert.ok(Object.hasOwn(generateGif, "size"));
  assert.equal(generateGif.size, undefined);
  const editGif = Object.freeze({
    ...editBase,
    output_format: "gif",
    size: undefined,
  });
  assert.equal(editImageSchema.parse(editGif).size, "auto");
  assert.ok(Object.hasOwn(editGif, "size"));
  assert.equal(editGif.size, undefined);

  for (const output_format of [undefined, "png", "jpeg", "webp", "svg"] as const) {
    const formatField = output_format === undefined ? {} : { output_format };
    assert.equal(
      generateImageSchema.parse({ prompt: "ok", ...formatField, size: undefined })
        .size,
      "1024x1024",
    );
  }
  for (const output_format of [undefined, "png", "jpeg", "webp"] as const) {
    const formatField = output_format === undefined ? {} : { output_format };
    assert.equal(
      editImageSchema.parse({ ...editBase, ...formatField, size: undefined }).size,
      "1024x1024",
    );
  }
});

test("GIF output without a size defaults to auto while other formats keep 1024x1024", () => {
  const generateGif = Object.freeze({ prompt: "ok", output_format: "gif" });
  assert.equal(generateImageSchema.parse(generateGif).size, "auto");
  assert.equal("size" in generateGif, false);
  const editGif = Object.freeze({ ...editBase, output_format: "gif" });
  assert.equal(editImageSchema.parse(editGif).size, "auto");
  assert.equal("size" in editGif, false);

  assert.equal(
    generateImageSchema.parse({ prompt: "ok", output_format: "gif", size: "512x256" })
      .size,
    "512x256",
  );
  assert.equal(
    editImageSchema.parse({ ...editBase, output_format: "gif", size: "1024x1024" })
      .size,
    "1024x1024",
  );
  for (const output_format of [undefined, "png", "jpeg", "webp", "svg"] as const) {
    const formatField = output_format === undefined ? {} : { output_format };
    assert.equal(
      generateImageSchema.parse({ prompt: "ok", ...formatField }).size,
      "1024x1024",
    );
  }
  assert.equal(editImageSchema.parse(editBase).size, "1024x1024");
});

test("parseAnimationFrameSize accepts auto and multiples of 16 up to 3840 without pixel or ratio rules", () => {
  assert.equal(parseAnimationFrameSize("auto"), null);
  assert.deepEqual(parseAnimationFrameSize("16x16"), { width: 16, height: 16 });
  assert.deepEqual(parseAnimationFrameSize("256x256"), { width: 256, height: 256 });
  assert.deepEqual(parseAnimationFrameSize("3840x16"), { width: 3840, height: 16 });
  assert.deepEqual(parseAnimationFrameSize("16x3840"), { width: 16, height: 3840 });
  assert.deepEqual(parseAnimationFrameSize("3840x3840"), {
    width: 3840,
    height: 3840,
  });

  for (const [size, message] of [
    ["100x100", /^INVALID_INPUT: size dimensions must be multiples of 16$/],
    ["24x16", /^INVALID_INPUT: size dimensions must be multiples of 16$/],
    ["3856x16", /^INVALID_INPUT: size edges must be at most 3840 pixels$/],
    ["0x16", /^INVALID_INPUT: size must be "auto" or WIDTHxHEIGHT with positive integers$/],
    ["16", /^INVALID_INPUT: size must be "auto" or WIDTHxHEIGHT with positive integers$/],
    ["16X16", /^INVALID_INPUT: size must be "auto" or WIDTHxHEIGHT with positive integers$/],
    ["Auto", /^INVALID_INPUT: size must be "auto" or WIDTHxHEIGHT with positive integers$/],
  ] as const) {
    assertInvalidInput(() => parseAnimationFrameSize(size), message);
  }
});

test("GIF sizes use frame rules while every other format keeps the raster size rules", () => {
  for (const size of ["16x16", "256x256", "3840x16"]) {
    assert.equal(
      generateImageSchema.parse({ prompt: "ok", output_format: "gif", size }).size,
      size,
    );
    assert.equal(
      editImageSchema.parse({ ...editBase, output_format: "gif", size }).size,
      size,
    );
    for (const output_format of [undefined, "png", "jpeg", "webp", "svg"] as const) {
      const formatField = output_format === undefined ? {} : { output_format };
      assertSchemaIssue(() =>
        generateImageSchema.parse({ prompt: "ok", ...formatField, size }),
      );
    }
    assertSchemaIssue(() => editImageSchema.parse({ ...editBase, size }));
  }

  for (const size of ["100x100", "3856x16", "16X16", "16"]) {
    assertSchemaIssue(() =>
      generateImageSchema.parse({ prompt: "ok", output_format: "gif", size }),
    );
    assertSchemaIssue(() =>
      editImageSchema.parse({ ...editBase, output_format: "gif", size }),
    );
  }
});

test("an invalid size is reported as a zod issue on the size path", () => {
  for (const [schema, input] of [
    [generateImageSchema, { prompt: "ok", size: "100x100" }],
    [generateImageSchema, { prompt: "ok", output_format: "gif", size: "100x100" }],
    [editImageSchema, { ...editBase, size: "100x100" }],
    [editImageSchema, { ...editBase, output_format: "gif", size: "100x100" }],
  ] as const) {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
      [
        {
          path: ["size"],
          message: "INVALID_INPUT: size dimensions must be multiples of 16",
        },
      ],
    );
  }
});
