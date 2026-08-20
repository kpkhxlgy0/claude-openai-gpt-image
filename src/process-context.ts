import type { RuntimeConfig } from "./config/environment.ts";
import { processPaidCallGate } from "./concurrency.ts";
import type { WorkspaceRootRegistry } from "./files/workspace-roots.ts";
import type { ImageProvider } from "./openai/types.ts";
import type { ToolContext } from "./tools/types.ts";

export interface ProcessToolContextOptions {
  readonly config: RuntimeConfig;
  readonly roots: WorkspaceRootRegistry;
  readonly provider?: ImageProvider;
  readonly serverVersion: string;
}

export function createProcessToolContext(
  options: ProcessToolContextOptions,
): ToolContext {
  return {
    config: options.config,
    roots: options.roots,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    paidCallGate: processPaidCallGate,
    serverVersion: options.serverVersion,
  };
}
