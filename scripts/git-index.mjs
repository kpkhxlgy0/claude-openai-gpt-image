import { execFileSync } from "node:child_process";

const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const INDEX_ENTRY_PATTERN = /^([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([\s\S]+)$/;

export function parseGitIndexEntries(output) {
  if (typeof output !== "string") {
    throw new TypeError("Git-index listing must be text");
  }
  if (output !== "" && !output.endsWith("\0")) {
    throw new Error("Git-index listing is not NUL terminated");
  }

  return output
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const match = INDEX_ENTRY_PATTERN.exec(record);
      if (match === null) {
        throw new Error("Git-index entry has an invalid format");
      }
      return Object.freeze({
        mode: match[1],
        objectId: match[2],
        stage: Number(match[3]),
        path: match[4],
      });
    });
}

export function readGitIndexEntries(cwd, env = process.env) {
  const output = execFileSync(
    "git",
    ["ls-files", "--stage", "-z", "--", "."],
    {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: MAX_INDEX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return parseGitIndexEntries(output);
}

export function readGitBlobText(cwd, objectId, env = process.env) {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error("Git object ID is invalid");
  }
  return execFileSync("git", ["cat-file", "blob", objectId], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: MAX_INDEX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
