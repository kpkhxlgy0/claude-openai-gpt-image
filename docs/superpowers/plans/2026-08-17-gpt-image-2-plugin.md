# GPT Image 2 Claude Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-repository Claude plugin that bundles a Skill and a secure local MCP server for OpenAI GPT Image 2 generation and editing.

**Architecture:** The repository root is the installable plugin root and contains `plugin.json`, `marketplace.json`, `.mcp.json`, Skills, commands, and a prebuilt `dist/server.mjs`. The TypeScript server separates configuration, workspace path security, image validation, OpenAI transport, use cases, and MCP protocol adapters so each boundary can be tested without paid API calls.

**Tech Stack:** Node.js 20+, TypeScript ESM, `@modelcontextprotocol/sdk@1.30.0`, `openai@6.49.0`, `zod@4.4.3`, `@jsquash/webp@1.5.0`, esbuild, tsx, Node test runner.

## Global Constraints

- Repository root: `D:\Unity\claude-openai-gpt-image`; do not modify `D:\Unity\claude-plusplus`.
- One repository equals one plugin; marketplace `source` is exactly `"./"`.
- Plugin ID is `gpt-image-2@kpk-plugins`; author identity is KPK.
- Runtime requires Node.js 20+ and must not run npm, npx, lifecycle scripts, or source compilation.
- Runtime model is fixed to `gpt-image-2`; paid image calls fix `n: 1`.
- API keys must never be printed, returned, written to repository files, ordinary settings, `.env`, `.mcp.json`, prompts, docs, or logs.
- Base URLs, prompts, image contents, Base64, and full local input paths must not be logged.
- No paid API call is allowed during implementation or verification unless the user explicitly authorizes it later.
- OpenAI SDK retries and application-level paid-call retries are disabled.
- Output paths stay inside an approved workspace root and existing files are never overwritten.
- First release excludes Desktop Chat, MCPB, remote MCP, multiple images per request, transparent backgrounds, remote edit URLs, and in-memory edit sessions.
- Every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Scaffold the root plugin and build pipeline

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `.mcp.json`
- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `scripts/build.mjs`
- Create: `scripts/validate-package.mjs`
- Create: `src/index.ts`
- Create: `test/manifest.test.ts`
- Create: `test/repository-shape.test.ts`

**Interfaces:**
- Produces plugin ID `gpt-image-2@kpk-plugins`.
- Produces runtime entry point `dist/server.mjs`.
- Provides scripts: `typecheck`, `test`, `build`, `test:dist`, `validate`.
- Later tasks may add source files imported by `src/index.ts`; the initial entry point only proves bundling works.

- [ ] **Step 1: Write failing metadata tests**

Create tests that parse the three JSON files and assert the approved root layout:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("repository root is the single marketplace plugin", async () => {
  const marketplace = await json(".claude-plugin/marketplace.json");
  assert.equal(marketplace.name, "kpk-plugins");
  assert.deepEqual(marketplace.plugins.map((p: { name: string; source: string }) => ({
    name: p.name,
    source: p.source,
  })), [{ name: "gpt-image-2", source: "./" }]);
});

