import { z } from "zod";
import { AppError } from "./errors.ts";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  EXTENDED_QUALITY_MODELS,
  IMAGE_BACKGROUNDS,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  TRANSPARENT_BACKGROUND_MODELS,
  type ProviderBackground,
  type ProviderModel,
  type ProviderQuality,
} from "./openai/types.ts";

const PROMPT_MAX = 32_000;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 3;

export interface ImageSize {
  width: number;
  height: number;
}

export interface GenerateImageInput {
  model: ProviderModel;
  prompt: string;
  quality: ProviderQuality;
  size: "auto" | `${number}x${number}`;
  output_format: "png" | "jpeg" | "webp";
  output_compression?: number;
  background: ProviderBackground;
  moderation: "auto" | "low";
  output_path?: string;
  workspace_root?: string;
}

export interface EditImageInput extends Omit<GenerateImageInput, "moderation"> {
  image_paths: string[];
  mask_path?: string;
}

export type StatusInput = Record<string, never>;

export function parseImageSize(value: string): ImageSize | null {
  if (value === "auto") {
    return null;
  }

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

const sizeSchema = z.string().superRefine((value, ctx) => {
  try {
    parseImageSize(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message:
        error instanceof AppError ? error.message : "Invalid image size",
    });
  }
});

const promptSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(PROMPT_MAX));

const modelSchema = z.enum(IMAGE_MODELS).default(DEFAULT_IMAGE_MODEL);
const qualitySchema = z.enum(IMAGE_QUALITIES).default(DEFAULT_IMAGE_QUALITY);
const outputFormatSchema = z.enum(["png", "jpeg", "webp"]).default("png");
const backgroundSchema = z.enum(IMAGE_BACKGROUNDS).default("auto");
const moderationSchema = z.enum(["auto", "low"]).default("auto");
const optionalPathSchema = z.string().min(1).optional();

type CompressionFields = {
  output_format: "png" | "jpeg" | "webp";
  output_compression?: number | undefined;
};

function normalizeCompression<T extends CompressionFields>(value: T): T {
  if (value.output_format === "png" && value.output_compression === 0) {
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

  if (value.output_format === "png" && value.output_compression !== 0) {
    throw new AppError(
      "INVALID_INPUT",
      "output_compression is not supported for PNG except the ignored zero default",
    );
  }
}

type BackgroundFields = {
  model: ProviderModel;
  background: ProviderBackground;
  output_format: "png" | "jpeg" | "webp";
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

  if (value.output_format === "jpeg") {
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

const generateObjectSchema = z.strictObject({
  prompt: promptSchema,
  model: modelSchema,
  quality: qualitySchema,
  size: sizeSchema.default("1024x1024"),
  output_format: outputFormatSchema,
  output_compression: z.number().int().min(0).max(100).optional(),
  background: backgroundSchema,
  moderation: moderationSchema,
  output_path: optionalPathSchema,
  workspace_root: optionalPathSchema,
});

const editObjectSchema = z.strictObject({
  prompt: promptSchema,
  model: modelSchema,
  quality: qualitySchema,
  size: sizeSchema.default("1024x1024"),
  output_format: outputFormatSchema,
  output_compression: z.number().int().min(0).max(100).optional(),
  background: backgroundSchema,
  output_path: optionalPathSchema,
  workspace_root: optionalPathSchema,
  image_paths: z.array(z.string().min(1)).min(1).max(8),
  mask_path: optionalPathSchema,
});

export const statusSchema = z.strictObject({});

export const generateImageSchema = z
  .preprocess((input) => input, generateObjectSchema)
  .transform((value): GenerateImageInput => {
    assertCompressionRules(value);
    assertBackgroundRules(value);
    assertQualityRules(value);
    return normalizeCompression(value) as GenerateImageInput;
  });

export const editImageSchema = z
  .preprocess((input) => input, editObjectSchema)
  .transform((value): EditImageInput => {
    assertCompressionRules(value);
    assertBackgroundRules(value);
    assertQualityRules(value);
    return normalizeCompression(value) as EditImageInput;
  });
