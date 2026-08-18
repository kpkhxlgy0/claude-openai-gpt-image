import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "../errors.ts";
import { inspectImage } from "../images/inspect-image.ts";
import type { ImageInfo } from "../images/types.ts";
import type { ResolvedInputPath } from "./workspace-paths.ts";
import { isPathInsideRoot } from "./workspace-roots.ts";

export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_AGGREGATE_INPUT_BYTES = 200 * 1024 * 1024;

const COPY_BUFFER_BYTES = 64 * 1024;

export interface InputSnapshot {
  readonly originalRelativePath: string;
  readonly snapshotPath: string;
  readonly filename: string;
  readonly info: Readonly<ImageInfo>;
  readonly sizeBytes: number;
}

export interface InputSnapshotSet {
  readonly snapshots: readonly InputSnapshot[];
  dispose(): Promise<void>;
}

export interface InputSnapshotOperations {
  removeSnapshotDirectory(snapshotDirectory: string): Promise<void>;
}

export type InputSnapshotter = (
  paths: readonly ResolvedInputPath[],
  pluginDataRoot?: string,
) => Promise<InputSnapshotSet>;

interface OpenInput {
  resolved: ResolvedInputPath;
  handle: FileHandle;
  sizeBytes: number;
  initialMtimeNs: bigint;
  initialCtimeNs: bigint;
}

function invalidInput(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", message);
}

function snapshotStorageFailure(message: string, cause: unknown): AppError {
  return new AppError("INTERNAL_ERROR", message, { cause });
}

async function closeAll(inputs: readonly OpenInput[]): Promise<void> {
  await Promise.allSettled(inputs.map(({ handle }) => handle.close()));
}

async function assertOpenedInputContained(
  resolved: ResolvedInputPath,
  handleStats: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> {
  let canonicalPath: string;
  let pathStats;
  try {
    canonicalPath = await realpath(resolved.absolutePath);
    if (!isPathInsideRoot(resolved.root.canonicalPath, canonicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Input file moved outside the approved workspace root",
      );
    }
    pathStats = await stat(canonicalPath, { bigint: true });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Input file identity could not be verified",
      { cause: error },
    );
  }

  if (
    !pathStats.isFile() ||
    pathStats.dev !== handleStats.dev ||
    pathStats.ino !== handleStats.ino
  ) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Input file changed during workspace validation",
    );
  }
}

async function openValidatedInput(
  resolved: ResolvedInputPath,
): Promise<OpenInput> {
  let handle: FileHandle;
  try {
    handle = await open(resolved.absolutePath, "r");
  } catch (error) {
    throw new AppError("INPUT_FILE_INVALID", "Input file could not be opened", {
      cause: error,
    });
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      invalidInput("Input path must refer to a regular file");
    }
    await assertOpenedInputContained(resolved, stats);
    if (stats.size > BigInt(MAX_INPUT_BYTES)) {
      invalidInput("Input file exceeds the 50 MiB limit");
    }

    return {
      resolved,
      handle,
      sizeBytes: Number(stats.size),
      initialMtimeNs: stats.mtimeNs,
      initialCtimeNs: stats.ctimeNs,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "INPUT_FILE_INVALID",
      "Input file could not be inspected",
      { cause: error },
    );
  }
}

async function openAndMeasureInputs(
  paths: readonly ResolvedInputPath[],
): Promise<OpenInput[]> {
  const opened: OpenInput[] = [];
  let aggregateBytes = 0;

  try {
    for (const resolved of paths) {
      const input = await openValidatedInput(resolved);
      aggregateBytes += input.sizeBytes;
      if (aggregateBytes > MAX_AGGREGATE_INPUT_BYTES) {
        await input.handle.close().catch(() => undefined);
        invalidInput("Input files exceed the 200 MiB aggregate limit");
      }
      opened.push(input);
    }
    return opened;
  } catch (error) {
    await closeAll(opened);
    throw error;
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      invalidInput("Snapshot file could not be written completely");
    }
    written += result.bytesWritten;
  }
}

