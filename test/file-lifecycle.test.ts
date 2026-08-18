import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { inspectImage } from "../src/images/inspect-image.ts";
import {
  createInputSnapshotter,
  MAX_AGGREGATE_INPUT_BYTES,
  MAX_INPUT_BYTES,
  snapshotInputs,
} from "../src/files/input-snapshot.ts";
import {
  createOutputPublisher,
  publishOutput,
} from "../src/files/atomic-output.ts";
import { makeDefaultOutputPath } from "../src/files/default-output.ts";
import {
  type ResolvedInputPath,
  WorkspacePaths,
} from "../src/files/workspace-paths.ts";
import { WorkspaceRootRegistry } from "../src/files/workspace-roots.ts";
import { makeBaselineJpeg, makeLosslessWebP, makePng } from "./helpers/image-fixtures.ts";

interface LifecycleFixture {
  root: string;
  pluginDataRoot: string;
  paths: WorkspacePaths;
}

async function withLifecycleFixture(
  fn: (fixture: LifecycleFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), "gpt-image-lifecycle-"));
  const root = path.join(base, "workspace");
  const pluginDataRoot = path.join(base, "plugin-data");
  try {
    const registry = new WorkspaceRootRegistry();
    await mkdir(root, { recursive: true });
    await mkdir(pluginDataRoot, { recursive: true });
    await registry.replace([root]);
    await fn({ root, pluginDataRoot, paths: new WorkspacePaths(registry) });
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function writeSparseFile(filePath: string, size: number): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

test("snapshotInputs rejects a sparse file above 50 MiB before copying it", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    const source = path.join(root, "too-large.png");
    await writeSparseFile(source, MAX_INPUT_BYTES + 1);
    const resolved = await paths.resolveInput("too-large.png");

    await assert.rejects(
      () => snapshotInputs([resolved], pluginDataRoot),
      hasCode("INPUT_FILE_INVALID"),
    );
    assert.deepEqual(await readdir(pluginDataRoot), []);
  });
});

test("snapshotInputs rejects more than 200 MiB aggregate before copying sparse files", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    const apparentSize = Math.floor(MAX_AGGREGATE_INPUT_BYTES / 5) + 1;
    const resolved: ResolvedInputPath[] = [];
    for (let index = 0; index < 5; index += 1) {
      const filename = `aggregate-${index}.png`;
      await writeSparseFile(path.join(root, filename), apparentSize);
      resolved.push(await paths.resolveInput(filename));
    }

    await assert.rejects(
      () => snapshotInputs(resolved, pluginDataRoot),
      hasCode("INPUT_FILE_INVALID"),
    );
    assert.deepEqual(await readdir(pluginDataRoot), []);
  });
});

test("snapshotInputs rejects an input whose resolved parent was swapped outside", async (t) => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    const insideDirectory = path.join(root, "inside");
    await mkdir(insideDirectory);
    await writeFile(path.join(insideDirectory, "input.png"), makePng());
    const resolved = await paths.resolveInput("inside/input.png");
    const outside = await mkdtemp(path.join(tmpdir(), "gpt-image-input-outside-"));
    const movedInside = path.join(root, "inside-original");
    try {
      await writeFile(path.join(outside, "input.png"), makePng({ width: 5, height: 1 }));
      await rename(insideDirectory, movedInside);
      try {
        await symlink(
          outside,
          insideDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        await rename(movedInside, insideDirectory);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
          t.skip(`directory links unavailable: ${code}`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => snapshotInputs([resolved], pluginDataRoot),
        hasCode("PATH_OUTSIDE_WORKSPACE"),
      );
      assert.deepEqual(await readdir(pluginDataRoot), []);
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("snapshotInputs inspects copied PNG, JPEG, and WebP snapshots", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "input.png"), makePng({ width: 3, height: 2 }));
    await writeFile(path.join(root, "input.jpeg"), makeBaselineJpeg());
    await writeFile(path.join(root, "input.webp"), makeLosslessWebP());
    const resolved = await Promise.all([
      paths.resolveInput("input.png"),
      paths.resolveInput("input.jpeg"),
      paths.resolveInput("input.webp"),
    ]);

    const set = await snapshotInputs(resolved, pluginDataRoot);
    try {
      assert.deepEqual(
        set.snapshots.map(({ originalRelativePath, filename, info }) => ({
          originalRelativePath,
          filename,
          format: info.format,
          width: info.width,
          height: info.height,
        })),
        [
          {
            originalRelativePath: "input.png",
            filename: "input.png",
            format: "png",
            width: 3,
            height: 2,
          },
          {
            originalRelativePath: "input.jpeg",
            filename: "input.jpeg",
            format: "jpeg",
            width: 3,
            height: 2,
          },
          {
            originalRelativePath: "input.webp",
            filename: "input.webp",
            format: "webp",
            width: 3,
            height: 2,
          },
        ],
      );
      for (const snapshot of set.snapshots) {
        assert.equal(path.isAbsolute(snapshot.snapshotPath), true);
        await access(snapshot.snapshotPath);
      }
    } finally {
      await set.dispose();
    }
  });
});

