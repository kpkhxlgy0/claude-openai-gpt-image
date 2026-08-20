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
import { setTimeout as scheduleTimeout } from "node:timers";
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
  readInput(
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  removeSnapshotDirectory(snapshotDirectory: string): Promise<void>;
  deferCleanup(task: () => Promise<void>): void;
}

export type InputSnapshotter = (
  paths: readonly ResolvedInputPath[],
  pluginDataRoot?: string,
  signal?: AbortSignal,
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
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let canonicalPath: string;
  let pathStats;
  try {
    canonicalPath = await realpath(resolved.absolutePath);
    signal?.throwIfAborted();
    if (!isPathInsideRoot(resolved.root.canonicalPath, canonicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Input file moved outside the approved workspace root",
      );
    }
    pathStats = await stat(canonicalPath, { bigint: true });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<OpenInput> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await open(resolved.absolutePath, "r");
  } catch (error) {
    signal?.throwIfAborted();
    throw new AppError("INPUT_FILE_INVALID", "Input file could not be opened", {
      cause: error,
    });
  }

  try {
    signal?.throwIfAborted();
    const stats = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!stats.isFile()) {
      invalidInput("Input path must refer to a regular file");
    }
    await assertOpenedInputContained(resolved, stats, signal);
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
    signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<OpenInput[]> {
  const opened: OpenInput[] = [];
  let aggregateBytes = 0;

  try {
    for (const resolved of paths) {
      signal?.throwIfAborted();
      const input = await openValidatedInput(resolved, signal);
      aggregateBytes += input.sizeBytes;
      if (aggregateBytes > MAX_AGGREGATE_INPUT_BYTES) {
        await input.handle.close().catch(() => undefined);
        invalidInput("Input files exceed the 200 MiB aggregate limit");
      }
      opened.push(input);
    }
    signal?.throwIfAborted();
    return opened;
  } catch (error) {
    await closeAll(opened);
    signal?.throwIfAborted();
    throw error;
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  let written = 0;
  while (written < length) {
    signal?.throwIfAborted();
    const result = await handle.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    signal?.throwIfAborted();
    if (result.bytesWritten === 0) {
      invalidInput("Snapshot file could not be written completely");
    }
    written += result.bytesWritten;
  }
}

async function copyStableInput(
  input: OpenInput,
  snapshotPath: string,
  operations: InputSnapshotOperations,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let destination: FileHandle;
  try {
    destination = await open(snapshotPath, "wx", 0o600);
  } catch (error) {
    signal?.throwIfAborted();
    throw snapshotStorageFailure(
      "Snapshot file could not be created safely",
      error,
    );
  }

  try {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(
      Math.max(1, Math.min(COPY_BUFFER_BYTES, input.sizeBytes)),
    );
    let position = 0;
    while (position < input.sizeBytes) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.length, input.sizeBytes - position);
      const { bytesRead } = await operations.readInput(
        input.handle,
        buffer,
        0,
        length,
        position,
      );
      signal?.throwIfAborted();
      if (bytesRead === 0) {
        invalidInput("Input file changed while it was being copied");
      }
      await writeAll(destination, buffer, bytesRead, position, signal);
      position += bytesRead;
    }

    signal?.throwIfAborted();
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await operations.readInput(
      input.handle,
      extra,
      0,
      1,
      input.sizeBytes,
    );
    signal?.throwIfAborted();
    if (extraBytes !== 0) {
      invalidInput("Input file changed while it was being copied");
    }

    const finalStats = await input.handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      finalStats.size !== BigInt(input.sizeBytes) ||
      finalStats.mtimeNs !== input.initialMtimeNs ||
      finalStats.ctimeNs !== input.initialCtimeNs
    ) {
      invalidInput("Input file changed while it was being copied");
    }
  } catch (error) {
    signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<InputSnapshotSet> {
  signal?.throwIfAborted();
  const opened = await openAndMeasureInputs(paths, signal);
  let snapshotDirectory: string | undefined;

  try {
    signal?.throwIfAborted();
    if (pluginDataRoot !== undefined) {
      try {
        await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      throw snapshotStorageFailure(
        "Snapshot storage directory could not be created safely",
        error,
      );
    }
    signal?.throwIfAborted();

    const snapshots: InputSnapshot[] = [];
    for (const [index, input] of opened.entries()) {
      signal?.throwIfAborted();
      const snapshotPath = path.join(snapshotDirectory, `${index}.snapshot`);
      await copyStableInput(input, snapshotPath, operations, signal);
      let bytes: Buffer;
      try {
        signal?.throwIfAborted();
        bytes = await readFile(snapshotPath);
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        throw snapshotStorageFailure(
          "Input snapshot could not be read for validation",
          error,
        );
      }
      const info = Object.freeze({ ...(await inspectImage(bytes)) });
      signal?.throwIfAborted();
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

    signal?.throwIfAborted();
    return createSnapshotSet(snapshotDirectory, snapshots, operations);
  } catch (error) {
    if (snapshotDirectory !== undefined) {
      try {
        await operations.removeSnapshotDirectory(snapshotDirectory);
      } catch {
        try {
          operations.deferCleanup(() =>
            operations.removeSnapshotDirectory(snapshotDirectory!),
          );
        } catch {
          // Preserve the operation outcome even if cleanup cannot be queued.
        }
      }
    }
    signal?.throwIfAborted();
    throw error;
  } finally {
    await closeAll(opened);
  }
}

const nodeSnapshotOperations: InputSnapshotOperations = {
  readInput: (handle, buffer, offset, length, position) =>
    handle.read(buffer, offset, length, position),
  removeSnapshotDirectory,
  deferCleanup(task) {
    const timer = scheduleTimeout(() => {
      void task().catch(() => undefined);
    }, 1_000);
    timer.unref();
  },
};

export function createInputSnapshotter(
  overrides: Partial<InputSnapshotOperations> = {},
): InputSnapshotter {
  const operations: InputSnapshotOperations = {
    ...nodeSnapshotOperations,
    ...overrides,
  };
  return (paths, pluginDataRoot, signal) =>
    snapshotInputsWithOperations(paths, pluginDataRoot, operations, signal);
}

export const snapshotInputs: InputSnapshotter = createInputSnapshotter();
