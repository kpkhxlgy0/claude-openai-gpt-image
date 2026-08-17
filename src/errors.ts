export type ErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "INVALID_INPUT"
  | "WORKSPACE_ROOT_REQUIRED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "INPUT_FILE_INVALID"
  | "OUTPUT_EXISTS"
  | "AUTHENTICATION_FAILED"
  | "MODERATION_BLOCKED"
  | "RATE_LIMITED"
  | "PROVIDER_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AppError";
  }
}

export interface ErrorResult {
  isError: true;
  code: ErrorCode;
  message: string;
}

export function toErrorResult(error: unknown): ErrorResult {
  if (error instanceof AppError) {
    return {
      isError: true,
      code: error.code,
      message: error.message,
    };
  }

  return {
    isError: true,
    code: "INTERNAL_ERROR",
    message: "INTERNAL_ERROR: An unexpected error occurred",
  };
}
