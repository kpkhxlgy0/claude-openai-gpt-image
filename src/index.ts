import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvironment } from "./config/environment.ts";
import { processPaidCallGate } from "./concurrency.ts";
import { toErrorResult } from "./errors.ts";
import { WorkspaceRootRegistry } from "./files/workspace-roots.ts";
import { createSafeLogger } from "./logger.ts";
import { OpenAIImageClient } from "./openai/openai-image-client.ts";
import { createImageServer } from "./server.ts";
import type { ToolContext } from "./tools/types.ts";

const SERVER_VERSION = "0.1.0";
const logger = createSafeLogger();

async function main(): Promise<void> {
  const config = loadEnvironment(process.env);
  const roots = new WorkspaceRootRegistry();
  let environmentRoot: string | undefined;
  if (config.workspaceRoot !== undefined) {
    try {
      await roots.replace([config.workspaceRoot]);
      environmentRoot = roots.list()[0]?.canonicalPath;
    } catch (error) {
      logger.log("server_error", {
        phase: "startup",
        code: toErrorResult(error).code,
      });
    }
  }

  const provider =
    config.apiKeyConfigured && config.apiKey !== undefined
      ? new OpenAIImageClient({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        })
      : undefined;
  const context: ToolContext = {
    config,
    roots,
    ...(provider === undefined ? {} : { provider }),
    paidCallGate: processPaidCallGate,
    serverVersion: SERVER_VERSION,
  };
  const server = createImageServer({
    context,
    logger,
    ...(environmentRoot === undefined ? {} : { environmentRoot }),
  });
  const transport = new StdioServerTransport();

  let shutdownPromise: Promise<void> | undefined;
  const removeProcessListeners = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onStdinEnd);
  };
  const shutdown = (exitCode: number): Promise<void> => {
    if (exitCode !== 0 || process.exitCode === undefined) {
      process.exitCode = exitCode;
    }
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      try {
        await server.close();
      } catch (error) {
        logger.log("server_error", {
          phase: "shutdown",
          code: toErrorResult(error).code,
        });
      } finally {
        removeProcessListeners();
      }
    })();
    return shutdownPromise;
  };
  function onSignal(): void {
    void shutdown(0);
  }
  function onStdinEnd(): void {
    void shutdown(0);
  }

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onStdinEnd);
  transport.onerror = () => {
    logger.log("server_error", {
      phase: "transport",
      code: "INTERNAL_ERROR",
    });
    void shutdown(1);
  };
  transport.onclose = () => {
    removeProcessListeners();
    logger.log("server_close", { phase: "shutdown" });
  };

  try {
    await server.connect(transport);
    logger.log("server_ready", {
      phase: "initialization",
      rootCount: roots.list().length,
      toolCount: 3,
    });
  } catch (error) {
    logger.log("server_error", {
      phase: "startup",
      code: toErrorResult(error).code,
    });
    await shutdown(1);
  }
}

void main().catch((error: unknown) => {
  logger.log("server_error", {
    phase: "startup",
    code: toErrorResult(error).code,
  });
  process.exitCode = 1;
});
