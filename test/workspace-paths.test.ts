import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { WorkspacePaths } from "../src/files/workspace-paths.ts";
import { WorkspaceRootRegistry } from "../src/files/workspace-roots.ts";
import { assertPortableRelativePath } from "../src/files/windows-paths.ts";

async function withTempRoots(
  count: number,
  fn: (roots: string[], registry: WorkspaceRootRegistry, paths: WorkspacePaths) => Promise<void>,
): Promise<void> {
  const created: string[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      created.push(await mkdtemp(path.join(tmpdir(), `gpt-image-ws-${i}-`)));
    }
    const registry = new WorkspaceRootRegistry();
    await registry.replace(created);
    const paths = new WorkspacePaths(registry);
    await fn(created, registry, paths);
  } finally {
    await Promise.all(
      created.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
    );
  }
}

test("assertPortableRelativePath accepts ordinary relative image paths", () => {
  assert.equal(assertPortableRelativePath("images/out.png"), undefined);
  assert.equal(assertPortableRelativePath(".claude/generated-images/gpt-image-2/a.png"), undefined);
  assert.equal(assertPortableRelativePath("folder/sub/file.webp"), undefined);
});

test("assertPortableRelativePath rejects traversal and mixed-separator escapes", () => {
  for (const value of [
    "../escape.png",
    "..\\escape.png",
    "images/../../escape.png",
    "images/..\\..\\escape.png",
    "images\\..\\..\\escape.png",
    "./../escape.png",
    "foo/./../../bar.png",
  ]) {
    assert.throws(
      () => assertPortableRelativePath(value),
      (error: unknown) =>
        error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
      value,
    );
  }
});

test("assertPortableRelativePath rejects Windows absolute, UNC, device, ADS, reserved, and NUL paths", () => {
  for (const value of [
    "C:\\absolute.png",
    "C:/absolute.png",
    "c:\\absolute.png",
    "C:relative.png",
    "D:foo\\bar.png",
    "\\\\server\\share\\image.png",
    "//server/share/image.png",
    "\\\\?\\C:\\image.png",
    "\\\\.\\device",
    "\\\\.\\PIPE\\name",
    "image.png:stream",
    "folder/file.png:zone.identifier",
    "CON",
    "con",
    "NUL.png",
    "nul.PNG",
    "COM1.jpg",
    "com9.webp",
    "LPT1.gif",
    "lpt9.jpeg",
    "PRN.txt",
    "AUX",
    "folder/CON/out.png",
    "folder/nul.png",
    "good\0bad.png",
    "\0",
    "",
    "   ",
    "/absolute/posix.png",
    "\\absolute\\root.png",
  ]) {
    assert.throws(
      () => assertPortableRelativePath(value),
      (error: unknown) =>
        error instanceof AppError &&
        (error.code === "PATH_OUTSIDE_WORKSPACE" || error.code === "INVALID_INPUT"),
      value,
    );
  }
});

test("WorkspaceRootRegistry realpaths, deduplicates case-insensitively, and never grants via select", async () => {
  await withTempRoots(1, async (roots, registry) => {
    const root = roots[0]!;
    const viaAlias = path.join(root, ".");
    await registry.replace([root, viaAlias, root.toUpperCase()]);
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(path.resolve(listed[0]!.canonicalPath), path.resolve(root));

    const selected = registry.select();
    assert.equal(selected.canonicalPath, listed[0]!.canonicalPath);

    assert.throws(
      () => registry.select(path.join(path.dirname(root), "not-approved")),
      (error: unknown) =>
        error instanceof AppError &&
        (error.code === "PATH_OUTSIDE_WORKSPACE" ||
          error.code === "WORKSPACE_ROOT_REQUIRED"),
    );
  });
});

test("WorkspaceRootRegistry requires an explicit approved root when multiple roots exist", async () => {
  await withTempRoots(2, async (roots, registry) => {
    assert.throws(
      () => registry.select(),
      (error: unknown) =>
        error instanceof AppError && error.code === "WORKSPACE_ROOT_REQUIRED",
    );

    const chosen = registry.select(roots[1]);
    assert.equal(path.resolve(chosen.canonicalPath), path.resolve(roots[1]!));
  });
});