test("snapshot bytes remain immutable after the original path is replaced", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    const source = path.join(root, "replace.png");
    const originalBytes = makePng({ width: 3, height: 2 });
    const replacementBytes = makePng({ width: 4, height: 1 });
    await writeFile(source, originalBytes);
    const resolved = await paths.resolveInput("replace.png");

    const set = await snapshotInputs([resolved], pluginDataRoot);
    try {
      const replacementPath = path.join(root, "replacement.png");
      await writeFile(replacementPath, replacementBytes);
      await rm(source);
      await rename(replacementPath, source);

      assert.deepEqual(await readFile(set.snapshots[0]!.snapshotPath), originalBytes);
      assert.deepEqual(await readFile(source), replacementBytes);
    } finally {
      await set.dispose();
    }
  });
});

test("snapshot disposal is concurrent-safe and idempotent", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "dispose.png"), makePng());
    const set = await snapshotInputs(
      [await paths.resolveInput("dispose.png")],
      pluginDataRoot,
    );
    const snapshotPath = set.snapshots[0]!.snapshotPath;

    await Promise.all([set.dispose(), set.dispose(), set.dispose()]);
    await set.dispose();
    await assert.rejects(() => access(snapshotPath), { code: "ENOENT" });
  });
});

test("snapshot disposal can retry after an exhausted cleanup attempt", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "retry-dispose.png"), makePng());
    let attempts = 0;
    const snapshotter = createInputSnapshotter({
      async removeSnapshotDirectory(snapshotDirectory) {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("simulated persistent sharing violation"), {
            code: "EPERM",
          });
        }
        await rm(snapshotDirectory, { recursive: true, force: true, maxRetries: 3 });
      },
    });
    const set = await snapshotter(
      [await paths.resolveInput("retry-dispose.png")],
      pluginDataRoot,
    );
    const snapshotPath = set.snapshots[0]!.snapshotPath;

    await assert.rejects(() => set.dispose(), hasCode("INTERNAL_ERROR"));
    await access(snapshotPath);
    await set.dispose();

    assert.equal(attempts, 2);
    await assert.rejects(() => access(snapshotPath), { code: "ENOENT" });
  });
});

test("snapshot creation surfaces sanitized cleanup exhaustion", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "partial-valid.png"), makePng());
    await writeFile(path.join(root, "partial-invalid.png"), "not an image");
    let cleanupAttempts = 0;
    const snapshotter = createInputSnapshotter({
      async removeSnapshotDirectory() {
        cleanupAttempts += 1;
        throw Object.assign(new Error("simulated persistent cleanup failure"), {
          code: "EPERM",
        });
      },
    });
    const resolved = await Promise.all([
      paths.resolveInput("partial-valid.png"),
      paths.resolveInput("partial-invalid.png"),
    ]);

    const failure = await captureRejection(() =>
      snapshotter(resolved, pluginDataRoot),
    );

    assert.equal(hasCode("INTERNAL_ERROR")(failure), true);
    assert.match(String(failure), /could not be removed safely/);
    assert.equal(String(failure).includes(root), false);
    assert.equal(String(failure).includes(pluginDataRoot), false);
    assert.equal(cleanupAttempts, 1);
    assert.equal((await readdir(pluginDataRoot)).length, 1);
  });
});

