import { AppError, type ErrorCode } from "../errors.ts";

const MAX_SAFE_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODERATION_CODE = /content[_-]?policy|content[_-]?filter|moderation|safety/i;

type UnknownRecord = Readonly<Record<string, unknown>>;

export function asUnknownRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function readStatus(error: unknown): number | undefined {
  const status = asUnknownRecord(error)?.status;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

function readCodeOrType(record: UnknownRecord | undefined): string | undefined {
  if (typeof record?.code === "string") {
    return record.code;
  }
  return typeof record?.type === "string" ? record.type : undefined;
}

function readProviderCode(error: unknown): string | undefined {
  const record = asUnknownRecord(error);
  return (
    readCodeOrType(record) ?? readCodeOrType(asUnknownRecord(record?.error))
  );
}

function readRequestId(error: unknown): string | undefined {
  const record = asUnknownRecord(error);
  return sanitizeRequestId(record?.requestID ?? record?.request_id);
}

function errorMessage(code: ErrorCode, requestId: string | undefined): string {
  let message: string;
  switch (code) {
    case "AUTHENTICATION_FAILED":
      message = "Authentication with the image provider failed";
      break;
    case "MODERATION_BLOCKED":
      message = "The image request was blocked by provider safety controls";
      break;
    case "RATE_LIMITED":
      message = "The image provider rate limit was reached";
      break;
    default:
      message = "The image provider request failed";
  }
  return withSafeRequestId(message, requestId);
}

export function sanitizeRequestId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_REQUEST_ID_LENGTH ||
    !SAFE_REQUEST_ID.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function withSafeRequestId(message: string, value: unknown): string {
  const requestId = sanitizeRequestId(value);
  return requestId === undefined
    ? message
    : `${message} (request ID: ${requestId})`;
}

export function mapOpenAIError(error: unknown): AppError {
  const status = readStatus(error);
  const providerCode = readProviderCode(error);
  const requestId = readRequestId(error);

  let code: ErrorCode;
  if (providerCode !== undefined && MODERATION_CODE.test(providerCode)) {
    code = "MODERATION_BLOCKED";
  } else if (status === 401 || status === 403) {
    code = "AUTHENTICATION_FAILED";
  } else if (status === 429) {
    code = "RATE_LIMITED";
  } else {
    code = "PROVIDER_FAILURE";
  }

  return new AppError(code, errorMessage(code, requestId));
}
