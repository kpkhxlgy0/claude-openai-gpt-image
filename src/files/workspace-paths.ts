import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.ts";
import {
  assertPortableRelativePath,
  assertSafePathText,
  toPosixRelative,
} from "./windows-paths.ts";
import {
  isPathInsideRoot,
  type WorkspaceRoot,
  WorkspaceRootRegistry,
} from "./workspace-roots.ts";

export interface ResolvedInputPath {
  root: WorkspaceRoot;
  absolutePath: string;
  relativePath: string;
}

export interface ResolvedOutputPath extends ResolvedInputPath {
  parentPath: string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function looksAbsolute(value: string): boolean {
  if (path.isAbsolute(value)) {
    return true;
  }
  // Portable detection for Windows absolute forms when running elsewhere.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    return true;
  }
  return false;
}

async function deepestExistingAncestor(absolutePath: string): Promise<{
  existing: string;
  remainder: string[];
}> {
  const absolute = path.normalize(absolutePath);
  const parts = absolute.split(path.sep).filter((part, index) => {
    // Keep drive letter segment on Windows (e.g. "C:").
    if (isWindows() && index === 0 && /^[A-Za-z]:$/.test(part)) {
      return true;
    }
    return part.length > 0;
  });

  // Rebuild from root.
  let prefix: string;
  let startIndex: number;
  if (isWindows() && parts[0] && /^[A-Za-z]:$/.test(parts[0])) {
    prefix = parts[0] + path.sep;
    startIndex = 1;
  } else if (absolute.startsWith(path.sep)) {
    prefix = path.sep;
    startIndex = 0;
  } else {
    prefix = parts[0] ?? "";
    startIndex = 1;
  }

  let existing = prefix;
  let lastExisting = prefix;
  const remainder: string[] = [];

  // Probe from full path upward by walking segments forward.
  for (let i = startIndex; i < parts.length; i += 1) {
    const segment = parts[i]!;
    const next = path.join(existing, segment);
    try {
      await lstat(next);
      existing = next;
      lastExisting = next;
    } catch {
      remainder.push(...parts.slice(i));
      return { existing: lastExisting, remainder };
    }
  }

  return { existing: lastExisting, remainder: [] };
}

async function resolveContainedPath(
  root: WorkspaceRoot,
  candidateAbsolute: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const { existing, remainder } = await deepestExistingAncestor(candidateAbsolute);

  let existingCanonical: string;
  try {
    existingCanonical = await realpath(existing);
  } catch {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path could not be resolved inside the workspace root",
    );
  }

  // Reject if the deepest existing ancestor itself escapes (symlink/junction).
  if (!isPathInsideRoot(root.canonicalPath, existingCanonical)) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path escapes the approved workspace root",
    );
  }

  const absolutePath =
    remainder.length === 0
      ? existingCanonical
      : path.join(existingCanonical, ...remainder);

  // Final containment check on the reconstructed absolute path.
  if (!isPathInsideRoot(root.canonicalPath, absolutePath)) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path escapes the approved workspace root",
    );
  }

  const relative = path.relative(root.canonicalPath, absolutePath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes("\0")
  ) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path escapes the approved workspace root",
    );
  }

  return {
    absolutePath,
    relativePath: toPosixRelative(relative === "" ? "." : relative),
  };
}

export class WorkspacePaths {
  constructor(private readonly roots: WorkspaceRootRegistry) {}

  async resolveInput(
    userPath: string,
    workspaceRootSelector?: string,
  ): Promise<ResolvedInputPath> {
    if (typeof userPath !== "string" || userPath.trim() === "") {
      throw new AppError("INVALID_INPUT", "Input path must be a non-empty string");
    }
    assertSafePathText(userPath);

    if (looksAbsolute(userPath)) {
      return this.#resolveAbsoluteInput(userPath, workspaceRootSelector);
    }

    assertPortableRelativePath(userPath);
    const root = this.roots.select(workspaceRootSelector);
    const candidate = path.resolve(root.canonicalPath, userPath.replaceAll("\\", "/"));
    const resolved = await resolveContainedPath(root, candidate);
    // Relative inputs should not resolve to the root itself as a file path typically,
    // but empty relative after resolution is only "." which is not a useful image path.
    if (resolved.relativePath === "." || resolved.relativePath === "") {
      throw new AppError("INVALID_INPUT", "Input path must refer to a file under the root");
    }
    return {
      root,
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
    };
  }

