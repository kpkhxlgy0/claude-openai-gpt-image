import { open } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type {
  ImageEditParamsNonStreaming,
  ImageGenerateParamsNonStreaming,
  ImagesResponse,
} from "openai/resources/images";
import { validateOpenAIBaseUrl } from "../config/base-url.ts";
import { AppError } from "../errors.ts";
import {
  MAX_AGGREGATE_INPUT_BYTES,
  MAX_INPUT_BYTES,
} from "../files/input-snapshot.ts";
import {
  asUnknownRecord,
  mapOpenAIError,
  sanitizeRequestId,
  withSafeRequestId,
} from "./map-error.ts";
import type {
  ImageProvider,
  ProviderComplexity,
  ProviderEditOutputFormat,
  ProviderEditRequest,
  ProviderGenerateRequest,
  ProviderImage,
  ProviderImageUsage,
  ProviderInputSnapshot,
  ProviderOutputFormat,
  ProviderTokenDetails,
} from "./types.ts";

export type OpenAIImagesResponse = ImagesResponse;
export type OpenAIImageGenerateBody = Omit<
  ImageGenerateParamsNonStreaming,
  "quality" | "output_format"
> & {
  quality?: ImageGenerateParamsNonStreaming["quality"] | "xhigh" | "max";
  output_format?: ProviderOutputFormat;
  complexity?: ProviderComplexity;
  frame_count?: number;
  frame_duration_ms?: number;
};
export type OpenAIImageEditBody = Omit<
  ImageEditParamsNonStreaming,
  "quality" | "output_format"
> & {
  quality?: ImageEditParamsNonStreaming["quality"] | "xhigh" | "max";
  output_format?: ProviderEditOutputFormat;
  complexity?: ProviderComplexity;
  frame_count?: number;
  frame_duration_ms?: number;
  markup?: File;
};

export interface OpenAIImageWithResponse {
  readonly data: OpenAIImagesResponse;
  readonly response: Response;
  readonly request_id: string | null;
}

export interface OpenAIImageAPIPromise {
  asResponse(): Promise<Response>;
  withResponse(): Promise<OpenAIImageWithResponse>;
}

export interface OpenAIImageRequestOptions {
  readonly signal?: AbortSignal;
}

export interface OpenAIImageSDK {
  readonly images: {
    generate(
      body: OpenAIImageGenerateBody,
      options?: OpenAIImageRequestOptions,
    ): OpenAIImageAPIPromise;
    edit(
      body: OpenAIImageEditBody,
      options?: OpenAIImageRequestOptions,
    ): OpenAIImageAPIPromise;
  };
}

