import { AppError } from "../errors.ts";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidBase64(message: string): never {
  throw new AppError("INVALID_PROVIDER_RESPONSE", message);
}

export function decodeStrictBase64(value: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    invalidBase64("Base64 byte limit must be a nonnegative safe integer");
  }

  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedLength) {
    invalidBase64("Provider image data exceeds the decoded byte limit");
  }

  if (!BASE64_PATTERN.test(value)) {
    invalidBase64("Provider image data is not canonical Base64");
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > maxBytes) {
    invalidBase64("Provider image data exceeds the decoded byte limit");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== decodedLength || decoded.toString("base64") !== value) {
    invalidBase64("Provider image data is not canonical Base64");
  }

  return decoded;
}