test("snapshotInputs cleans partial snapshots and keeps failure messages path-free", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "valid.png"), makePng());
    await writeFile(path.join(root, "invalid.png"), "not an image");
    const resolved = await Promise.all([
      paths.resolveInput("valid.png"),
      paths.resolveInput("invalid.png"),
    ]);

    const failure = await captureRejection(() =>
      snapshotInputs(resolved, pluginDataRoot),
    );

    assert.equal(hasCode("INPUT_FILE_INVALID")(failure), true);
    assert.equal(String(failure).includes(root), false);
    assert.equal(String(failure).includes(pluginDataRoot), false);
    assert.deepEqual(await readdir(pluginDataRoot), []);
  });
});

test("snapshot storage failures do not expose private paths", async () => {
  await withLifecycleFixture(async ({ root, pluginDataRoot, paths }) => {
    await writeFile(path.join(root, "storage.png"), makePng());
    await rm(pluginDataRoot, { recursive: true, force: true });
    await writeFile(pluginDataRoot, "not a directory");

    const resolved = await paths.resolveInput("storage.png");
    const failure = await captureRejection(() =>
      snapshotInputs([resolved], pluginDataRoot),
    );

    assert.equal(failure instanceof AppError, true);
    assert.equal(String(failure).includes(root), false);
    assert.equal(String(failure).includes(pluginDataRoot), false);
  });
});

async function captureRejection(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

function hasCode(code: AppError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test("makeDefaultOutputPath uses only UTC time, randomness, and format", () => {
  const now = new Date("2026-08-17T15:30:12.999Z");
  assert.equal(
    makeDefaultOutputPath("png", now, () => Buffer.from("a1b2c3d4", "hex")),
    ".claude/generated-images/gpt-image-2/20260817-153012-a1b2c3d4.png",
  );
  assert.equal(
    makeDefaultOutputPath("jpeg", now, () => Buffer.from("00112233", "hex")),
    ".claude/generated-images/gpt-image-2/20260817-153012-00112233.jpeg",
  );
  assert.notEqual(
    makeDefaultOutputPath("webp", now, () => Buffer.from("11111111", "hex")),
    makeDefaultOutputPath("webp", now, () => Buffer.from("22222222", "hex")),
  );
});

test("publishOutput rejects a filename extension that disagrees with the format", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/wrong.jpeg");
    await assert.rejects(
      () =>
        publishOutput({
          output,
          base64: makePng().toString("base64"),
          format: "png",
        }),
      hasCode("INVALID_INPUT"),
    );
    await assert.rejects(() => access(output.parentPath), { code: "ENOENT" });
  });
});

test("publishOutput supports a legal long leaf without lengthening its temporary name", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const filename = `${"a".repeat(222)}.png`;
    const output = await paths.resolveOutput(`outputs/${filename}`);
    const published = await publishOutput({
      output,
      base64: makePng().toString("base64"),
      format: "png",
    });

    assert.equal(published.filename, filename);
    assert.deepEqual(published.warnings, []);
    assert.deepEqual(await readdir(output.parentPath), [filename]);
  });
});

test("publishOutput publishes only a fully validated image", async () => {
  await withLifecycleFixture(async ({ root, paths }) => {
    const output = await paths.resolveOutput("outputs/final.png");
    const bytes = makePng({ width: 4, height: 3 });

    const published = await publishOutput({
      output,
      base64: bytes.toString("base64"),
      format: "png",
    });

    assert.deepEqual(published, {
      relativePath: "outputs/final.png",
      absolutePath: path.join(root, "outputs", "final.png"),
      filename: "final.png",
      info: {
        format: "png",
        mimeType: "image/png",
        width: 4,
        height: 3,
        hasAlpha: true,
      },
      sizeBytes: bytes.length,
      warnings: [],
    });
    assert.deepEqual(await readFile(output.absolutePath), bytes);
    assert.deepEqual(await readdir(output.parentPath), ["final.png"]);
  });
});

