import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.ts";

export interface WorkspaceRoot {
  displayPath: string;
  canonicalPath: string;
}

export type PathDialect = Pick<typeof path.win32, "resolve" | "sep">;

export interface CanonicalPathOps {
  normalize(value: string): string;
  isSame(a: string, b: string): boolean;
  contains(rootCanonical: string, candidateCanonical: string): boolean;
}

export interface WorkspaceRootSelectionPolicy {
  pathOperations: CanonicalPathOps;
  caseInsensitiveFallback: boolean;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export function createCanonicalPathOps(pathDialect: PathDialect): CanonicalPathOps {
  const normalize = (value: string): string => pathDialect.resolve(value);
  return {
    normalize,
    isSame(a: string, b: string): boolean {
      return normalize(a) === normalize(b);
    },
    contains(rootCanonical: string, candidateCanonical: string): boolean {
      const root = normalize(rootCanonical);
      const candidate = normalize(candidateCanonical);
      if (root === candidate) {
        return true;
      }
      const rootWithSeparator = root.endsWith(pathDialect.sep)
        ? root
        : root + pathDialect.sep;
      return candidate.startsWith(rootWithSeparator);
    },
  };
}

const HOST_PATH_OPERATIONS = createCanonicalPathOps(path);
const HOST_SELECTION_POLICY: WorkspaceRootSelectionPolicy = {
  pathOperations: HOST_PATH_OPERATIONS,
  caseInsensitiveFallback: isWindows(),
};

export function isSamePath(a: string, b: string): boolean {
  return HOST_PATH_OPERATIONS.isSame(a, b);
}

export function isPathInsideRoot(
  rootCanonical: string,
  candidateCanonical: string,
): boolean {
  return HOST_PATH_OPERATIONS.contains(rootCanonical, candidateCanonical);
}

export function deduplicateCanonicalRoots(
  roots: readonly WorkspaceRoot[],
  pathOperations: CanonicalPathOps = HOST_PATH_OPERATIONS,
): WorkspaceRoot[] {
  const seen = new Set<string>();
  const unique: WorkspaceRoot[] = [];
  for (const root of roots) {
    const key = pathOperations.normalize(root.canonicalPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(root);
  }
  return unique;
}

function requireUniqueMatch(matches: readonly WorkspaceRoot[]): WorkspaceRoot | undefined {
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new AppError(
      "WORKSPACE_ROOT_REQUIRED",
      "Workspace root selector matches multiple approved roots",
    );
  }
  return undefined;
}

export function selectApprovedWorkspaceRoot(
  roots: readonly WorkspaceRoot[],
  requested: string,
  policy: WorkspaceRootSelectionPolicy = HOST_SELECTION_POLICY,
): WorkspaceRoot {
  const { pathOperations } = policy;

  const exactCanonical = requireUniqueMatch(
    roots.filter((root) => pathOperations.isSame(root.canonicalPath, requested)),
  );
  if (exactCanonical) {
    return exactCanonical;
  }

  const exactDisplay = requireUniqueMatch(
    roots.filter((root) => pathOperations.isSame(root.displayPath, requested)),
  );
  if (exactDisplay) {
    return exactDisplay;
  }

  if (policy.caseInsensitiveFallback) {
    const requestedKey = pathOperations.normalize(requested).toLowerCase();
    const folded = requireUniqueMatch(
      roots.filter(
        (root) =>
          pathOperations.normalize(root.canonicalPath).toLowerCase() === requestedKey ||
          pathOperations.normalize(root.displayPath).toLowerCase() === requestedKey,
      ),
    );
    if (folded) {
      return folded;
    }
  }

  throw new AppError(
    "PATH_OUTSIDE_WORKSPACE",
    "Requested workspace root is not an approved root",
  );
}

export class WorkspaceRootRegistry {
  #roots: WorkspaceRoot[] = [];

  async replace(paths: readonly string[]): Promise<void> {
    const next: WorkspaceRoot[] = [];

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

      next.push({
        displayPath: raw,
        canonicalPath,
      });
    }

    this.#roots = deduplicateCanonicalRoots(next);
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

    return selectApprovedWorkspaceRoot(this.#roots, requested);
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
