export interface GitIndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
  readonly path: string;
}

export function parseGitIndexEntries(output: string): readonly GitIndexEntry[];
export function readGitIndexEntries(
  cwd: string,
  env?: NodeJS.ProcessEnv,
): readonly GitIndexEntry[];
export function readGitBlobText(
  cwd: string,
  objectId: string,
  env?: NodeJS.ProcessEnv,
): string;