test("publishOutput rejects noncanonical Base64 before creating output files", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/base64.png");
    const base64 = `${makePng().toString("base64")}\n`;

    await assert.rejects(
      () => publishOutput({ output, base64, format: "png" }),
      hasCode("INVALID_PROVIDER_RESPONSE"),
    );
    await assert.rejects(() => access(output.absolutePath), { code: "ENOENT" });
    await assert.rejects(() => access(output.parentPath), { code: "ENOENT" });
  });
});

test("publishOutput removes temporary files when image validation fails", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const malformed = await paths.resolveOutput("outputs/malformed.png");
    await assert.rejects(
      () =>
        publishOutput({
          output: malformed,
          base64: Buffer.from("not an image").toString("base64"),
          format: "png",
        }),
      hasCode("INVALID_PROVIDER_RESPONSE"),
    );
    await assert.rejects(() => access(malformed.absolutePath), { code: "ENOENT" });
    assert.deepEqual(await readdir(malformed.parentPath), []);

    const mismatch = await paths.resolveOutput("outputs/mismatch.jpeg");
    await assert.rejects(
      () =>
        publishOutput({
          output: mismatch,
          base64: makePng().toString("base64"),
          format: "jpeg",
        }),
      hasCode("INVALID_PROVIDER_RESPONSE"),
    );
    await assert.rejects(() => access(mismatch.absolutePath), { code: "ENOENT" });
    assert.deepEqual(await readdir(mismatch.parentPath), []);
  });
});

test("publishOutput never overwrites a destination created after path resolution", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/existing.png");
    await mkdir(output.parentPath, { recursive: true });
    const existing = Buffer.from("existing destination");
    await writeFile(output.absolutePath, existing);

    await assert.rejects(
      () =>
        publishOutput({
          output,
          base64: makePng().toString("base64"),
          format: "png",
        }),
      hasCode("OUTPUT_EXISTS"),
    );
    assert.deepEqual(await readFile(output.absolutePath), existing);
    assert.deepEqual(await readdir(output.parentPath), ["existing.png"]);
  });
});

test("concurrent publication race has exactly one winner and no residue", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/race.png");
    const candidates = Array.from({ length: 16 }, (_, index) =>
      makePng({ width: index + 1, height: 1 }),
    );
    const attempts = await Promise.allSettled(
      candidates.map((bytes) =>
        publishOutput({
          output,
          base64: bytes.toString("base64"),
          format: "png",
        }),
      ),
    );

    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof publishOutput>>> =>
        result.status === "fulfilled",
    );
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 15);
    assert.equal(losers.every(({ reason }) => hasCode("OUTPUT_EXISTS")(reason)), true);

    const finalBytes = await readFile(output.absolutePath);
    const finalInfo = await inspectImage(finalBytes, "png");
    assert.equal(finalInfo.width, winners[0]!.value.info.width);
    assert.deepEqual(finalBytes, candidates[finalInfo.width - 1]);
    assert.deepEqual(await readdir(output.parentPath), ["race.png"]);
  });
});