test("API key is sensitive and MCP uses plugin substitutions", async () => {
  const plugin = await json(".claude-plugin/plugin.json");
  const mcp = await json(".mcp.json");
  assert.equal(plugin.userConfig.openai_api_key.sensitive, true);
  assert.equal(mcp.mcpServers.images.args[0], "${CLAUDE_PLUGIN_ROOT}/dist/server.mjs");
  assert.equal(mcp.mcpServers.images.env.OPENAI_API_KEY, "${user_config.openai_api_key}");
  assert.equal(mcp.mcpServers.images.env.GPT_IMAGE_WORKSPACE_ROOT, "${CLAUDE_PROJECT_DIR}");
});
```

- [ ] **Step 2: Run the tests and verify they fail because metadata is absent**

Run:

```bash
npx --yes tsx --test test/manifest.test.ts test/repository-shape.test.ts
```

Expected: failure reading `.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json`.

- [ ] **Step 3: Create package metadata and install pinned dependencies**

Create `package.json` with:

```json
{
  "name": "claude-openai-gpt-image",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "tsx --test test/**/*.test.ts",
    "build": "node scripts/build.mjs",
    "test:dist": "tsx --test test/dist/**/*.test.ts",
    "validate": "node scripts/validate-package.mjs"
  },
  "dependencies": {
    "@jsquash/webp": "1.5.0",
    "@modelcontextprotocol/sdk": "1.30.0",
    "openai": "6.49.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "20.19.43",
    "esbuild": "0.28.2",
    "tsx": "4.23.12",
    "typescript": "7.0.2"
  }
}
```

Run:

```bash
npm install --ignore-scripts
```

Expected: `package-lock.json` is created and no dependency lifecycle script runs.

- [ ] **Step 4: Create plugin metadata**

Create `plugin.json` with KPK identity, version `0.1.0`, and exactly the two approved `userConfig` fields. Create `marketplace.json` with one `source: "./"` entry. Create `.mcp.json` with `node`, `${CLAUDE_PLUGIN_ROOT}/dist/server.mjs`, `${user_config.*}`, `${CLAUDE_PROJECT_DIR}`, and `${CLAUDE_PLUGIN_DATA}` substitutions.

- [ ] **Step 5: Create TypeScript and build configuration**

Use strict ESM settings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `src/index.ts` as a temporary stdio-safe entry point:

```ts
process.stderr.write("gpt-image-2 MCP scaffold\n");
```

Create `scripts/build.mjs` using esbuild with `platform: "node"`, `format: "esm"`, `target: "node20"`, `bundle: true`, `packages: "bundle"`, `loader: { ".wasm": "base64" }`, no source map, and output `dist/server.mjs`.

- [ ] **Step 6: Add package validation**

`scripts/validate-package.mjs` must fail when:

- `dist/server.mjs` is missing.
- Metadata versions disagree.
- Marketplace source is not `./`.
- `.mcp.json` points outside `${CLAUDE_PLUGIN_ROOT}`.
- Tracked text contains an API-key-shaped value matching `sk-[A-Za-z0-9_-]{16,}`.
- The built server contains an absolute source checkout path.

- [ ] **Step 7: Run scaffold verification**

Run:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run validate
```

Expected: all pass; `dist/server.mjs` exists.

- [ ] **Step 8: Commit the scaffold**

```bash
git add .claude-plugin .mcp.json .gitignore package.json package-lock.json tsconfig.json scripts src/index.ts test
```

```bash
git commit -m "chore: scaffold GPT Image 2 plugin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Implement stable errors, configuration, and tool schemas

**Files:**
- Create: `src/errors.ts`
- Create: `src/config/base-url.ts`
- Create: `src/config/environment.ts`
- Create: `src/schemas.ts`
- Create: `test/config.test.ts`
- Create: `test/schemas.test.ts`

**Interfaces:**
- Produces `AppError`, `ErrorCode`, and `toErrorResult()`.
- Produces `validateOpenAIBaseUrl(value?: string): string`.
- Produces `loadEnvironment(env: NodeJS.ProcessEnv): RuntimeConfig`.
- Produces `generateImageSchema`, `editImageSchema`, `statusSchema` and inferred input types.
- Later tasks consume only these public exports, not raw environment variables or ad hoc Zod parsing.

- [ ] **Step 1: Write failing configuration and schema tests**

Cover:

```ts
assert.equal(validateOpenAIBaseUrl(undefined), "https://api.openai.com/v1");
assert.equal(validateOpenAIBaseUrl("https://example.test/v1///"), "https://example.test/v1");
assert.throws(() => validateOpenAIBaseUrl(" https://example.test/v1"), /CONFIG_INVALID/);
assert.throws(() => validateOpenAIBaseUrl("https://user:pass@example.test/v1"), /CONFIG_INVALID/);
assert.throws(() => validateOpenAIBaseUrl("https://example.test/v1?q=1"), /CONFIG_INVALID/);
```

Schema cases must include prompt limits, strict unknown-field rejection, custom size limits, PNG compression-zero normalization, nonzero PNG rejection, JPEG/WebP compression acceptance, edit count 1–8, and mask/path types.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npx tsx --test test/config.test.ts test/schemas.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement stable application errors**

Use:

```ts
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
```

`toErrorResult` must preserve `AppError.code`, map unknown failures to `INTERNAL_ERROR`, and never serialize `cause`, stack, request body, environment, or SDK response objects.

- [ ] **Step 4: Implement Base URL and environment validation**

```ts
export interface RuntimeConfig {
  apiKeyConfigured: boolean;
  apiKey?: string;
  baseUrl: string;
  baseUrlConfigured: boolean;
  workspaceRoot?: string;
  pluginDataRoot?: string;
}
```

`loadEnvironment` trims only for presence checks; it must not expose a normalized or partial API key. Store the raw non-empty key for SDK construction inside the process only.

- [ ] **Step 5: Implement strict tool schemas**

Export these input shapes:

```ts
export interface GenerateImageInput {
  prompt: string;
  quality: "auto" | "low" | "medium" | "high";
  size: "auto" | `${number}x${number}`;
  output_format: "png" | "jpeg" | "webp";
  output_compression?: number;
  moderation: "auto" | "low";
  output_path?: string;
  workspace_root?: string;
}

