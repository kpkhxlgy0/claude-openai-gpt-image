import { z } from "zod";
import { AppError } from "./errors.ts";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  EDIT_OUTPUT_FORMATS,
  EXTENDED_QUALITY_MODELS,
  GPT_IMAGE_2_6_MODELS,
  IMAGE_BACKGROUNDS,
  IMAGE_COMPLEXITIES,
  IMAGE_MODELS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_QUALITIES,
  MARKUP_MODELS,
  TRANSPARENT_BACKGROUND_MODELS,
  type ProviderBackground,
  type ProviderComplexity,
  type ProviderEditOutputFormat,
  type ProviderModel,
  type ProviderOutputFormat,
  type ProviderQuality,
} from "./openai/types.ts";

const PROMPT_MAX = 32_000;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 3;
const MIN_FRAME_COUNT = 2;
const MAX_FRAME_COUNT = 16;
const MIN_FRAME_DURATION_MS = 20;
const MAX_FRAME_DURATION_MS = 2000;

export interface ImageSize {
  width: number;
  height: number;
}

export interface GenerateImageInput {
  model: ProviderModel;
  prompt: string;
  quality: ProviderQuality;
  size: "auto" | `${number}x${number}`;
  output_format: ProviderOutputFormat;
  output_compression?: number;
  background: ProviderBackground;
  complexity?: ProviderComplexity;
  frame_count?: number;
  frame_duration_ms?: number;
  moderation: "auto" | "low";
  output_path?: string;
  workspace_root?: string;
}

export interface EditImageInput
  extends Omit<GenerateImageInput, "moderation" | "output_format"> {
  output_format: ProviderEditOutputFormat;
  image_paths: string[];
  mask_path?: string;
  markup_path?: string;
}

export type StatusInput = Record<string, never>;

function parseSizeDimensions(value: string): ImageSize {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) {
    throw new AppError(
      "INVALID_INPUT",
      'size must be "auto" or WIDTHxHEIGHT with positive integers',
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new AppError("INVALID_INPUT", "size dimensions must be integers");
  }

  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new AppError(
      "INVALID_INPUT",
      "size dimensions must be multiples of 16",
    );
  }

  if (width > MAX_EDGE || height > MAX_EDGE) {
    throw new AppError(
      "INVALID_INPUT",
      `size edges must be at most ${MAX_EDGE} pixels`,
    );
  }

  return { width, height };
}

export function parseImageSize(value: string): ImageSize | null {
  if (value === "auto") {
    return null;
  }

  const { width, height } = parseSizeDimensions(value);

  const pixels = width * height;
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    throw new AppError(
      "INVALID_INPUT",
      `size total pixels must be between ${MIN_PIXELS} and ${MAX_PIXELS}`,
    );
  }

  const ratio = width / height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    throw new AppError(
      "INVALID_INPUT",
      "size aspect ratio must be between 1:3 and 3:1",
    );
  }

  return { width, height };
}

// A GIF size describes one animation frame. It keeps the multiple-of-16 and
// edge rules but has no pixel-count or aspect-ratio rule.
export function parseAnimationFrameSize(value: string): ImageSize | null {
  if (value === "auto") {
    return null;
  }

  return parseSizeDimensions(value);
}

const promptSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(PROMPT_MAX));

const modelSchema = z.enum(IMAGE_MODELS).default(DEFAULT_IMAGE_MODEL);
const qualitySchema = z.enum(IMAGE_QUALITIES).default(DEFAULT_IMAGE_QUALITY);
const sizeSchema = z.string().default("1024x1024");
const generateOutputFormatSchema = z.enum(IMAGE_OUTPUT_FORMATS).default("png");
const editOutputFormatSchema = z.enum(EDIT_OUTPUT_FORMATS).default("png");
const backgroundSchema = z.enum(IMAGE_BACKGROUNDS).default("auto");
const complexitySchema = z.enum(IMAGE_COMPLEXITIES).optional();
const frameCountSchema = z
  .number()
  .int()
  .min(MIN_FRAME_COUNT)
  .max(MAX_FRAME_COUNT)
  .optional();
