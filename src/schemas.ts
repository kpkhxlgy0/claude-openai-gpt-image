import { z } from "zod";
import { AppError } from "./errors.ts";

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
  prompt: string;
  quality: "auto" | "low" | "medium" | "high";
  size: "auto" | `${number}x${number}`;
  output_format: "png" | "jpeg" | "webp";
  output_compression?: number;
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

const qualitySchema = z.enum(["auto", "low", "medium", "high"]).default("auto");
const outputFormatSchema = z.enum(["png", "jpeg", "webp"]).default("png");
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

const generateObjectSchema = z.strictObject({
  prompt: promptSchema,
  quality: qualitySchema,
  size: sizeSchema.default("1024x1024"),
  output_format: outputFormatSchema,
  output_compression: z.number().int().min(0).max(100).optional(),
  moderation: moderationSchema,
  output_path: optionalPathSchema,
  workspace_root: optionalPathSchema,
});

const editObjectSchema = z.strictObject({
  prompt: promptSchema,
  quality: qualitySchema,
  size: sizeSchema.default("1024x1024"),
  output_format: outputFormatSchema,
  output_compression: z.number().int().min(0).max(100).optional(),
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
    return normalizeCompression(value) as GenerateImageInput;
  });

export const editImageSchema = z
  .preprocess((input) => input, editObjectSchema)
  .transform((value): EditImageInput => {
    assertCompressionRules(value);
    return normalizeCompression(value) as EditImageInput;
  });