export interface OpenAIImageLogger {
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

export interface OpenAIImageClientOptions {
  readonly apiKey: string;
  readonly adminAPIKey: null;
  readonly organization: null;
  readonly project: null;
  readonly webhookSecret: null;
  readonly baseURL: string;
  readonly maxRetries: 0;
  readonly logLevel: "off";
  readonly fetchOptions: { readonly redirect: "error" };
  readonly logger: OpenAIImageLogger;
}

export type OpenAIImageClientFactory = (
  options: OpenAIImageClientOptions,
) => OpenAIImageSDK;

export interface OpenAIImageClientConfig {
  readonly apiKey: string;
  readonly baseURL: string;
}

export interface OpenAIImageClientDependencies {
  readonly createSDKClient?: OpenAIImageClientFactory;
}

const CONTROL_OR_SEPARATOR = /[\x00-\x1f\x7f/\\]/;
const MAX_MASK_BYTES = 4 * 1024 * 1024;

function noOp(_message: string, ..._rest: unknown[]): void {}

const disabledLogger: OpenAIImageLogger = Object.freeze({
  error: noOp,
  warn: noOp,
  info: noOp,
  debug: noOp,
});

function createDefaultSDKClient(
  options: OpenAIImageClientOptions,
): OpenAIImageSDK {
  const client = new OpenAI(options);
  return {
    images: {
      generate: (body, requestOptions) => {
        // SDK 6.49.0 predates the GPT Image 2.5/2.6 fields (xhigh and max
        // quality, complexity, GIF and SVG output, GIF frame fields); it sends
        // unknown body keys and values unchanged.
        const sdkBody = body as ImageGenerateParamsNonStreaming;
        return requestOptions === undefined
          ? client.images.generate(sdkBody)
          : client.images.generate(sdkBody, requestOptions);
      },
      edit: (body, requestOptions) => {
        // SDK 6.49.0 predates the GPT Image 2.5/2.6 fields (xhigh and max
        // quality, complexity, GIF output, GIF frame fields, the markup
        // layer); it sends unknown multipart fields and values unchanged.
        const sdkBody = body as ImageEditParamsNonStreaming;
        return requestOptions === undefined
          ? client.images.edit(sdkBody)
          : client.images.edit(sdkBody, requestOptions);
      },
    },
  };
}

function invalidInput(message: string): never {
  throw new AppError("INVALID_INPUT", message);
}

function assertSnapshotDescriptor(snapshot: ProviderInputSnapshot): void {
  if (
    typeof snapshot.snapshotPath !== "string" ||
    snapshot.snapshotPath.length === 0
  ) {
    invalidInput("Input snapshot path is invalid");
  }
  if (
    typeof snapshot.filename !== "string" ||
    snapshot.filename.length === 0 ||
    snapshot.filename.length > 255 ||
    snapshot.filename === "." ||
    snapshot.filename === ".." ||
    CONTROL_OR_SEPARATOR.test(snapshot.filename)
  ) {
    invalidInput("Input snapshot filename is invalid");
  }
  if (
    !Number.isSafeInteger(snapshot.sizeBytes) ||
    snapshot.sizeBytes <= 0 ||
    snapshot.sizeBytes > MAX_INPUT_BYTES
  ) {
    invalidInput("Input snapshot size is invalid");
  }
  if (
    snapshot.info.mimeType !== "image/png" &&
    snapshot.info.mimeType !== "image/jpeg" &&
    snapshot.info.mimeType !== "image/webp"
  ) {
    invalidInput("Input snapshot media type is invalid");
  }
}

function assertEditSnapshots(request: ProviderEditRequest): void {
  if (request.images.length < 1 || request.images.length > 8) {
    invalidInput("Editing requires between one and eight input snapshots");
  }

  let aggregateBytes = 0;
  for (const snapshot of request.images) {
    assertSnapshotDescriptor(snapshot);
    aggregateBytes += snapshot.sizeBytes;
  }
  if (request.mask !== undefined) {
    assertSnapshotDescriptor(request.mask);
    if (request.mask.info.mimeType !== "image/png") {
      invalidInput("Mask snapshot must be a PNG image");
    }
    if (request.mask.sizeBytes >= MAX_MASK_BYTES) {
      invalidInput("Mask snapshot must be smaller than 4 MiB");
    }
    aggregateBytes += request.mask.sizeBytes;
  }
  // The markup layer is bounded by the per-input and aggregate limits only;
  // the 4 MiB mask limit does not apply to it.
  if (request.markup !== undefined) {
    if (request.mask !== undefined) {
      invalidInput("Markup and mask snapshots cannot be combined");
    }
    assertSnapshotDescriptor(request.markup);
    if (request.markup.info.mimeType !== "image/png") {
      invalidInput("Markup snapshot must be a PNG image");
    }
    aggregateBytes += request.markup.sizeBytes;
  }
  if (
    !Number.isSafeInteger(aggregateBytes) ||
    aggregateBytes > MAX_AGGREGATE_INPUT_BYTES
  ) {
    invalidInput("Input snapshots exceed the aggregate size limit");
  }
}

async function readSnapshotBytes(
  snapshot: ProviderInputSnapshot,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(snapshot.snapshotPath, "r");
    signal?.throwIfAborted();
    const bytes = Buffer.allocUnsafe(snapshot.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }

    signal?.throwIfAborted();
    const extra = Buffer.allocUnsafe(1);
    const extraResult = await handle.read(extra, 0, 1, snapshot.sizeBytes);
    signal?.throwIfAborted();
    if (offset !== snapshot.sizeBytes || extraResult.bytesRead !== 0) {
      invalidInput("Input snapshot size changed before upload");
    }
    return bytes;
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "INTERNAL_ERROR",
      "Input snapshot could not be read safely",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotToUpload(
  snapshot: ProviderInputSnapshot,
  signal?: AbortSignal,
): Promise<File> {
  const bytes = await readSnapshotBytes(snapshot, signal);
  signal?.throwIfAborted();
  try {
    const upload = await toFile(bytes, snapshot.filename, {
      type: snapshot.info.mimeType,
    });
    signal?.throwIfAborted();
    return upload;
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    throw new AppError(
      "INTERNAL_ERROR",
      "Input snapshot could not be prepared for upload",
    );
  }
}

// Only JPEG and WebP have a compression setting. PNG, GIF, and SVG requests
// never carry output_compression, even a normalized zero.
function addCompression(
  body: OpenAIImageGenerateBody | OpenAIImageEditBody,
  request: ProviderGenerateRequest | ProviderEditRequest,
): void {
  if (
    (request.output_format === "jpeg" || request.output_format === "webp") &&
    request.output_compression !== undefined
  ) {
    body.output_compression = request.output_compression;
  }
}

function addAnimation(
  body: OpenAIImageGenerateBody | OpenAIImageEditBody,
  request: ProviderGenerateRequest | ProviderEditRequest,
): void {
  if (request.frame_count !== undefined) {
    body.frame_count = request.frame_count;
  }
  if (request.frame_duration_ms !== undefined) {
    body.frame_duration_ms = request.frame_duration_ms;
  }
}

function addBackground(
  body: OpenAIImageGenerateBody | OpenAIImageEditBody,
  request: ProviderGenerateRequest | ProviderEditRequest,
): void {
  if (request.background !== "auto") {
    body.background = request.background;
  }
}

function addComplexity(
  body: OpenAIImageGenerateBody | OpenAIImageEditBody,
  request: ProviderGenerateRequest | ProviderEditRequest,
): void {
  if (request.complexity !== undefined) {
    body.complexity = request.complexity;
  }
}

function invalidProviderResponse(requestId: unknown): AppError {
  return new AppError(
    "INVALID_PROVIDER_RESPONSE",
    withSafeRequestId(
      "The image provider returned an invalid response",
      requestId,
    ),
  );
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function extractTokenDetails(value: unknown): ProviderTokenDetails | undefined {
  const record = asUnknownRecord(value);
  const imageTokens = readNonNegativeInteger(record?.image_tokens);
  const textTokens = readNonNegativeInteger(record?.text_tokens);
  if (imageTokens === undefined || textTokens === undefined) {
    return undefined;
  }
  return Object.freeze({
    image_tokens: imageTokens,
    text_tokens: textTokens,
  });
}

function extractUsage(value: unknown): ProviderImageUsage | undefined {
  const record = asUnknownRecord(value);
  const inputTokens = readNonNegativeInteger(record?.input_tokens);
  const inputTokenDetails = extractTokenDetails(record?.input_tokens_details);
  const outputTokens = readNonNegativeInteger(record?.output_tokens);
  const totalTokens = readNonNegativeInteger(record?.total_tokens);
  if (
    inputTokens === undefined ||
    inputTokenDetails === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const outputTokenDetails = extractTokenDetails(record?.output_tokens_details);
  return Object.freeze({
    input_tokens: inputTokens,
    input_tokens_details: inputTokenDetails,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(outputTokenDetails === undefined
      ? {}
      : { output_tokens_details: outputTokenDetails }),
  });
}

function extractProviderImage(response: OpenAIImageWithResponse): ProviderImage {
  const responseData = asUnknownRecord(response.data);
  const images = responseData?.data;
  if (!Array.isArray(images) || images.length !== 1) {
    throw invalidProviderResponse(response.request_id);
  }

  const image = asUnknownRecord(images[0]);
  const base64 = image?.b64_json;
  if (typeof base64 !== "string" || !/\S/.test(base64)) {
    throw invalidProviderResponse(response.request_id);
  }

  const requestId = sanitizeRequestId(response.request_id);
  const usage = extractUsage(responseData?.usage);
  return {
    base64,
    ...(requestId === undefined ? {} : { requestId }),
    ...(usage === undefined ? {} : { usage }),
  };
}

export class OpenAIImageClient implements ImageProvider {
  readonly #sdk: OpenAIImageSDK;

  constructor(
    config: OpenAIImageClientConfig,
    dependencies: OpenAIImageClientDependencies = {},
  ) {
    if (
      typeof config.apiKey !== "string" ||
      config.apiKey.trim().length === 0
    ) {
      invalidInput("An API key is required to construct the image provider");
    }

    const options: OpenAIImageClientOptions = Object.freeze({
      apiKey: config.apiKey,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: validateOpenAIBaseUrl(config.baseURL),
      maxRetries: 0,
      logLevel: "off",
      fetchOptions: Object.freeze({ redirect: "error" as const }),
      logger: disabledLogger,
    });
    const createSDKClient =
      dependencies.createSDKClient ?? createDefaultSDKClient;
    this.#sdk = createSDKClient(options);
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage> {
    signal?.throwIfAborted();
    const body: OpenAIImageGenerateBody = {
      model: request.model,
      n: 1,
      prompt: request.prompt,
      quality: request.quality,
      size: request.size,
      output_format: request.output_format,
      moderation: request.moderation,
    };
    addCompression(body, request);
    addBackground(body, request);
    addComplexity(body, request);
    addAnimation(body, request);
    return this.#invoke(
      () =>
        signal === undefined
          ? this.#sdk.images.generate(body)
          : this.#sdk.images.generate(body, { signal }),
      signal,
    );
  }

  async edit(
    request: ProviderEditRequest,
    signal?: AbortSignal,
  ): Promise<ProviderImage> {
    signal?.throwIfAborted();
    assertEditSnapshots(request);
    const images: File[] = [];
    for (const snapshot of request.images) {
      images.push(await snapshotToUpload(snapshot, signal));
    }

    const body: OpenAIImageEditBody = {
      model: request.model,
      n: 1,
      prompt: request.prompt,
      quality: request.quality,
      size: request.size,
      output_format: request.output_format,
      image: images,
    };
    addCompression(body, request);
    addBackground(body, request);
    addComplexity(body, request);
    addAnimation(body, request);
    if (request.mask !== undefined) {
      body.mask = await snapshotToUpload(request.mask, signal);
    }
    if (request.markup !== undefined) {
      body.markup = await snapshotToUpload(request.markup, signal);
    }
    signal?.throwIfAborted();
    return this.#invoke(
      () =>
        signal === undefined
          ? this.#sdk.images.edit(body)
          : this.#sdk.images.edit(body, { signal }),
      signal,
    );
  }

  async #invoke(
    call: () => OpenAIImageAPIPromise,
    signal?: AbortSignal,
  ): Promise<ProviderImage> {
    signal?.throwIfAborted();
    let apiPromise: OpenAIImageAPIPromise;
    try {
      apiPromise = call();
    } catch (error) {
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      throw mapOpenAIError(error);
    }

    const rawResponsePromise = apiPromise
      .asResponse()
      .catch((): undefined => undefined);
    let response: OpenAIImageWithResponse;
    try {
      response = await apiPromise.withResponse();
    } catch (error) {
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      const rawResponse = await rawResponsePromise;
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      if (rawResponse?.ok) {
        throw invalidProviderResponse(
          rawResponse.headers.get("x-request-id"),
        );
      }
      throw mapOpenAIError(error);
    }
    signal?.throwIfAborted();
    return extractProviderImage(response);
  }
}