export interface EditImageInput extends Omit<GenerateImageInput, "moderation"> {
  image_paths: string[];
  mask_path?: string;
}
```

Implement Zod preprocessing that removes `output_compression: 0` only when the effective format is PNG. Validate size with one shared `parseImageSize` function that returns `{ width, height } | null` for `auto`.

- [ ] **Step 6: Run focused and full tests**

```bash
npx tsx --test test/config.test.ts test/schemas.test.ts
```

```bash
npm run typecheck
```

```bash
npm test
```

Expected: all pass.

- [ ] **Step 7: Commit configuration and schemas**

```bash
git add src/errors.ts src/config src/schemas.ts test/config.test.ts test/schemas.test.ts
```

```bash
git commit -m "feat: validate image tool configuration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Enforce workspace-root path containment

**Files:**
- Create: `src/files/workspace-roots.ts`
- Create: `src/files/workspace-paths.ts`
- Create: `src/files/windows-paths.ts`
- Create: `test/workspace-paths.test.ts`

**Interfaces:**
- Produces `WorkspaceRootRegistry`.
- Produces `WorkspacePaths.resolveInput()` and `WorkspacePaths.resolveOutput()`.
- Produces `ResolvedInputPath` and `ResolvedOutputPath` with selected canonical root, absolute path, and normalized project-relative path.
- Later persistence and tools must not call `path.resolve()` on user input directly.

- [ ] **Step 1: Write attack-focused failing tests**

Test normal relative paths plus:

- `../escape.png`
- mixed separators such as `images/..\\..\\escape.png`
- `C:\absolute.png`, `C:relative.png`
- `\\server\share\image.png`
- `\\?\C:\image.png` and `\\.\device`
- `image.png:stream`
- `CON`, `NUL.png`, `COM1.jpg`
- NUL bytes
- sibling prefix collisions (`root` versus `root-evil`)
- symlink directory escapes
- contained absolute input acceptance
- absolute output rejection
- output leaf symlink rejection
- multiple-root selection and ambiguity

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/workspace-paths.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement root registry**

```ts
export interface WorkspaceRoot {
  displayPath: string;
  canonicalPath: string;
}

export class WorkspaceRootRegistry {
  async replace(paths: readonly string[]): Promise<void>;
  list(): readonly WorkspaceRoot[];
  select(requested?: string): WorkspaceRoot;
}
```

`replace` accepts existing local directories only, realpaths and deduplicates them case-insensitively on Windows, and preserves no unvalidated string. `select` auto-selects one root, requires an explicit approved root when multiple roots exist, and never treats the selector as a new grant.

- [ ] **Step 4: Implement Windows lexical rejection**

`assertPortableRelativePath` must reject dangerous Windows spellings even when tests run on another platform. Normalize separators only after rejecting UNC/device prefixes, drive prefixes, ADS colons, NULs, and reserved path segments.

