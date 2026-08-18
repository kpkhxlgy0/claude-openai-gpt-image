import type { ErrorCode } from "./errors.ts";
import { sanitizeRequestId } from "./openai/map-error.ts";

export type SafeLogEvent =
  | "server_start"
  | "server_ready"
  | "server_error"
  | "server_close"
  | "tool_error"
  | "roots_sync"
  | "roots_unavailable";

export type SafeLogPhase =
  | "startup"
  | "initialization"
  | "tool"
  | "roots"
  | "transport"
  | "shutdown";

export interface SafeLogFields {
  readonly code?: ErrorCode;
  readonly phase?: SafeLogPhase;
  readonly requestId?: string;
  readonly rootCount?: number;
  readonly toolCount?: number;
}

export interface SafeLogger {
  log(event: SafeLogEvent, fields?: SafeLogFields): void;
}

export type SafeLogWriter = (line: string) => void;

const EVENTS = new Set<SafeLogEvent>([
  "server_start",
  "server_ready",
  "server_error",
  "server_close",
  "tool_error",
  "roots_sync",
  "roots_unavailable",
]);

const PHASES = new Set<SafeLogPhase>([
  "startup",
  "initialization",
  "tool",
  "roots",
  "transport",
  "shutdown",
]);

const ERROR_CODES = new Set<ErrorCode>([
  "CONFIG_MISSING",
  "CONFIG_INVALID",
  "INVALID_INPUT",
  "WORKSPACE_ROOT_REQUIRED",
  "PATH_OUTSIDE_WORKSPACE",
  "INPUT_FILE_INVALID",
  "OUTPUT_EXISTS",
  "AUTHENTICATION_FAILED",
  "MODERATION_BLOCKED",
  "RATE_LIMITED",
  "PROVIDER_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "INTERNAL_ERROR",
]);

function safeCount(value: number | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function writeStderr(line: string): void {
  process.stderr.write(line);
}

export function createSafeLogger(
  write: SafeLogWriter = writeStderr,
): SafeLogger {
  return Object.freeze({
    log(event: SafeLogEvent, fields: SafeLogFields = {}): void {
      if (!EVENTS.has(event)) {
        return;
      }

      const entry: Record<string, string | number> = { event };
      if (fields.code !== undefined && ERROR_CODES.has(fields.code)) {
        entry.code = fields.code;
      }
      if (fields.phase !== undefined && PHASES.has(fields.phase)) {
        entry.phase = fields.phase;
      }
      const requestId = sanitizeRequestId(fields.requestId);
      if (requestId !== undefined) {
        entry.request_id = requestId;
      }
      const rootCount = safeCount(fields.rootCount);
      if (rootCount !== undefined) {
        entry.root_count = rootCount;
      }
      const toolCount = safeCount(fields.toolCount);
      if (toolCount !== undefined) {
        entry.tool_count = toolCount;
      }

      try {
        write(`${JSON.stringify(entry)}\n`);
      } catch {
        // Logging must never interrupt protocol handling or shutdown.
      }
    },
  });
}
