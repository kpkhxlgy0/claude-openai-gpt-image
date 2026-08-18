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
  readonly prompt: string;
  readonly quality: ProviderQuality;
  readonly size: ProviderSize;
  readonly output_format: ProviderOutputFormat;
  readonly output_compression?: number;
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
  generate(request: ProviderGenerateRequest): Promise<ProviderImage>;
  edit(request: ProviderEditRequest): Promise<ProviderImage>;
}