- [ ] **Step 5: Implement contained input and output resolution**

```ts
export interface ResolvedInputPath {
  root: WorkspaceRoot;
  absolutePath: string;
  relativePath: string;
}

export interface ResolvedOutputPath extends ResolvedInputPath {
  parentPath: string;
}
```

Inputs may be relative or contained absolute paths. Outputs must be relative. Resolve the deepest existing ancestor with `realpath`, append missing segments, and verify containment with `path.relative`. Reject existing output leaves and symlink leaves.

- [ ] **Step 6: Run path tests on Windows**

```bash
npx tsx --test test/workspace-paths.test.ts
```

```bash
npm test
```

Expected: all pass, including Junction/symlink tests where the current Windows permissions permit creation; explicitly skip only the test that cannot create the link and keep all lexical escape tests active.

- [ ] **Step 7: Commit workspace security**

```bash
git add src/files/workspace-roots.ts src/files/workspace-paths.ts src/files/windows-paths.ts test/workspace-paths.test.ts
```

```bash
git commit -m "feat: confine image paths to workspace roots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Validate PNG, JPEG, WebP, and strict Base64

**Files:**
- Create: `src/images/types.ts`
- Create: `src/images/strict-base64.ts`
- Create: `src/images/png.ts`
- Create: `src/images/jpeg.ts`
- Create: `src/images/webp.ts`
- Create: `src/images/inspect-image.ts`
- Create: `src/types/wasm.d.ts`
- Create: `test/image-inspection.test.ts`
- Create: `test/helpers/image-fixtures.ts`

**Interfaces:**
- Produces `decodeStrictBase64(value, maxBytes): Buffer`.
- Produces `inspectImage(bytes, expectedFormat?): Promise<ImageInfo>`.
- Produces `ImageInfo { format, mimeType, width, height, hasAlpha }`.
- Later file and provider paths use this one inspector for both inputs and outputs.

- [ ] **Step 1: Write failing image tests**

Generate minimal fixtures in code and test:

- Canonical Base64 acceptance and whitespace/nonalphabet/padding rejection.
- Valid PNG, CRC corruption, chunk truncation, illegal order, oversized IHDR, and bounded-inflation failure.
- Valid baseline/progressive JPEG, invalid segment length, missing EOI, and truncated entropy stream.
- Valid lossy/lossless WebP, RIFF length mismatch, truncated chunk, and libwebp decode failure.
- Expected-format mismatch.
- Width, height, MIME, and alpha extraction.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/image-inspection.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement strict Base64 decoding**

Reject noncanonical encodings by validating syntax, decoding, enforcing `maxBytes`, and requiring `buffer.toString("base64")` to equal the normalized input exactly.

- [ ] **Step 4: Implement bounded PNG validation**

Parse chunks with checked 32-bit lengths, enforce IHDR-first/IEND-last, cap chunk count and ancillary metadata, verify CRC32, concatenate bounded IDAT bytes, inflate with `maxOutputLength`, and verify expected scanline bytes for noninterlaced images. Reject unsupported or malformed interlace cases rather than accepting unvalidated data.

- [ ] **Step 5: Implement JPEG marker validation**

Walk markers and segment lengths, extract dimensions from supported SOF markers, parse SOS boundaries, handle byte stuffing and restart markers, require EOI, and reject trailing non-padding data or unreasonable dimensions/pixel counts.

- [ ] **Step 6: Implement WebP container plus decoder validation**

Import `@jsquash/webp/decode.js` and the decoder WASM as Base64:

```ts
import decodeWebP, { init as initWebP } from "@jsquash/webp/decode.js";
import decoderWasmBase64 from "@jsquash/webp/codec/dec/webp_dec.wasm";
```

Compile and initialize the module once, validate RIFF/chunk framing and pixel limits first, then decode through libwebp. Require decoded dimensions to match container dimensions and discard decoded RGBA bytes immediately after validation.

- [ ] **Step 7: Run image, type, and build tests**

```bash
npx tsx --test test/image-inspection.test.ts
```

```bash
npm run typecheck
```

```bash
npm run build
```

Expected: all pass and the WASM payload is embedded in `dist/server.mjs`; no external `.wasm` file is required.

- [ ] **Step 8: Commit image validation**

```bash
git add src/images src/types test/image-inspection.test.ts test/helpers/image-fixtures.ts scripts/build.mjs package.json package-lock.json
```

```bash
git commit -m "feat: validate generated image payloads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Add immutable inputs and atomic no-overwrite outputs

