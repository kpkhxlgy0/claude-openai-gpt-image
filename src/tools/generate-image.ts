import type { ProviderGenerateRequest } from "../openai/types.ts";
import type { GenerateImageInput } from "../schemas.ts";
import { buildImageToolOutput } from "./result.ts";
import {
  assertOutputFormat,
  getToolOperations,
  requireImageProvider,
  selectOutputPath,
  type ImageToolOutput,
  type ToolContext,
} from "./types.ts";

export async function generateImage(
  input: GenerateImageInput,
  context: ToolContext,
): Promise<ImageToolOutput> {
  const provider = requireImageProvider(context);
  const operations = getToolOperations(context);
  const requestedOutputPath = selectOutputPath(
    input.output_path,
    input.output_format,
    operations,
  );
  const output = await operations.paths.resolveOutput(
    requestedOutputPath,
    input.workspace_root,
  );
  assertOutputFormat(output, input.output_format);

  const request: ProviderGenerateRequest = {
    prompt: input.prompt,
    quality: input.quality,
    size: input.size,
    output_format: input.output_format,
    ...(input.output_compression === undefined
      ? {}
      : { output_compression: input.output_compression }),
    moderation: input.moderation,
  };

  const providerImage = await context.paidCallGate.runExclusive(() =>
    provider.generate(request),
  );
  const published = await operations.publishOutput({
    output,
    base64: providerImage.base64,
    format: input.output_format,
  });

  return buildImageToolOutput({
    requestedSize: input.size,
    quality: input.quality,
    output,
    providerImage,
    published,
  });
}
