export const IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
] as const;
export type ProviderModel = (typeof IMAGE_MODELS)[number];
export const DEFAULT_IMAGE_MODEL = "gpt-image-2" as const satisfies ProviderModel;

export const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
export type ProviderBackground = (typeof IMAGE_BACKGROUNDS)[number];

// The only models allowed to request a transparent background. The API marks
// gpt-image-2 transparency as preview, so it is rejected locally until it is
// added here.
export const TRANSPARENT_BACKGROUND_MODELS: readonly ProviderModel[] =
  Object.freeze(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);

export type ProviderQuality = "auto" | "low" | "medium" | "high";
export type ProviderSize = "auto" | `${number}x${number}`;
export type ProviderOutputFormat = "png" | "jpeg" | "webp";
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
}

export interface ProviderGenerateRequest extends ProviderImageRequest {
  readonly moderation: ProviderModeration;
}

export interface ProviderEditRequest extends ProviderImageRequest {
  readonly images: readonly ProviderInputSnapshot[];
  readonly mask?: ProviderInputSnapshot;
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