test("publishOutput rejects a swapped ancestor without creating outside directories", async (t) => {
  await withLifecycleFixture(async ({ root, paths }) => {
    const swapped = path.join(root, "swapped");
    await mkdir(swapped);
    const output = await paths.resolveOutput("swapped/nested/result.png");
    const outside = await mkdtemp(path.join(tmpdir(), "gpt-image-publish-outside-"));
    const movedInside = path.join(root, "swapped-original");
    try {
      await rename(swapped, movedInside);
      try {
        await symlink(
          outside,
          swapped,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        await rename(movedInside, swapped);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
          t.skip(`directory links unavailable: ${code}`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        () =>
          publishOutput({
            output,
            base64: makePng().toString("base64"),
            format: "png",
          }),
        hasCode("PATH_OUTSIDE_WORKSPACE"),
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("post-commit temp cleanup retries without turning publication into failure", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/cleanup.png");
    let cleanupAttempts = 0;
    const publisher = createOutputPublisher({
      async removeTemporary(tempPath) {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw Object.assign(new Error("simulated sharing violation"), {
            code: "EPERM",
          });
        }
        await rm(tempPath, { force: true });
      },
    });

    const published = await publisher({
      output,
      base64: makePng().toString("base64"),
      format: "png",
    });

    assert.equal(published.relativePath, "outputs/cleanup.png");
    assert.equal(cleanupAttempts, 2);
    assert.deepEqual(await readdir(output.parentPath), ["cleanup.png"]);
  });
});

test("post-commit cleanup exhaustion warns and queues deferred cleanup", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/cleanup-exhausted.png");
    let cleanupAttempts = 0;
    let deferredCleanup: (() => Promise<void>) | undefined;
    const publisher = createOutputPublisher({
      async removeTemporary() {
        cleanupAttempts += 1;
        throw Object.assign(new Error("simulated persistent sharing violation"), {
          code: "EPERM",
        });
      },
      deferCleanup(task) {
        deferredCleanup = task;
      },
    });

    const published = await publisher({
      output,
      base64: makePng().toString("base64"),
      format: "png",
    });

    assert.equal(published.relativePath, "outputs/cleanup-exhausted.png");
    assert.deepEqual(published.warnings, ["TEMP_CLEANUP_PENDING"]);
    assert.equal(cleanupAttempts, 3);
    assert.equal(typeof deferredCleanup, "function");
    assert.deepEqual(await inspectImage(await readFile(output.absolutePath)), published.info);
    const entries = await readdir(output.parentPath);
    assert.equal(entries.includes("cleanup-exhausted.png"), true);
    assert.equal(entries.some((entry) => entry.startsWith(".gpt-image-")), true);
  });
});

test("pre-commit cleanup exhaustion reports a sanitized failure", async () => {
  await withLifecycleFixture(async ({ root, paths }) => {
    const output = await paths.resolveOutput("outputs/cleanup-failure.png");
    let cleanupAttempts = 0;
    const publisher = createOutputPublisher({
      async createPublicationLink() {
        throw Object.assign(new Error("simulated publication failure"), {
          code: "EPERM",
        });
      },
      async removeTemporary() {
        cleanupAttempts += 1;
        throw Object.assign(new Error("simulated persistent cleanup failure"), {
          code: "EPERM",
        });
      },
    });

    const failure = await captureRejection(() =>
      publisher({
        output,
        base64: makePng().toString("base64"),
        format: "png",
      }),
    );

    assert.equal(hasCode("INTERNAL_ERROR")(failure), true);
    assert.match(String(failure), /could not be removed safely/);
    assert.equal(String(failure).includes(root), false);
    assert.equal(cleanupAttempts, 3);
    await assert.rejects(() => access(output.absolutePath), { code: "ENOENT" });
  });
});

test("temporary write or flush failure removes the temporary file", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/write-failure.png");
    const publisher = createOutputPublisher({
      async writeAndFlushTemporary() {
        throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
      },
    });

    await assert.rejects(
      () =>
        publisher({
          output,
          base64: makePng().toString("base64"),
          format: "png",
        }),
      hasCode("INTERNAL_ERROR"),
    );
    await assert.rejects(() => access(output.absolutePath), { code: "ENOENT" });
    assert.deepEqual(await readdir(output.parentPath), []);
  });
});

test("hard-link publication failure removes the temporary file", async () => {
  await withLifecycleFixture(async ({ paths }) => {
    const output = await paths.resolveOutput("outputs/link-failure.png");
    const publisher = createOutputPublisher({
      async createPublicationLink() {
        throw Object.assign(new Error("simulated link failure"), { code: "EPERM" });
      },
    });

    await assert.rejects(
      () =>
        publisher({
          output,
          base64: makePng().toString("base64"),
          format: "png",
        }),
      hasCode("INTERNAL_ERROR"),
    );
    await assert.rejects(() => access(output.absolutePath), { code: "ENOENT" });
    assert.deepEqual(await readdir(output.parentPath), []);
  });
});
