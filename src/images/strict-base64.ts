import { AppError } from "../errors.ts";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

  if (padding === 2) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 3]!);
    if ((finalSextet & 0x0f) !== 0) {
      invalidBase64("Provider image data is not canonical Base64");
    }
  } else if (padding === 1) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 2]!);
    if ((finalSextet & 0x03) !== 0) {
      invalidBase64("Provider image data is not canonical Base64");
    }
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== decodedLength) {
    invalidBase64("Provider image data is not canonical Base64");
  }

  return decoded;
}
