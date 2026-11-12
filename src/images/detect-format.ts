import { PNG_SIGNATURE } from "./png.ts";
import type { OutputImageFormat } from "./types.ts";

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF_SIGNATURES = ["GIF87a", "GIF89a"] as const;
const WEBP_HEADER_BYTES = 12;
/** Every SVG check reads at most this many leading bytes. */
const SVG_SNIFF_BYTES = 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const SVG_ROOT = "<svg";

function hasBytesAt(
  bytes: Uint8Array,
  offset: number,
  expected: ArrayLike<number>,
): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

/** True when `text` occurs at `offset` and ends at or before `end`. */
function hasAsciiAt(
  bytes: Uint8Array,
  offset: number,
  text: string,
  end = bytes.length,
): boolean {
  if (offset + text.length > end) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** Like `hasAsciiAt`, ignoring ASCII letter case; `lowerText` is lowercase. */
function hasAsciiAtIgnoreCase(
  bytes: Uint8Array,
  offset: number,
  lowerText: string,
  end: number,
): boolean {
  if (offset + lowerText.length > end) return false;
  for (let index = 0; index < lowerText.length; index += 1) {
    const byte = bytes[offset + index]!;
    const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    if (lower !== lowerText.charCodeAt(index)) return false;
  }
  return true;
}

function isAsciiWhitespace(byte: number | undefined): boolean {
  return (
    byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20
  );
}

function skipWhitespace(bytes: Uint8Array, start: number, end: number): number {
  let position = start;
  while (position < end && isAsciiWhitespace(bytes[position])) position += 1;
  return position;
}

/** Index just past the first `terminator` in [start, end), if any. */
function indexAfter(
  bytes: Uint8Array,
  start: number,
  terminator: string,
  end: number,
): number | undefined {
  for (let offset = start; offset + terminator.length <= end; offset += 1) {
    if (hasAsciiAt(bytes, offset, terminator, end)) return offset + terminator.length;
  }
  return undefined;
}

/**
 * Index just past a DOCTYPE declaration whose keyword ends at `start`. The
 * declaration ends at the first `>`, unless a `[` comes first: then it ends at
 * the first `]` followed by optional whitespace and `>`.
 */
function indexAfterDoctype(
  bytes: Uint8Array,
  start: number,
  end: number,
): number | undefined {
  for (let offset = start; offset < end; offset += 1) {
    const byte = bytes[offset];
    if (byte === GREATER_THAN) return offset + 1;
    if (byte === OPEN_BRACKET) {
      for (let inner = offset + 1; inner < end; inner += 1) {
        if (bytes[inner] !== CLOSE_BRACKET) continue;
        const close = skipWhitespace(bytes, inner + 1, end);
        if (close < end && bytes[close] === GREATER_THAN) return close + 1;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Index just past the prolog construct at `position`, or `undefined`. */
function indexAfterPrologConstruct(
  bytes: Uint8Array,
  position: number,
  end: number,
): number | undefined {
  if (hasAsciiAt(bytes, position, "<?", end)) {
    return indexAfter(bytes, position + 2, "?>", end);
  }
  if (hasAsciiAt(bytes, position, "<!--", end)) {
    return indexAfter(bytes, position + 4, "-->", end);
  }
  if (hasAsciiAtIgnoreCase(bytes, position, "<!doctype", end)) {
    return indexAfterDoctype(bytes, position + 9, end);
  }
  return undefined;
}

function isPrologConstructStart(
  bytes: Uint8Array,
  position: number,
  end: number,
): boolean {
  return (
    hasAsciiAt(bytes, position, "<?", end) ||
    hasAsciiAt(bytes, position, "<!--", end) ||
    hasAsciiAtIgnoreCase(bytes, position, "<!doctype", end)
  );
}

/**
 * True when the first element is an `<svg` root. Within the first 1024 bytes,
 * skips an optional UTF-8 BOM, ASCII whitespace, and any XML declarations,
 * processing instructions, comments, and DOCTYPE declarations, then requires
 * `<svg` followed by ASCII whitespace, `>`, or `/`. A construct that does not
 * end inside that window, or any other first element, is not an SVG.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SVG_SNIFF_BYTES);
  let position = hasBytesAt(bytes, 0, UTF8_BOM) ? UTF8_BOM.length : 0;
  position = skipWhitespace(bytes, position, end);
  while (isPrologConstructStart(bytes, position, end)) {
    const next = indexAfterPrologConstruct(bytes, position, end);
    if (next === undefined) return false;
    position = skipWhitespace(bytes, next, end);
  }

  const delimiter = position + SVG_ROOT.length;
  if (!hasAsciiAt(bytes, position, SVG_ROOT, end) || delimiter >= end) return false;
  const byte = bytes[delimiter];
  return isAsciiWhitespace(byte) || byte === GREATER_THAN || byte === SLASH;
}

/**
 * Names the output format whose signature starts `bytes`, or returns
 * `undefined` when none matches. Only leading signature bytes are compared;
 * nothing is decoded, so a match says nothing about validity. Never throws.
 */
export function detectOutputImageFormat(
  bytes: Uint8Array,
): OutputImageFormat | undefined {
  if (hasBytesAt(bytes, 0, PNG_SIGNATURE)) return "png";
  if (hasBytesAt(bytes, 0, JPEG_SIGNATURE)) return "jpeg";
  if (GIF_SIGNATURES.some((signature) => hasAsciiAt(bytes, 0, signature))) {
    return "gif";
  }
  if (
    bytes.length >= WEBP_HEADER_BYTES &&
    hasAsciiAt(bytes, 0, "RIFF") &&
    hasAsciiAt(bytes, 8, "WEBP")
  ) {
    return "webp";
  }
  if (looksLikeSvg(bytes)) return "svg";
  return undefined;
}
