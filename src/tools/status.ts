import type { ToolContext, StatusOutput } from "./types.ts";
import {
  DEFAULT_RELATIVE_OUTPUT_DIRECTORY,
  MODEL,
} from "./types.ts";

export function getStatus(context: ToolContext): StatusOutput {
  return {
    model: MODEL,
    api_key_configured: context.config.apiKeyConfigured,
    base_url_configured: context.config.baseUrlConfigured,
    base_url_valid: true,
    workspace_roots: context.roots
      .list()
      .map((root) => root.canonicalPath),
    default_relative_output_dir: DEFAULT_RELATIVE_OUTPUT_DIRECTORY,
    server_version: context.serverVersion,
  };
}