const frameDurationSchema = z
  .number()
  .int()
  .min(MIN_FRAME_DURATION_MS)
  .max(MAX_FRAME_DURATION_MS)
  .optional();
const moderationSchema = z.enum(["auto", "low"]).default("auto");
const optionalPathSchema = z.string().min(1).optional();

type SizeFields = {
  size: string;
  output_format: ProviderOutputFormat;
};

// The size rules depend on output_format, so they run on the parsed object.
// A failure stays a zod issue on the size path rather than an AppError.
function sizeIssueMessage(value: SizeFields): string | undefined {
  try {
    if (value.output_format === "gif") {
      parseAnimationFrameSize(value.size);
    } else {
      parseImageSize(value.size);
    }
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.message : "Invalid image size";
  }
}

// A GIF request without a size asks for the model-chosen frame size. A size
// key holding undefined counts as omitted, as it does for every zod default.
// The default is injected before validation, so the advertised size default
// stays the raster default and the caller's object is never mutated.
function injectGifSizeDefault(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return input;
  }
  const record = input as Record<string, unknown>;
  if (record.output_format !== "gif" || record.size !== undefined) {
    return input;
  }
  return { ...record, size: "auto" };
}

// Only JPEG and WebP have a compression setting. Every other format accepts
// only the zero default, which is dropped before the provider request.
function supportsCompression(format: ProviderOutputFormat): boolean {
  return format === "jpeg" || format === "webp";
}

type CompressionFields = {
  output_format: ProviderOutputFormat;
  output_compression?: number | undefined;
};

function normalizeCompression<T extends CompressionFields>(value: T): T {
  if (
    !supportsCompression(value.output_format) &&
    value.output_compression === 0
  ) {
    const copy = { ...value };
    delete copy.output_compression;
    return copy;
  }
  return value;
}

function assertCompressionRules(value: CompressionFields): void {
  if (value.output_compression === undefined) {
    return;
  }

  if (
    !Number.isInteger(value.output_compression) ||
    value.output_compression < 0 ||
    value.output_compression > 100
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "output_compression must be an integer between 0 and 100",
    );
  }

  if (
    !supportsCompression(value.output_format) &&
    value.output_compression !== 0
  ) {
    throw new AppError(
      "INVALID_INPUT",
      `output_compression is not supported for ${value.output_format.toUpperCase()} except the ignored zero default`,
    );
  }
}

type BackgroundFields = {
  model: ProviderModel;
  background: ProviderBackground;
  output_format: ProviderOutputFormat;
};

function assertBackgroundRules(value: BackgroundFields): void {
  if (value.background !== "transparent") {
    return;
  }

  if (!TRANSPARENT_BACKGROUND_MODELS.includes(value.model)) {
    throw new AppError(
      "INVALID_INPUT",
      `background "transparent" requires model ${TRANSPARENT_BACKGROUND_MODELS.join(" or ")}`,
    );
  }

  if (value.output_format !== "png" && value.output_format !== "webp") {
    throw new AppError(
      "INVALID_INPUT",
      'background "transparent" requires output_format "png" or "webp"',
    );
  }
}

type QualityFields = {
  model: ProviderModel;
  quality: ProviderQuality;
};

function assertQualityRules(value: QualityFields): void {
  if (value.quality !== "xhigh" && value.quality !== "max") {
    return;
  }

  if (!EXTENDED_QUALITY_MODELS.includes(value.model)) {
    throw new AppError(
      "INVALID_INPUT",
      `quality "${value.quality}" requires model ${EXTENDED_QUALITY_MODELS.join(" or ")}`,
    );
  }
}

type ComplexityFields = {
  model: ProviderModel;
  complexity?: ProviderComplexity | undefined;
};

function assertComplexityRules(value: ComplexityFields): void {
  if (value.complexity === undefined) {
    return;
  }

  if (!GPT_IMAGE_2_6_MODELS.includes(value.model)) {
    throw new AppError(
      "INVALID_INPUT",
      `complexity requires model ${GPT_IMAGE_2_6_MODELS.join(" or ")}`,
    );
  }
}

type OutputFormatFields = {
  model: ProviderModel;
  output_format: ProviderOutputFormat;
  frame_count?: number | undefined;
  frame_duration_ms?: number | undefined;
};

