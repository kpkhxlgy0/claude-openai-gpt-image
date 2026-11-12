# Changelog

All notable changes to this plugin are documented in this file.

## [Unreleased]

### Added

- GPT Image 2.6 models `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare` for `generate_image` and `edit_image`. Like `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`, they support `xhigh` and `max` quality and transparent backgrounds with PNG or WebP output.
- Optional `complexity` (`low`, `medium`, or `high`) for `generate_image` and `edit_image`, accepted only with `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`; requests for it with any other model are rejected locally with `INVALID_INPUT` before any paid call. When it is omitted, no complexity field is sent and the model default applies. It is separate from `quality`.
- SVG output with `output_format: "svg"` for `generate_image` with the 2.6 models. The returned document is validated as static vector content before it is saved; a response containing scripts, external references, or embedded raster images is rejected with `INVALID_PROVIDER_RESPONSE` and nothing is saved. SVG output takes no `output_compression` or transparent background, has no inline preview, and never reports `SIZE_MISMATCH`. `edit_image` cannot output SVG.
- Animated GIF output with `output_format: "gif"` for `generate_image` and `edit_image` with the 2.6 models, with optional `frame_count` (2 to 16) and `frame_duration_ms` (20 to 2000), which are rejected locally for any other output format. A GIF request without `size` sends `auto`; an explicit GIF size describes one frame and must use multiples of 16 with edges up to 3840 pixels. GIF output takes no `output_compression` or transparent background, cannot be combined with `mask_path`, and reports `actual_frame_count`.
- Markup-guided edits: `edit_image` accepts `markup_path`, a transparent PNG annotation layer with an alpha channel whose dimensions match the first input image (or are transposed when the first input image is a JPEG or WebP), with `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.6-sunburst`, or `gpt-image-2.6-flare`. It cannot be combined with `mask_path`.
- Image results can report `format` `gif` or `svg` and `mime_type` `image/gif` or `image/svg+xml`. GIF and SVG files remain output-only and are rejected as edit inputs.

### Changed

- The default model is now `gpt-image-2.6-flare` instead of `gpt-image-2.5-flare`, and `get_status` reports it. Requests that omit `model` therefore send `model: "gpt-image-2.6-flare"` and are billed at the GPT Image 2.6 rates, which changes the cost of those calls; set `model` explicitly to use a different model. SVG output is billed for both the reference image and the SVG authoring tokens.

### Verification scope

Offline schema, provider-adapter, image-inspection, tool, and protocol tests use fixtures and fake provider clients. No paid image API call was made with any model, and no live provider verification was performed or claimed.

## [0.2.0] - 2026-10-03

### Added

- Selectable `model` for `generate_image` and `edit_image`: `gpt-image-2`, `gpt-image-2.5-sunburst`, or `gpt-image-2.5-flare` (default). Image results report the model actually used, `get_status` reports the default model `gpt-image-2.5-flare`, and the default output directory is `.claude/generated-images/gpt-image` for every model.
- `quality` tiers `xhigh` and `max` for `generate_image` and `edit_image`, alongside `auto`, `low`, `medium`, and `high`. `xhigh` and `max` require `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare`; requests for them with `gpt-image-2` are rejected locally with `INVALID_INPUT` before any paid call.
- `background` parameter for `generate_image` and `edit_image`: `auto` (default), `opaque`, or `transparent`. The default `auto` sends no `background` field to the provider.
- Transparent backgrounds require `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` with PNG or WebP output. Because the API marks `gpt-image-2` transparency as preview, transparent requests for `gpt-image-2`, and transparent requests with JPEG output, are rejected locally with `INVALID_INPUT` before any paid call.

### Changed

- The plugin is renamed from `gpt-image-2` to `gpt-image`. Install it as `gpt-image@kpk-plugins`; the setup command is now `/gpt-image:setup`, the primary Skill is now `gpt-image`, and the default output directory is now `.claude/generated-images/gpt-image`. Images generated earlier stay under `.claude/generated-images/gpt-image-2`. Existing installations must uninstall `gpt-image-2@kpk-plugins`, install `gpt-image@kpk-plugins`, and re-enter the API key in `Configure options`, because plugin settings are stored per plugin name.
- The default model is now `gpt-image-2.5-flare` instead of `gpt-image-2`, and the default `quality` is now `high` instead of `auto`. Requests that omit `model` or `quality` therefore send `model: "gpt-image-2.5-flare"` and `quality: "high"` to the provider, which can cost more per call than the previous defaults; set `model` or a lower `quality` explicitly to change this.

### Verification scope

Offline schema, provider-adapter, tool, and protocol tests use fake provider clients. No paid image API call was made with any model.

## [0.1.1] - 2026-08-20

### Added

