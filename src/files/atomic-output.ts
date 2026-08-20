import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as scheduleTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { AppError } from "../errors.ts";
import { inspectImage } from "../images/inspect-image.ts";
import { decodeStrictBase64 } from "../images/strict-base64.ts";
import {
  MAX_IMAGE_BYTES,
  type ImageFormat,
  type ImageInfo,
} from "../images/types.ts";
import type { ResolvedOutputPath } from "./workspace-paths.ts";
import {
  isPathInsideRoot,
  isSamePath,
} from "./workspace-roots.ts";

const TEMP_NAME_ATTEMPTS = 16;
const TEMP_REMOVE_ATTEMPTS = 3;
const TEMP_REMOVE_RETRY_DELAY_MS = 25;

export interface PublishOutputOptions {
  output: ResolvedOutputPath;
  base64: string;
  format: ImageFormat;
  signal?: AbortSignal;
}

export type PublicationWarning = "TEMP_CLEANUP_PENDING";

export interface PublishedImage {
  relativePath: string;
  absolutePath: string;
  filename: string;
  info: ImageInfo;
  sizeBytes: number;
  warnings: readonly PublicationWarning[];
}

export interface OutputPublicationOperations {
  writeAndFlushTemporary(handle: FileHandle, bytes: Buffer): Promise<void>;
  createPublicationLink(tempPath: string, finalPath: string): Promise<void>;
  removeTemporary(tempPath: string): Promise<void>;
  deferCleanup(task: () => Promise<void>): void;
}

export type OutputPublisher = (
  options: PublishOutputOptions,
) => Promise<PublishedImage>;

const nodePublicationOperations: OutputPublicationOperations = {
  async writeAndFlushTemporary(handle, bytes) {
    await handle.writeFile(bytes);
    await handle.sync();
  },
  createPublicationLink: link,
  async removeTemporary(tempPath) {
    await rm(tempPath, { force: true });
  },
  deferCleanup(task) {
    const timer = scheduleTimeout(() => {
      void task().catch(() => undefined);
    }, 1_000);
    timer.unref();
  },
};

function pathFailure(message: string, cause?: unknown): AppError {
  return new AppError(
    "PATH_OUTSIDE_WORKSPACE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertOutputExtension(
  output: ResolvedOutputPath,
  format: ImageFormat,
): void {
  const extension = path.extname(output.absolutePath).toLowerCase();
  const matches =
    (format === "png" && extension === ".png") ||
    (format === "webp" && extension === ".webp") ||
    (format === "jpeg" && (extension === ".jpeg" || extension === ".jpg"));
  if (!matches) {
    throw new AppError(
      "INVALID_INPUT",
      "Output filename extension must match the requested image format",
    );
  }
}

async function inspectCanonicalDirectory(
  directoryPath: string,
  rootCanonicalPath: string,
): Promise<string> {
  let stats;
  let canonicalPath: string;
  try {
    stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw pathFailure("Output parent contains an unsafe path component");
    }
    canonicalPath = await realpath(directoryPath);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw pathFailure("Output parent directory could not be resolved safely", error);
  }

  if (
    !isSamePath(canonicalPath, directoryPath) ||
    !isPathInsideRoot(rootCanonicalPath, canonicalPath)
  ) {
    throw pathFailure("Output parent escapes the approved workspace root");
  }
  return canonicalPath;
}

