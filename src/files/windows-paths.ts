import { AppError } from "../errors.ts";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function reject(message: string): never {
  throw new AppError("PATH_OUTSIDE_WORKSPACE", message);
}

/**
 * Reject dangerous Windows path spellings portably, before any OS-specific
 * resolution. Separators are normalized only after lexical rejection.
 */
export function assertPortableRelativePath(value: string): void {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", "Path must be a string");
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new AppError("INVALID_INPUT", "Path must not be empty");
  }
  if (value.includes("\0")) {
    reject("Path must not contain NUL bytes");
  }

  // Reject absolute/device/UNC forms before separator normalization.
  if (value.startsWith("/") || value.startsWith("\\")) {
    reject("Absolute or UNC paths are not allowed as relative paths");
  }
  if (/^[A-Za-z]:/.test(value)) {
    reject("Drive-prefixed paths are not allowed as relative paths");
  }
  if (value.includes(":") ) {
    // Alternate data streams and any remaining colon forms.
    reject("Path must not contain alternate data stream colons");
  }

  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("//")) {
    reject("Path must not contain empty or absolute segments");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      reject("Path must not contain empty segments");
    }
    if (segment === "." || segment === "..") {
      reject("Path traversal segments are not allowed");
    }
    // Reserved device names match the base name without extension.
    const base = segment.includes(".")
      ? segment.slice(0, segment.indexOf("."))
      : segment;
    if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
      reject("Windows reserved device names are not allowed");
    }
  }
}

export function toPosixRelative(value: string): string {
  return value.replaceAll("\\", "/");
}