test("WorkspaceRootRegistry rejects non-directories and missing paths", async () => {
  const registry = new WorkspaceRootRegistry();
  const base = await mkdtemp(path.join(tmpdir(), "gpt-image-file-"));
  try {
    const filePath = path.join(base, "not-a-dir.txt");
    await writeFile(filePath, "x");
    await assert.rejects(
      () => registry.replace([filePath]),
      (error: unknown) =>
        error instanceof AppError &&
        (error.code === "CONFIG_INVALID" ||
          error.code === "WORKSPACE_ROOT_REQUIRED" ||
          error.code === "INVALID_INPUT"),
    );
    await assert.rejects(
      () => registry.replace([path.join(base, "missing-dir")]),
      (error: unknown) => error instanceof AppError,
    );
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("resolveInput accepts relative and contained absolute paths", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    await mkdir(path.join(root, "images"), { recursive: true });
    await writeFile(path.join(root, "images", "in.png"), "png");

    const relative = await paths.resolveInput("images/in.png");
    assert.equal(relative.relativePath.replaceAll("\\", "/"), "images/in.png");
    assert.equal(
      path.resolve(relative.absolutePath),
      path.resolve(root, "images", "in.png"),
    );
    assert.equal(path.resolve(relative.root.canonicalPath), path.resolve(root));

    const absolute = await paths.resolveInput(path.join(root, "images", "in.png"));
    assert.equal(absolute.relativePath.replaceAll("\\", "/"), "images/in.png");
    assert.equal(
      path.resolve(absolute.absolutePath),
      path.resolve(root, "images", "in.png"),
    );
  });
});

test("resolveInput rejects traversal, mixed separators, and absolute escapes", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    for (const value of [
      "../escape.png",
      "images/..\\..\\escape.png",
      path.join(path.dirname(root), "escape.png"),
      path.join(root, "..", "escape.png"),
    ]) {
      await assert.rejects(
        () => paths.resolveInput(value),
        (error: unknown) =>
          error instanceof AppError &&
          (error.code === "PATH_OUTSIDE_WORKSPACE" ||
            error.code === "INVALID_INPUT"),
        value,
      );
    }
  });
});

test("resolveInput rejects sibling prefix collisions", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "gpt-image-prefix-"));
  const root = path.join(parent, "root");
  const evil = path.join(parent, "root-evil");
  try {
    await mkdir(root);
    await mkdir(evil);
    await writeFile(path.join(evil, "secret.png"), "nope");

    const registry = new WorkspaceRootRegistry();
    await registry.replace([root]);
    const paths = new WorkspacePaths(registry);

    await assert.rejects(
      () => paths.resolveInput(path.join(evil, "secret.png")),
      (error: unknown) =>
        error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
    await assert.rejects(
      () => paths.resolveInput(path.join(parent, "root-evil", "secret.png")),
      (error: unknown) =>
        error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("resolveOutput accepts relative paths only and rejects absolute outputs", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    const resolved = await paths.resolveOutput(
      ".claude/generated-images/gpt-image-2/out.png",
    );
    assert.equal(
      resolved.relativePath.replaceAll("\\", "/"),
      ".claude/generated-images/gpt-image-2/out.png",
    );
    assert.equal(
      path.resolve(resolved.absolutePath),
      path.resolve(root, ".claude/generated-images/gpt-image-2/out.png"),
    );
    assert.equal(
      path.resolve(resolved.parentPath),
      path.resolve(root, ".claude/generated-images/gpt-image-2"),
    );

    await assert.rejects(
      () => paths.resolveOutput(path.join(root, "out.png")),
      (error: unknown) =>
        error instanceof AppError &&
        (error.code === "PATH_OUTSIDE_WORKSPACE" ||
          error.code === "INVALID_INPUT"),
    );
    await assert.rejects(
      () => paths.resolveOutput("C:\\absolute.png"),
      (error: unknown) => error instanceof AppError,
    );
  });
});

test("resolveOutput rejects existing leaves", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    await mkdir(path.join(root, "out"), { recursive: true });
    await writeFile(path.join(root, "out", "exists.png"), "x");

    await assert.rejects(
      () => paths.resolveOutput("out/exists.png"),
      (error: unknown) =>
        error instanceof AppError && error.code === "OUTPUT_EXISTS",
    );
  });
});