**Files:**
- Create: `src/files/input-snapshot.ts`
- Create: `src/files/atomic-output.ts`
- Create: `src/files/default-output.ts`
- Create: `test/file-lifecycle.test.ts`

**Interfaces:**
- Produces `snapshotInputs(paths, pluginDataRoot): Promise<InputSnapshotSet>`.
- Produces `publishOutput(options): Promise<PublishedImage>`.
- Produces `makeDefaultOutputPath(format, now?, randomBytes?): string`.
- `InputSnapshotSet.dispose()` is idempotent.

- [ ] **Step 1: Write failing lifecycle tests**

Cover:

- 50 MiB per-input and 200 MiB aggregate bounds without allocating giant fixtures.
- Snapshot bytes remain unchanged after the original file is replaced.
- Snapshot cleanup after success and thrown errors.
- Unique prompt-free default filenames.
- Existing destination rejection.
- Concurrent publication race allows exactly one winner.
- Invalid image never reaches final path.
- Temporary files are cleaned after validation or rename failure.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/file-lifecycle.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement snapshots through stable handles**

Open each validated source with `fs.promises.open`, compare `fstat` size to limits, copy from the handle to a mode-`0o600` unique snapshot, inspect the copied image, and return:

```ts
export interface InputSnapshot {
  originalRelativePath: string;
  snapshotPath: string;
  filename: string;
  info: ImageInfo;
  sizeBytes: number;
}
```

Never expose snapshot paths in MCP results or logs.

- [ ] **Step 4: Implement atomic publication**

`publishOutput` strictly decodes provider Base64, validates format and dimensions, creates the output parent, rechecks containment, writes with exclusive creation, flushes, and publishes with no-overwrite semantics. On Windows, use an exclusive final-path reservation or link-based publication so rename cannot replace an existing target.

- [ ] **Step 5: Run focused and full tests**

```bash
npx tsx --test test/file-lifecycle.test.ts
```

```bash
npm test
```

Expected: all pass with no temporary residue.

- [ ] **Step 6: Commit file lifecycle code**

```bash
git add src/files test/file-lifecycle.test.ts
```

```bash
git commit -m "feat: publish image files atomically

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Implement the no-retry OpenAI GPT Image adapter

**Files:**
- Create: `src/openai/types.ts`
- Create: `src/openai/openai-image-client.ts`
- Create: `src/openai/map-error.ts`
- Create: `test/openai-client.test.ts`

**Interfaces:**
- Produces `ImageProvider` with `generate()` and `edit()`.
- Produces `OpenAIImageClient` implementing `ImageProvider`.
- Consumes immutable snapshot paths rather than user-controlled original files.
- Returns provider Base64 and metadata but never writes files.

- [ ] **Step 1: Write failing adapter tests with a fake SDK client**

Assert:

- Client construction uses `apiKey`, validated `baseURL`, `maxRetries: 0`, and a disabled logger.
- Generate fixes `model: "gpt-image-2"` and `n: 1`.
- Edit preserves image order and optional mask.
- PNG omits compression.
- Base64 and request ID extraction are correct.
- 401/403, moderation, 429, 4xx, 5xx, and network failures map to stable errors.
- A failing SDK call is invoked exactly once.
- Sanitized errors omit prompts, URLs, paths, bodies, and authorization data.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/openai-client.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Define provider-neutral contracts**

```ts
export interface ProviderImage {
  base64: string;
  requestId?: string;
  usage?: unknown;
}