// Node 20 does not expose handle-relative mkdir/link operations on Windows.
// These checks reject existing reparse-point escapes and recheck immediately
// before the no-overwrite hard-link commit; concurrent directory replacement
// by another process with the same filesystem authority is outside this boundary.
async function canonicalOutputParent(
  output: ResolvedOutputPath,
): Promise<string> {
  const rootCanonicalPath = await inspectCanonicalDirectory(
    output.root.canonicalPath,
    output.root.canonicalPath,
  );
  const relativeParent = path.relative(rootCanonicalPath, output.parentPath);
  if (
    relativeParent.startsWith("..") ||
    path.isAbsolute(relativeParent) ||
    relativeParent.includes("\0")
  ) {
    throw pathFailure("Output parent escapes the approved workspace root");
  }

  let currentPath = rootCanonicalPath;
  const segments = relativeParent === "" ? [] : relativeParent.split(path.sep);
  for (const segment of segments) {
    const nextPath = path.join(currentPath, segment);
    let created = false;
    try {
      await lstat(nextPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw pathFailure("Output parent component could not be checked safely", error);
      }

      await inspectCanonicalDirectory(currentPath, rootCanonicalPath);
      try {
        await mkdir(nextPath, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw pathFailure(
            "Output parent directory could not be created safely",
            mkdirError,
          );
        }
      }
    }

    try {
      currentPath = await inspectCanonicalDirectory(nextPath, rootCanonicalPath);
    } catch (error) {
      if (created) {
        await rm(nextPath, { recursive: false, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  if (!isSamePath(currentPath, output.parentPath)) {
    throw pathFailure("Output parent changed during directory creation");
  }
  return currentPath;
}

async function recheckCanonicalParent(
  output: ResolvedOutputPath,
  canonicalParent: string,
): Promise<void> {
  const currentParent = await inspectCanonicalDirectory(
    output.parentPath,
    output.root.canonicalPath,
  );
  if (!isSamePath(currentParent, canonicalParent)) {
    throw pathFailure("Output parent changed during publication");
  }
}

async function createExclusiveTemp(
  parentPath: string,
): Promise<{ handle: FileHandle; tempPath: string }> {
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt += 1) {
    const suffix = randomBytes(12).toString("hex");
    const tempPath = path.join(parentPath, `.gpt-image-${suffix}.tmp`);
    try {
      return {
        handle: await open(tempPath, "wx", 0o600),
        tempPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw new AppError(
        "INTERNAL_ERROR",
        "Temporary output file could not be created",
        { cause: error },
      );
    }
  }

  throw new AppError(
    "INTERNAL_ERROR",
    "A unique temporary output file could not be created",
  );
}

async function createFlushedTemp(
  operations: OutputPublicationOperations,
  parentPath: string,
  bytes: Buffer,
): Promise<string> {
  const { handle, tempPath } = await createExclusiveTemp(parentPath);
  let failure: AppError | undefined;
  try {
    await operations.writeAndFlushTemporary(handle, bytes);
  } catch (error) {
    failure = new AppError(
      "INTERNAL_ERROR",
      "Temporary output file could not be written safely",
      { cause: error },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (failure !== undefined) {
    await removeTemporaryWithRetries(operations, tempPath);
    throw failure;
  }
  return tempPath;
}

async function validateProviderSnapshot(
  tempPath: string,
  format: ImageFormat,
): Promise<ImageInfo> {
  let storedBytes: Buffer;
  try {
    storedBytes = await readFile(tempPath);
  } catch (error) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Temporary output file could not be read for validation",
      { cause: error },
    );
  }

  try {
    return await inspectImage(storedBytes, format);
  } catch (error) {
    if (error instanceof AppError && error.code === "INPUT_FILE_INVALID") {
      throw new AppError(
        "INVALID_PROVIDER_RESPONSE",
        "Provider image payload failed validation",
      );
    }
    throw error;
  }
}

async function assertDestinationAbsent(finalPath: string): Promise<void> {
  try {
    await lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new AppError(
      "INTERNAL_ERROR",
      "Output destination could not be checked safely",
      { cause: error },
    );
  }
  throw new AppError("OUTPUT_EXISTS", "Output path already exists");
}

async function publishHardLink(
  operations: OutputPublicationOperations,
  tempPath: string,
  finalPath: string,
): Promise<void> {
  try {
    await operations.createPublicationLink(tempPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AppError("OUTPUT_EXISTS", "Output path already exists");
    }
    throw new AppError(
      "INTERNAL_ERROR",
      "Output file could not be published",
      { cause: error },
    );
  }
}

async function removeTemporaryWithRetries(
  operations: OutputPublicationOperations,
  tempPath: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMP_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await operations.removeTemporary(tempPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < TEMP_REMOVE_ATTEMPTS) {
        await delay(TEMP_REMOVE_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw new AppError(
    "INTERNAL_ERROR",
    "Temporary output file could not be removed safely",
    { cause: lastError },
  );
}

async function publishOutputWithOperations(
  options: PublishOutputOptions,
  operations: OutputPublicationOperations,
): Promise<PublishedImage> {
  options.signal?.throwIfAborted();
  assertOutputExtension(options.output, options.format);
  const bytes = decodeStrictBase64(options.base64, MAX_IMAGE_BYTES);
  options.signal?.throwIfAborted();
  const canonicalParent = await canonicalOutputParent(options.output);
  options.signal?.throwIfAborted();
  const filename = path.basename(options.output.absolutePath);
  const finalPath = path.join(canonicalParent, filename);

  if (!isSamePath(finalPath, options.output.absolutePath)) {
    throw pathFailure("Output destination changed during publication");
  }

  await assertDestinationAbsent(finalPath);
  options.signal?.throwIfAborted();

  let tempPath: string | undefined;
  let publicationCommitted = false;
  let cleanupPending = false;
  let published: PublishedImage | undefined;
  try {
    tempPath = await createFlushedTemp(
      operations,
      canonicalParent,
      bytes,
    );
    options.signal?.throwIfAborted();

    const info = await validateProviderSnapshot(tempPath, options.format);
    options.signal?.throwIfAborted();
    await recheckCanonicalParent(options.output, canonicalParent);
    options.signal?.throwIfAborted();
    await publishHardLink(operations, tempPath, finalPath);
    publicationCommitted = true;
    published = {
      relativePath: options.output.relativePath,
      absolutePath: finalPath,
      filename,
      info,
      sizeBytes: bytes.length,
      warnings: [],
    };
  } finally {
    if (tempPath !== undefined) {
      try {
        await removeTemporaryWithRetries(operations, tempPath);
      } catch (error) {
        if (!publicationCommitted) {
          throw error;
        }
        cleanupPending = true;
        try {
          operations.deferCleanup(() =>
            removeTemporaryWithRetries(operations, tempPath!),
          );
        } catch {
          // The published output remains valid; the warning below reports that
          // automatic cleanup could not be guaranteed.
        }
      }
    }
  }

  if (published === undefined) {
    throw new AppError("INTERNAL_ERROR", "Output publication did not complete");
  }
  if (cleanupPending) {
    return {
      ...published,
      warnings: ["TEMP_CLEANUP_PENDING"],
    };
  }
  return published;
}

export function createOutputPublisher(
  overrides: Partial<OutputPublicationOperations> = {},
): OutputPublisher {
  const operations: OutputPublicationOperations = {
    ...nodePublicationOperations,
    ...overrides,
  };
  return (options) => publishOutputWithOperations(options, operations);
}

export const publishOutput: OutputPublisher = createOutputPublisher();