test("resolveOutput rejects symlink leaves without following them", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    const outside = await mkdtemp(path.join(tmpdir(), "gpt-image-outside-"));
    try {
      const target = path.join(outside, "target.png");
      await writeFile(target, "secret");
      const leaf = path.join(root, "link-out.png");
      try {
        await symlink(target, leaf);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "EACCES") {
          // Keep lexical tests active; only skip when the OS refuses link creation.
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => paths.resolveOutput("link-out.png"),
        (error: unknown) =>
          error instanceof AppError &&
          (error.code === "OUTPUT_EXISTS" ||
            error.code === "PATH_OUTSIDE_WORKSPACE"),
      );
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("resolveInput rejects symlink directory escapes", async () => {
  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    const outside = await mkdtemp(path.join(tmpdir(), "gpt-image-sym-out-"));
    try {
      await writeFile(path.join(outside, "secret.png"), "secret");
      const linkDir = path.join(root, "escape-link");
      try {
        await symlink(outside, linkDir, "dir");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "EACCES") {
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => paths.resolveInput("escape-link/secret.png"),
        (error: unknown) =>
          error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
      );
      await assert.rejects(
        () => paths.resolveInput(path.join(linkDir, "secret.png")),
        (error: unknown) =>
          error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
      );
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("resolveInput rejects Junction directory escapes on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  await withTempRoots(1, async (roots, _registry, paths) => {
    const root = roots[0]!;
    const outside = await mkdtemp(path.join(tmpdir(), "gpt-image-junc-out-"));
    try {
      await writeFile(path.join(outside, "secret.png"), "secret");
      const junction = path.join(root, "escape-junc");
      try {
        await symlink(outside, junction, "junction");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "EACCES") {
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => paths.resolveInput("escape-junc/secret.png"),
        (error: unknown) =>
          error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
      );
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("multiple-root absolute input is unambiguous only when contained by one root", async () => {
  await withTempRoots(2, async (roots, _registry, paths) => {
    const a = roots[0]!;
    const b = roots[1]!;
    await writeFile(path.join(a, "a.png"), "a");
    await writeFile(path.join(b, "b.png"), "b");

    await assert.rejects(
      () => paths.resolveInput("a.png"),
      (error: unknown) =>
        error instanceof AppError && error.code === "WORKSPACE_ROOT_REQUIRED",
    );

    const fromA = await paths.resolveInput(path.join(a, "a.png"));
    assert.equal(path.resolve(fromA.root.canonicalPath), path.resolve(a));
    assert.equal(fromA.relativePath.replaceAll("\\", "/"), "a.png");

    const selected = await paths.resolveInput("b.png", b);
    assert.equal(path.resolve(selected.root.canonicalPath), path.resolve(b));
    assert.equal(selected.relativePath.replaceAll("\\", "/"), "b.png");

    await assert.rejects(
      () => paths.resolveInput(path.join(a, "a.png"), b),
      (error: unknown) =>
        error instanceof AppError && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
  });
});

test("empty registry requires a workspace root", async () => {
  const registry = new WorkspaceRootRegistry();
  const paths = new WorkspacePaths(registry);
  assert.throws(
    () => registry.select(),
    (error: unknown) =>
      error instanceof AppError && error.code === "WORKSPACE_ROOT_REQUIRED",
  );
  await assert.rejects(
    () => paths.resolveInput("x.png"),
    (error: unknown) =>
      error instanceof AppError && error.code === "WORKSPACE_ROOT_REQUIRED",
  );
  await assert.rejects(
    () => paths.resolveOutput("x.png"),
    (error: unknown) =>
      error instanceof AppError && error.code === "WORKSPACE_ROOT_REQUIRED",
  );
});

test("portable Windows lexical rejection works independently of process.platform", () => {
  // These must fail even if the host is not Windows.
  assert.throws(() => assertPortableRelativePath("C:relative.png"), AppError);
  assert.throws(() => assertPortableRelativePath("\\\\server\\share\\a.png"), AppError);
  assert.throws(() => assertPortableRelativePath("image.png:ads"), AppError);
  assert.throws(() => assertPortableRelativePath("COM1.jpg"), AppError);
  assert.throws(() => assertPortableRelativePath("images/..\\..\\x.png"), AppError);
});
