export const IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
] as const;
export type ProviderModel = (typeof IMAGE_MODELS)[number];
export const DEFAULT_IMAGE_MODEL =
  "gpt-image-2.6-flare" as const satisfies ProviderModel;

// The GPT Image 2.6 models. Model-specific 2.6 request fields such as
// complexity are rejected locally for every other model.
export const GPT_IMAGE_2_6_MODELS: readonly ProviderModel[] = Object.freeze([
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
]);

export const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
export type ProviderBackground = (typeof IMAGE_BACKGROUNDS)[number];

// The only models allowed to request a transparent background. The API marks
// gpt-image-2 transparency as preview, so it is rejected locally until it is
// added here.
export const TRANSPARENT_BACKGROUND_MODELS: readonly ProviderModel[] =
  Object.freeze([
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ]);

export const IMAGE_QUALITIES = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ProviderQuality = (typeof IMAGE_QUALITIES)[number];
export const DEFAULT_IMAGE_QUALITY = "high" as const satisfies ProviderQuality;

// The only models allowed to request the xhigh and max quality tiers. The API
// documents these tiers only for the GPT Image 2.5 and 2.6 models, so
// gpt-image-2 is rejected locally until it is added here.
export const EXTENDED_QUALITY_MODELS: readonly ProviderModel[] =
  Object.freeze([
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ]);

// The only models allowed to send a markup layer with an edit. The API
// documents markup-guided edits only for the GPT Image 2.5 and 2.6 models, so
// gpt-image-2 is rejected locally until it is added here.
export const MARKUP_MODELS: readonly ProviderModel[] = Object.freeze([
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
]);

// Omitting complexity leaves the model default in effect.
export const IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export type ProviderComplexity = (typeof IMAGE_COMPLEXITIES)[number];

export type ProviderSize = "auto" | `${number}x${number}`;

// GIF and SVG output require a GPT Image 2.6 model. Edits cannot output SVG.
export const IMAGE_OUTPUT_FORMATS = [
  "png",
  "jpeg",
  "webp",
  "gif",
  "svg",
] as const;
export type ProviderOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type ProviderEditOutputFormat = Exclude<ProviderOutputFormat, "svg">;
export const EDIT_OUTPUT_FORMATS = [
  "png",
  "jpeg",
  "webp",
  "gif",
] as const satisfies readonly ProviderEditOutputFormat[];

export type ProviderModeration = "auto" | "low";

export interface ProviderInputSnapshot {
  readonly snapshotPath: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly info: Readonly<{
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  }>;
}

interface ProviderImageRequest {
  readonly model: ProviderModel;
  readonly prompt: string;
  readonly quality: ProviderQuality;
  readonly size: ProviderSize;
  readonly output_format: ProviderOutputFormat;
  readonly output_compression?: number;
  readonly background: ProviderBackground;
  readonly complexity?: ProviderComplexity;
  readonly frame_count?: number;
  readonly frame_duration_ms?: number;
}

export interface ProviderGenerateRequest extends ProviderImageRequest {
  readonly moderation: ProviderModeration;
}

export interface ProviderEditRequest extends ProviderImageRequest {
  readonly output_format: ProviderEditOutputFormat;
  readonly images: readonly ProviderInputSnapshot[];
  readonly mask?: ProviderInputSnapshot;
  // A transparent PNG annotation layer. It cannot be combined with a mask.
  readonly markup?: ProviderInputSnapshot;
}

export interface ProviderTokenDetails {
  readonly image_tokens: number;
  readonly text_tokens: number;
}

export interface ProviderImageUsage {
  readonly input_tokens: number;
  readonly input_tokens_details: ProviderTokenDetails;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly output_tokens_details?: ProviderTokenDetails;
}

export interface ProviderImage {
  readonly base64: string;
  readonly requestId?: string;
  readonly usage?: ProviderImageUsage;
}

export interface ImageProvider {
  generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage>;
  edit(
    request: ProviderEditRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage>;
}