async function copyStableInput(
  input: OpenInput,
  snapshotPath: string,
): Promise<void> {
  let destination: FileHandle;
  try {
    destination = await open(snapshotPath, "wx", 0o600);
  } catch (error) {
    throw snapshotStorageFailure(
      "Snapshot file could not be created safely",
      error,
    );
  }

  try {
    const buffer = Buffer.allocUnsafe(
      Math.max(1, Math.min(COPY_BUFFER_BYTES, input.sizeBytes)),
    );
    let position = 0;
    while (position < input.sizeBytes) {
      const length = Math.min(buffer.length, input.sizeBytes - position);
      const { bytesRead } = await input.handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        invalidInput("Input file changed while it was being copied");
      }
      await writeAll(destination, buffer, bytesRead, position);
      position += bytesRead;
    }

    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await input.handle.read(
      extra,
      0,
      1,
      input.sizeBytes,
    );
    if (extraBytes !== 0) {
      invalidInput("Input file changed while it was being copied");
    }

    const finalStats = await input.handle.stat({ bigint: true });
    if (
      finalStats.size !== BigInt(input.sizeBytes) ||
      finalStats.mtimeNs !== input.initialMtimeNs ||
      finalStats.ctimeNs !== input.initialCtimeNs
    ) {
      invalidInput("Input file changed while it was being copied");
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw snapshotStorageFailure(
      "Input snapshot could not be created safely",
      error,
    );
  } finally {
    await destination.close().catch(() => undefined);
  }
}

async function removeSnapshotDirectory(snapshotDirectory: string): Promise<void> {
  await rm(snapshotDirectory, {
    recursive: true,
    force: true,
    maxRetries: 3,
  });
}

function createSnapshotSet(
  snapshotDirectory: string,
  snapshots: readonly InputSnapshot[],
  operations: InputSnapshotOperations,
): InputSnapshotSet {
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise === undefined) {
      disposePromise = operations.removeSnapshotDirectory(snapshotDirectory).catch(
        (error: unknown) => {
          disposePromise = undefined;
          throw snapshotStorageFailure(
            "Input snapshots could not be removed safely",
            error,
          );
        },
      );
    }
    return disposePromise;
  };

  return Object.freeze({
    snapshots: Object.freeze(snapshots.slice()),
    dispose,
  });
}

async function snapshotInputsWithOperations(
  paths: readonly ResolvedInputPath[],
  pluginDataRoot: string | undefined,
  operations: InputSnapshotOperations,
): Promise<InputSnapshotSet> {
  const opened = await openAndMeasureInputs(paths);
  let snapshotDirectory: string | undefined;

  try {
    if (pluginDataRoot !== undefined) {
      try {
        await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw snapshotStorageFailure(
          "Snapshot storage directory could not be prepared safely",
          error,
        );
      }
    }
    try {
      snapshotDirectory = await mkdtemp(
        path.join(pluginDataRoot ?? tmpdir(), ".gpt-image-input-"),
      );
    } catch (error) {
      throw snapshotStorageFailure(
        "Snapshot storage directory could not be created safely",
        error,
      );
    }

    const snapshots: InputSnapshot[] = [];
    for (const [index, input] of opened.entries()) {
      const snapshotPath = path.join(snapshotDirectory, `${index}.snapshot`);
      await copyStableInput(input, snapshotPath);
      let bytes: Buffer;
      try {
        bytes = await readFile(snapshotPath);
      } catch (error) {
        throw snapshotStorageFailure(
          "Input snapshot could not be read for validation",
          error,
        );
      }
      const info = Object.freeze({ ...(await inspectImage(bytes)) });
      snapshots.push(
        Object.freeze({
          originalRelativePath: input.resolved.relativePath,
          snapshotPath,
          filename: path.basename(input.resolved.relativePath),
          info,
          sizeBytes: input.sizeBytes,
        }),
      );
    }

    return createSnapshotSet(snapshotDirectory, snapshots, operations);
  } catch (error) {
    if (snapshotDirectory !== undefined) {
      try {
        await operations.removeSnapshotDirectory(snapshotDirectory);
      } catch (cleanupError) {
        throw snapshotStorageFailure(
          "Partial input snapshots could not be removed safely",
          cleanupError,
        );
      }
    }
    throw error;
  } finally {
    await closeAll(opened);
  }
}

const nodeSnapshotOperations: InputSnapshotOperations = {
  removeSnapshotDirectory,
};

export function createInputSnapshotter(
  overrides: Partial<InputSnapshotOperations> = {},
): InputSnapshotter {
  const operations: InputSnapshotOperations = {
    ...nodeSnapshotOperations,
    ...overrides,
  };
  return (paths, pluginDataRoot) =>
    snapshotInputsWithOperations(paths, pluginDataRoot, operations);
}

export const snapshotInputs: InputSnapshotter = createInputSnapshotter();
