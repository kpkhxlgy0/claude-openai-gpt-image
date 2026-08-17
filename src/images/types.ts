export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  hasAlpha: boolean;
}

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 16_384;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;

export type ImageValidationFailure = (message: string) => never;

export function assertImageDimensions(
  width: number,
  height: number,
  fail: ImageValidationFailure,
): void {
  if (width === 0 || height === 0) fail("dimensions must be nonzero");
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    fail("dimensions exceed the supported edge limit");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
    fail("pixel count exceeds the supported limit");
  }
}
