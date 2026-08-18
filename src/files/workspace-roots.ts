import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.ts";

export interface WorkspaceRoot {
  displayPath: string;
  canonicalPath: string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function normalizeKey(value: string): string {
  const resolved = path.resolve(value);
  return isWindows() ? resolved.toLowerCase() : resolved;
}

export function isSamePath(a: string, b: string): boolean {
  return normalizeKey(a) === normalizeKey(b);
}

export class WorkspaceRootRegistry {
  #roots: WorkspaceRoot[] = [];

  async replace(paths: readonly string[]): Promise<void> {
    const next: WorkspaceRoot[] = [];
    const seen = new Set<string>();

    for (const raw of paths) {
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new AppError("INVALID_INPUT", "Workspace root must be a non-empty path");
      }

      let stats;
      try {
        stats = await stat(raw);
      } catch {
        throw new AppError(
          "CONFIG_INVALID",
          "Workspace root must be an existing local directory",
        );
      }
      if (!stats.isDirectory()) {
        throw new AppError(
          "CONFIG_INVALID",
          "Workspace root must be an existing local directory",
        );
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(raw);
      } catch {
        throw new AppError(
          "CONFIG_INVALID",
          "Workspace root must be an existing local directory",
        );
      }

      const key = normalizeKey(canonicalPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      next.push({
        displayPath: raw,
        canonicalPath,
      });
    }

    this.#roots = next;
  }

  list(): readonly WorkspaceRoot[] {
    return this.#roots.slice();
  }

  select(requested?: string): WorkspaceRoot {
    if (this.#roots.length === 0) {
      throw new AppError(
        "WORKSPACE_ROOT_REQUIRED",
        "No approved workspace root is configured",
      );
    }

    if (requested === undefined || requested.trim() === "") {
      if (this.#roots.length === 1) {
        return this.#roots[0]!;
      }
      throw new AppError(
        "WORKSPACE_ROOT_REQUIRED",
        "Multiple workspace roots require an explicit approved selector",
      );
    }

    // Selector never grants a new root — only matches already-approved ones.
    const match = this.#roots.find(
      (root) =>
        isSamePath(root.canonicalPath, requested) ||
        isSamePath(root.displayPath, requested),
    );
    if (!match) {
      // Attempt realpath match for aliases of approved roots only.
      // Do not add new roots from the selector.
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Requested workspace root is not an approved root",
      );
    }
    return match;
  }

  /**
   * Find the unique approved root that contains the given canonical absolute path.
   * Returns undefined when no root contains it, or when multiple roots would match.
   */
  findContainingRoot(absoluteCanonicalPath: string): WorkspaceRoot | undefined {
    const matches = this.#roots.filter((root) =>
      isPathInsideRoot(root.canonicalPath, absoluteCanonicalPath),
    );
    if (matches.length === 1) {
      return matches[0];
    }
    return undefined;
  }
}

export function isPathInsideRoot(rootCanonical: string, candidateCanonical: string): boolean {
  const root = path.resolve(rootCanonical);
  const candidate = path.resolve(candidateCanonical);
  if (isSamePath(root, candidate)) {
    return true;
  }
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return true;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  // Guard sibling prefix collisions: root vs root-evil.
  // path.relative already handles this when both are resolved, but double-check
  // that the candidate is under root + separator when not equal.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const candidateKey = isWindows() ? candidate.toLowerCase() : candidate;
  const rootKey = isWindows() ? rootWithSep.toLowerCase() : rootWithSep;
  return candidateKey.startsWith(rootKey) || isSamePath(root, candidate);
}