export interface ImageProvider {
  generate(request: ProviderGenerateRequest): Promise<ProviderImage>;
  edit(request: ProviderEditRequest): Promise<ProviderImage>;
}
```

Provider request types contain validated model parameters and snapshot descriptors only.

- [ ] **Step 4: Inspect installed OpenAI 6.49 type declarations before coding**

Use dedicated file search/read tools to confirm the exact `images.generate` and `images.edit` input types and request-ID access. Adapt only the SDK boundary; do not weaken the public schemas or use `any` throughout the application.

- [ ] **Step 5: Implement client and error mapping**

Construct OpenAI once after local config validation. Use bounded `Buffer`/`toFile` uploads from snapshots. Map errors by status and provider error code; retain a request ID only when it is a short safe token.

- [ ] **Step 6: Run adapter and full tests**

```bash
npx tsx --test test/openai-client.test.ts
```

```bash
npm run typecheck
```

```bash
npm test
```

Expected: all pass and every simulated paid call count is one.

- [ ] **Step 7: Commit the provider adapter**

```bash
git add src/openai test/openai-client.test.ts
```

```bash
git commit -m "feat: add GPT Image 2 provider adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Implement status, generation, and editing use cases

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/status.ts`
- Create: `src/tools/generate-image.ts`
- Create: `src/tools/edit-image.ts`
- Create: `src/tools/result.ts`
- Create: `src/concurrency.ts`
- Create: `test/tools.test.ts`

**Interfaces:**
- Produces `getStatus(context): StatusOutput`.
- Produces `generateImage(input, context): Promise<ImageToolOutput>`.
- Produces `editImage(input, context): Promise<ImageToolOutput>`.
- Produces `toMcpSuccess(output)` and uses `toErrorResult()` for failures.
- Consumes configuration, workspace paths, provider, snapshots, publication, and image inspection through dependency-injected context.

- [ ] **Step 1: Write failing use-case tests**

Test:

- Status makes zero provider calls and reveals only booleans, roots, model, version, and default relative directory.
- Missing key fails before provider invocation.
- Invalid/output-existing paths fail before provider invocation.
- Generate maps validated fields, publishes output, and reports actual dimensions.
- Explicit dimension mismatch preserves output and adds `SIZE_MISMATCH`.
- Edit validates all inputs and mask before provider invocation.
- Output cannot equal an input.
- Snapshots are disposed after provider success and failure.
- Concurrent paid calls are serialized.
- Inline preview included at or below 2 MiB and omitted above it.
- Structured content never contains Base64.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/tools.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement dependency-injected tool context**

```ts
export interface ToolContext {
  config: RuntimeConfig;
  roots: WorkspaceRootRegistry;
  provider?: ImageProvider;
  paidCallGate: Semaphore;
  serverVersion: string;
}
```

Provider remains absent when the API key is missing; status still works.

- [ ] **Step 4: Implement one-per-process paid-call semaphore**

The semaphore must release in `finally` and preserve FIFO order. Validation and filesystem preparation happen before acquiring where safe; the lock encloses only the provider request and immediate provider-result handling needed to prevent overlap.

- [ ] **Step 5: Implement status and result mapping**

`getStatus` returns no Base URL value. `toMcpSuccess` builds text plus structured content and conditionally one `ImageContent` block; never copy Base64 into text or structured content.

- [ ] **Step 6: Implement generation**

Resolve the output, check no-overwrite, call the provider once, publish and validate the result, compare actual dimensions, and return metadata.

- [ ] **Step 7: Implement editing**

Resolve and snapshot 1–8 images plus optional mask, validate mask alpha and dimensions, reject output/input identity, call the provider once, publish, and dispose snapshots in `finally`.

- [ ] **Step 8: Run use-case and full tests**

```bash
npx tsx --test test/tools.test.ts
```

```bash
npm run typecheck
```

```bash
npm test
```

Expected: all pass.

- [ ] **Step 9: Commit image use cases**

```bash
git add src/tools src/concurrency.ts test/tools.test.ts
```

```bash
git commit -m "feat: generate and edit workspace images

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Expose the MCP protocol and roots lifecycle

**Files:**
- Create: `src/logger.ts`
- Create: `src/server.ts`
- Modify: `src/index.ts`
- Create: `test/protocol.test.ts`
- Create: `test/dist/server-process.test.ts`

