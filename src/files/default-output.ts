import { randomBytes as secureRandomBytes } from "node:crypto";
import path from "node:path";
import type { ImageFormat } from "../images/types.ts";

export type RandomBytesSource = (size: number) => Uint8Array;

const DEFAULT_OUTPUT_DIRECTORY = ".claude/generated-images/gpt-image-2";
const RANDOM_SUFFIX_BYTES = 4;

function utcTimestamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

export function makeDefaultOutputPath(
  format: ImageFormat,
  now: Date = new Date(),
  randomBytes: RandomBytesSource = secureRandomBytes,
): string {
  const random = Buffer.from(randomBytes(RANDOM_SUFFIX_BYTES));
  if (random.length !== RANDOM_SUFFIX_BYTES) {
    throw new TypeError("Random byte source returned an unexpected length");
  }

  const filename = `${utcTimestamp(now)}-${random.toString("hex")}.${format}`;
  return path.posix.join(DEFAULT_OUTPUT_DIRECTORY, filename);
}
