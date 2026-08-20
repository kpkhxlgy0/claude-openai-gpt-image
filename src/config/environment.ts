import {
  DEFAULT_OPENAI_BASE_URL,
  validateOpenAIBaseUrl,
} from "./base-url.ts";

export interface RuntimeConfig {
  apiKeyConfigured: boolean;
  apiKey?: string;
  baseUrl: string;
  baseUrlConfigured: boolean;
  workspaceRoot?: string;
  pluginDataRoot?: string;
}

function readOptionalPath(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() === "" ? undefined : value;
}

export function loadEnvironment(env: NodeJS.ProcessEnv): RuntimeConfig {
  const rawKey = env.OPENAI_API_KEY;
  const apiKeyConfigured =
    typeof rawKey === "string" && rawKey.trim() !== "";

  const rawBaseUrl = env.OPENAI_BASE_URL;
  const baseUrlProvided =
    typeof rawBaseUrl === "string" && rawBaseUrl !== "";
  const baseUrl = validateOpenAIBaseUrl(
    baseUrlProvided ? rawBaseUrl : undefined,
  );
  const baseUrlConfigured =
    baseUrlProvided && baseUrl !== DEFAULT_OPENAI_BASE_URL;

  const config: RuntimeConfig = {
    apiKeyConfigured,
    baseUrl,
    baseUrlConfigured,
  };

  if (apiKeyConfigured && typeof rawKey === "string") {
    config.apiKey = rawKey;
  }

  const workspaceRoot = readOptionalPath(env, "GPT_IMAGE_WORKSPACE_ROOT");
  if (workspaceRoot !== undefined) {
    config.workspaceRoot = workspaceRoot;
  }

  const pluginDataRoot = readOptionalPath(env, "GPT_IMAGE_PLUGIN_DATA");
  if (pluginDataRoot !== undefined) {
    config.pluginDataRoot = pluginDataRoot;
  }

  return config;
}