**Interfaces:**
- Produces `createImageServer(dependencies): McpServer`.
- Produces the final stdio executable in `src/index.ts`.
- Registers `get_status`, `generate_image`, and `edit_image` with stable input/output schemas and tool annotations.
- Integrates MCP roots into `WorkspaceRootRegistry`.

- [ ] **Step 1: Write failing in-process MCP tests**

Use SDK in-memory transports to verify:

- Initialize succeeds without a key.
- `tools/list` exposes exactly the three tools.
- Tool annotations identify status as read-only and image tools as non-idempotent/destructive only to newly created output files.
- Status response matches its output schema.
- Invalid input returns `isError: true` with a stable code.
- Roots are loaded from initial environment plus `roots/list`.
- Roots-change notification refreshes the registry.
- Prompts and secrets never appear in captured logger output.

- [ ] **Step 2: Verify protocol tests fail**

```bash
npx tsx --test test/protocol.test.ts
```

Expected: module-not-found or scaffold-server failure.

- [ ] **Step 3: Implement stderr-only structured logger**

Logger methods accept a code, phase, optional request ID, and safe numeric context. Do not accept arbitrary objects or free-form provider errors. This API prevents accidental prompt/key logging.

- [ ] **Step 4: Implement server registration**

Use `McpServer.registerTool()` with Zod schemas, titles, descriptions, annotations, and output schemas. Handler wrappers parse input, invoke use cases, and map all exceptions through `toErrorResult()`.

- [ ] **Step 5: Implement roots synchronization**

When supported, request roots after initialization and on roots-change notifications. Catch unavailable-root capability separately without failing the server. Merge the validated environment root with client-published file roots.

- [ ] **Step 6: Replace the scaffold entry point**

`src/index.ts` loads environment, creates optional provider, builds roots/context/server, connects `StdioServerTransport`, installs signal/transport-close cleanup, and never writes to stdout directly.

- [ ] **Step 7: Add built-process tests**

Build the server, spawn `node dist/server.mjs` with a sanitized test environment, send MCP JSON-RPC initialization and tool-list messages, verify stdout parses as JSON-RPC only, and close stdin to confirm the process exits.

- [ ] **Step 8: Run protocol and full verification**

```bash
npm run build
```

```bash
npx tsx --test test/protocol.test.ts test/dist/server-process.test.ts
```

```bash
npm run typecheck
```

```bash
npm test
```

Expected: all pass.

- [ ] **Step 9: Commit the MCP server**

```bash
git add src/index.ts src/server.ts src/logger.ts test/protocol.test.ts test/dist/server-process.test.ts dist/server.mjs
```

```bash
git commit -m "feat: expose GPT Image tools over MCP

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Add Skills, setup command, documentation, and notices

**Files:**
- Create: `skills/gpt-image-2/SKILL.md`
- Create: `skills/gpt-image-result-handling/SKILL.md`
- Create: `commands/setup.md`
- Create: `README.md`
- Create: `README.zh-CN.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `test/content.test.ts`

**Interfaces:**
- Primary Skill activates on explicit generation/editing intent.
- Result Skill is internal and preserves MCP truthfulness.
- Setup command invokes only `get_status` and performs no paid request.
- Documentation prioritizes Claude Desktop Code GUI installation.

- [ ] **Step 1: Write failing content tests**

Assert:

- Both Skills have valid frontmatter and bounded descriptions.
- Result Skill is not user-invocable.
- Setup references `get_status` and does not reference `generate_image` or `edit_image` as a diagnostic call.
- English and Chinese docs mention GUI API key/Base URL setup, custom-endpoint disclosure, default output directory, no-overwrite, no automatic retry, `/v1` troubleshooting, dimension mismatch, and Desktop Chat exclusion.
- No docs contain API-key-shaped strings.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test test/content.test.ts
```

Expected: missing-file failures.

- [ ] **Step 3: Write primary and result Skills**

Keep tool-use instructions concise and explicit. Do not embed configuration values or hardcode an unverified fully scoped MCP tool name; refer to the plugin's image tools by their declared tool names.

- [ ] **Step 4: Write setup command**

The command calls `get_status`, reports booleans and approved roots, explains how to open plugin settings when configuration is missing, and explicitly states that no image API request was made.

- [ ] **Step 5: Write bilingual documentation and legal files**

Document installation, configuration, security, tools, examples, troubleshooting, build/test steps, license, and third-party components. Examples use values such as `https://api.example.invalid/v1`, never realistic secrets.