function assertOutputFormatRules(value: OutputFormatFields): void {
  if (
    (value.output_format === "gif" || value.output_format === "svg") &&
    !GPT_IMAGE_2_6_MODELS.includes(value.model)
  ) {
    throw new AppError(
      "INVALID_INPUT",
      `output_format "${value.output_format}" requires model ${GPT_IMAGE_2_6_MODELS.join(" or ")}`,
    );
  }

  if (
    value.output_format !== "gif" &&
    (value.frame_count !== undefined || value.frame_duration_ms !== undefined)
  ) {
    throw new AppError(
      "INVALID_INPUT",
      'frame_count and frame_duration_ms require output_format "gif"',
    );
  }
}

type MaskFields = {
  output_format: ProviderEditOutputFormat;
  mask_path?: string | undefined;
};

function assertMaskRules(value: MaskFields): void {
  if (value.output_format === "gif" && value.mask_path !== undefined) {
    throw new AppError(
      "INVALID_INPUT",
      'mask_path is not supported with output_format "gif"',
    );
  }
}

type MarkupFields = {
  model: ProviderModel;
  mask_path?: string | undefined;
  markup_path?: string | undefined;
};

function assertMarkupRules(value: MarkupFields): void {
  if (value.markup_path === undefined) {
    return;
  }

  if (value.mask_path !== undefined) {
    throw new AppError(
      "INVALID_INPUT",
      "markup_path cannot be combined with mask_path",
    );
  }

  if (!MARKUP_MODELS.includes(value.model)) {
    throw new AppError(
      "INVALID_INPUT",
      `markup_path requires model ${MARKUP_MODELS.join(" or ")}`,
    );
  }
}

const generateObjectSchema = z
  .strictObject({
    prompt: promptSchema,
    model: modelSchema,
    quality: qualitySchema,
    size: sizeSchema,
    output_format: generateOutputFormatSchema,
    output_compression: z.number().int().min(0).max(100).optional(),
    background: backgroundSchema,
    complexity: complexitySchema,
    frame_count: frameCountSchema,
    frame_duration_ms: frameDurationSchema,
    moderation: moderationSchema,
    output_path: optionalPathSchema,
    workspace_root: optionalPathSchema,
  })
  .superRefine((value, ctx) => {
    const message = sizeIssueMessage(value);
    if (message !== undefined) {
      ctx.addIssue({ code: "custom", path: ["size"], message });
    }
  });

const editObjectSchema = z
  .strictObject({
    prompt: promptSchema,
    model: modelSchema,
    quality: qualitySchema,
    size: sizeSchema,
    output_format: editOutputFormatSchema,
    output_compression: z.number().int().min(0).max(100).optional(),
    background: backgroundSchema,
    complexity: complexitySchema,
    frame_count: frameCountSchema,
    frame_duration_ms: frameDurationSchema,
    output_path: optionalPathSchema,
    workspace_root: optionalPathSchema,
    image_paths: z.array(z.string().min(1)).min(1).max(8),
    mask_path: optionalPathSchema,
    markup_path: optionalPathSchema,
  })
  .superRefine((value, ctx) => {
    const message = sizeIssueMessage(value);
    if (message !== undefined) {
      ctx.addIssue({ code: "custom", path: ["size"], message });
    }
  });

export const statusSchema = z.strictObject({});

export const generateImageSchema = z
  .preprocess(injectGifSizeDefault, generateObjectSchema)
  .transform((value): GenerateImageInput => {
    assertCompressionRules(value);
    assertBackgroundRules(value);
    assertQualityRules(value);
    assertComplexityRules(value);
    assertOutputFormatRules(value);
    return normalizeCompression(value) as GenerateImageInput;
  });

export const editImageSchema = z
  .preprocess(injectGifSizeDefault, editObjectSchema)
  .transform((value): EditImageInput => {
    assertCompressionRules(value);
    assertBackgroundRules(value);
    assertQualityRules(value);
    assertComplexityRules(value);
    assertOutputFormatRules(value);
    assertMaskRules(value);
    assertMarkupRules(value);
    return normalizeCompression(value) as EditImageInput;
  });
