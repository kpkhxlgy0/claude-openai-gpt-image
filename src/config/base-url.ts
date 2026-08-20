import { AppError } from "../errors.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validateOpenAIBaseUrl(value?: string): string {
  if (value === undefined || value === "") {
    return DEFAULT_OPENAI_BASE_URL;
  }

  if (typeof value !== "string") {
    throw new AppError("CONFIG_INVALID", "Base URL must be a string");
  }

  if (value.trim() !== value) {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must not include leading or trailing whitespace",
    );
  }

  if (hasControlCharacters(value)) {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must not include control characters",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("CONFIG_INVALID", "Base URL is not a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must use http or https",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must not include username or password",
    );
  }

  if (parsed.search !== "") {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must not include a query string",
    );
  }

  if (parsed.hash !== "") {
    throw new AppError(
      "CONFIG_INVALID",
      "Base URL must not include a fragment",
    );
  }

  if (!parsed.hostname) {
    throw new AppError("CONFIG_INVALID", "Base URL must include a valid host");
  }

  const pathname =
    parsed.pathname === "/"
      ? ""
      : parsed.pathname.replace(/\/+$/, "");

  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}${pathname}`;
}