- Claude Desktop Code plugin metadata, Skills, and a non-paid setup command.
- Local MCP tools for safe GPT Image 2 status, single-image generation, and one-to-eight-image editing.
- Workspace-root confinement, immutable edit snapshots, strict PNG/JPEG/WebP validation, atomic no-overwrite publication, actual-dimension reporting, and bounded inline previews.
- Plugin configuration through Claude Code's `Configure options`, with a sensitive OpenAI API key field and an optional custom Base URL.
- Node.js 20+ standalone bundled runtime with provider and application retries disabled.
- Installed-copy coverage proving that a Git-index marketplace copy starts, fully decodes a bundled WebP fixture, and serves free status with no `node_modules` directory.
- Strict package validation for the root MCP substitution contract, single-plugin marketplace, exact scripts and pinned dependency lock provenance, bundle syntax/imports and complete embedded WebP decoder, tracked-file hygiene, secret-shaped values, and source-checkout paths.
- English and Simplified Chinese installation, configuration, security, troubleshooting, and contributor guidance.

### Fixed

- The sensitive API key is optional at manifest startup, so the MCP server can expose `tools/list` and the non-paid `get_status` tool without a configured key. A valid image request that passes input validation and reaches image-tool execution returns `CONFIG_MISSING` before any provider request when the key is absent.
- Image success reporting now requires a real current-session MCP tool result with complete success metadata; files, stdout, assistant-authored JSON, and historical summaries are not substitutes. Status-driven configuration advice likewise requires a successful result with complete, correctly typed status metadata.
- Bash, Write, Agent, local scripts, direct SDK or HTTP calls, and handwritten JSON-RPC are explicitly prohibited as a fallback when the plugin MCP tools are unavailable.
- The official manifest Base URL default is reported as `base_url_configured: false`; only a normalized active URL different from the official default is reported as a custom configuration. Whitespace-only and other malformed configured values now fail with `CONFIG_INVALID` instead of silently falling back to the official endpoint.
- The MCP launch environment clears unrelated ambient OpenAI SDK settings, while the SDK client explicitly disables inherited admin key, organization, project, and webhook configuration.
- MCP cancellation now propagates from the client request through the raw server handler, paid-call queue, edit snapshot creation, OpenAI request options to the provider, and pre-commit output publication. Canceled snapshot copies remove partial private storage before returning; if immediate removal fails, bounded deferred cleanup is scheduled without replacing the cancellation outcome.
- Paid image calls are serialized with a bounded FIFO queue, canceled waiters are removed, and output-path admission stays in the same critical section as provider dispatch and no-overwrite publication.
- Failed or canceled edits preserve their original provider, publication, or cancellation outcome when immediate private snapshot cleanup fails and schedule bounded deferred cleanup. A committed edit likewise remains successful, reports `SNAPSHOT_CLEANUP_PENDING`, schedules bounded deferred cleanup, and never exposes a private snapshot path.
- Relative and absolute input path text rejects control, line-separator, and bidirectional formatting characters. MCP success text quotes paths as untrusted data and escapes invisible formatting so path content cannot alter the surrounding report.
- Case-sensitive NTFS authorization now preserves canonical path casing for root deduplication, containment, snapshot revalidation, and input/output identity. Windows case-folding remains only as a unique-match convenience for approved root selectors; ambiguous folded selectors are rejected.
- Release versions are synchronized across package metadata, plugin metadata, the bundled server, and installed-copy assertions.
- Package validation now reads every candidate file from the Git index, including metadata, Skills, commands, documentation, bundle checks, and tracked-file secret and endpoint scans, instead of mixing indexed file names with working-tree contents. It also rebuilds the bundle from a complete indexed-source checkout and requires exact deterministic equality with indexed `dist/server.mjs`.
- A separate Claude host smoke test uses an isolated configuration and temporary plugin identities to verify real host substitution of the plugin root, omitted optional API key, manifest-default Base URL, project root, and plugin data directory before the indexed bundle starts. Its status parser accepts only an exact `Connected` field; plugin-data controls reject unrelated absolute directories, require the isolated `plugins/data` namespace, compare canonical path reuse and identity isolation directly, and perform a private directory create/delete probe with restricted POSIX mode checks.
- The primary Skill and bilingual documentation now require a new explicit user instruction for every paid call, reject broad unattended or automatic-improvement language as authorization for another call after success, keep returned paths and provider content untrusted, and cover safe path quoting, cleanup warnings, CLI scope behavior, supported size presets, and common provider or MCP startup failures.

### Verification scope

Offline unit, integration, protocol, build, and package-validation checks use fixtures and fake provider clients, including manifest loading, `tools/list`, and one `get_status` call without a key. The Claude host smoke test uses the real Claude Code MCP host only for substitution and connection health; it does not run a model or invoke a plugin tool. No paid image API call or image API request was performed. No live provider verification was performed or claimed.