- [ ] **Step 6: Run content and full tests**

```bash
npx tsx --test test/content.test.ts
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run validate
```

Expected: all pass.

- [ ] **Step 7: Commit user-facing plugin content**

```bash
git add skills commands README.md README.zh-CN.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md test/content.test.ts
```

```bash
git commit -m "docs: add GPT Image plugin guidance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Validate installed-plugin behavior without paid calls

**Files:**
- Create: `test/dist/installed-plugin.test.ts`
- Modify: `scripts/validate-package.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces a release-ready root plugin checkout.
- Verifies marketplace-copy behavior and cache-independent runtime paths.
- Does not configure, retrieve, or print a real API key.

- [ ] **Step 1: Write failing installed-copy test**

The test copies only tracked plugin files to a temporary directory, removes source-only dependency availability from the child process, starts the copied `dist/server.mjs`, and verifies initialize, tools/list, and get_status.

It must also assert that the copied `.mcp.json` contains only supported configuration substitutions and that no absolute checkout path appears in the bundle.

- [ ] **Step 2: Verify the test fails before final package hardening**

```bash
npm run build
```

```bash
npx tsx --test test/dist/installed-plugin.test.ts
```

Expected: fail on any unresolved runtime dependency or package-content mismatch; if it passes immediately, retain it as the regression test and continue.

- [ ] **Step 3: Harden build and validation until the copy is standalone**

Adjust only build/package files. Do not add runtime package-manager installation. Confirm the WebP WASM and all runtime JavaScript are embedded in `dist/server.mjs`.

- [ ] **Step 4: Run the complete offline verification matrix**

```bash
npm ci --ignore-scripts
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run test:dist
```

```bash
npm run validate
```

Expected: all pass with no network request to an image endpoint.

- [ ] **Step 5: Run strict Claude plugin validation**

```bash
claude plugin validate D:/Unity/claude-openai-gpt-image --strict
```

Expected: valid root plugin, one marketplace plugin at `./`, and one recognized MCP server named `images`.

If the installed CLI's exact validation flags differ, inspect `claude plugin validate --help`, use the supported strict equivalent, and record the exact command in both READMEs.

- [ ] **Step 6: Perform local marketplace installation smoke test**

Use a temporary Claude settings/config location or an isolated test profile so the existing user configuration is not overwritten. Add the local repository as a marketplace, install `gpt-image-2@kpk-plugins`, and verify:

- Installed plugin details list the `images` MCP server.
- The server starts from the plugin cache.
- `get_status` works without an API call.
- Missing API key is reported as a boolean/status or `CONFIG_MISSING`, never printed.

Do not enable or call paid image tools with the user's current credential.

- [ ] **Step 7: Scan repository and built artifacts for secrets and source paths**

Run the package validator plus Git searches for API-key patterns, the user's configured endpoint host, and `D:\Unity\claude-openai-gpt-image`. The only allowed absolute repository path is in the design/plan documentation; it must not appear in runtime or release files.

- [ ] **Step 8: Confirm Claude++ stayed untouched**

```bash
git -C D:/Unity/claude-plusplus status --short
```

Expected: no new changes caused by this implementation. Pre-existing `.claude/` state is reported separately and not modified.

- [ ] **Step 9: Update release notes and commit verification**

Record version `0.1.0`, supported surfaces, and the no-paid-call verification in `CHANGELOG.md` without claiming a live provider test.

```bash
git add scripts test/dist README.md README.zh-CN.md CHANGELOG.md dist/server.mjs
```

```bash
git commit -m "test: verify standalone plugin package

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Final clean-tree report**

Run:

```bash
git status --short
```

```bash
git log --oneline --decorate -10
```

Expected: clean tree, all implementation commits authored as KPK, no push or release performed.