  async resolveOutput(
    userPath: string,
    workspaceRootSelector?: string,
  ): Promise<ResolvedOutputPath> {
    if (typeof userPath !== "string" || userPath.trim() === "") {
      throw new AppError("INVALID_INPUT", "Output path must be a non-empty string");
    }
    assertSafePathText(userPath);
    if (looksAbsolute(userPath)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Output paths must be relative to an approved workspace root",
      );
    }

    assertPortableRelativePath(userPath);
    const root = this.roots.select(workspaceRootSelector);
    const candidate = path.resolve(root.canonicalPath, userPath.replaceAll("\\", "/"));
    const resolved = await resolveContainedPath(root, candidate);

    if (resolved.relativePath === "." || resolved.relativePath === "") {
      throw new AppError("INVALID_INPUT", "Output path must refer to a file under the root");
    }

    // Existing leaf rejection, including symlink leaves (do not follow).
    try {
      const leafStat = await lstat(resolved.absolutePath);
      if (leafStat.isSymbolicLink()) {
        throw new AppError(
          "PATH_OUTSIDE_WORKSPACE",
          "Output path must not be a symbolic link",
        );
      }
      // Any existing leaf is a conflict (file, dir, etc.).
      throw new AppError("OUTPUT_EXISTS", "Output path already exists");
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw new AppError(
          "PATH_OUTSIDE_WORKSPACE",
          "Output path could not be validated",
        );
      }
    }

    const parentPath = path.dirname(resolved.absolutePath);
    // Parent must remain contained after resolution.
    if (!isPathInsideRoot(root.canonicalPath, parentPath)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Output parent escapes the approved workspace root",
      );
    }

    return {
      root,
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      parentPath,
    };
  }

  async #resolveAbsoluteInput(
    userPath: string,
    workspaceRootSelector?: string,
  ): Promise<ResolvedInputPath> {
    // Absolute inputs must already be contained by an approved root.
    // Never treat absolute input as granting a root.
    if (userPath.includes("\0")) {
      throw new AppError("PATH_OUTSIDE_WORKSPACE", "Path must not contain NUL bytes");
    }

    // Reject clearly non-local forms before resolution.
    if (
      userPath.startsWith("\\\\") ||
      userPath.startsWith("//") ||
      /^[A-Za-z]:[^\\/]/.test(userPath) // drive-relative C:foo
    ) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }

    let candidateAbsolute: string;
    try {
      candidateAbsolute = path.resolve(userPath);
    } catch {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }

    if (workspaceRootSelector !== undefined && workspaceRootSelector.trim() !== "") {
      const root = this.roots.select(workspaceRootSelector);
      const resolved = await resolveContainedPath(root, candidateAbsolute);
      if (resolved.relativePath === "." || resolved.relativePath === "") {
        throw new AppError("INVALID_INPUT", "Input path must refer to a file under the root");
      }
      return {
        root,
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
      };
    }

    // Without an explicit selector, find the unique containing root after
    // resolving the deepest existing ancestor.
    const { existing, remainder } = await deepestExistingAncestor(candidateAbsolute);
    let existingCanonical: string;
    try {
      existingCanonical = await realpath(existing);
    } catch {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }

    const reconstructed =
      remainder.length === 0
        ? existingCanonical
        : path.join(existingCanonical, ...remainder);

    const listed = this.roots.list();
    if (listed.length === 0) {
      throw new AppError(
        "WORKSPACE_ROOT_REQUIRED",
        "No approved workspace root is configured",
      );
    }

    const matches = listed.filter((root) =>
      isPathInsideRoot(root.canonicalPath, reconstructed),
    );
    if (matches.length === 0) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }
    if (matches.length > 1) {
      throw new AppError(
        "WORKSPACE_ROOT_REQUIRED",
        "Absolute input matches multiple workspace roots",
      );
    }

    const root = matches[0]!;
    // Also ensure the existing ancestor itself is contained (symlink escape).
    if (!isPathInsideRoot(root.canonicalPath, existingCanonical)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }

    const relative = path.relative(root.canonicalPath, reconstructed);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Absolute input is outside approved workspace roots",
      );
    }

    return {
      root,
      absolutePath: reconstructed,
      relativePath: toPosixRelative(relative),
    };
  }
}
