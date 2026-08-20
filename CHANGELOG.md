# Changelog

All notable changes to this plugin are documented in this file.

## [0.1.1] - Unreleased

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

Offline tests cover manifest loading, `tools/list`, and one `get_status` call without a key. The Claude host smoke test uses the real Claude Code MCP host only for substitution and connection health; it does not run a model or invoke a plugin tool. No paid image API call, image API request, or live provider verification was performed.

## [0.1.0] - Unreleased

### Added

- Claude Desktop Code plugin metadata, Skills, and a non-paid setup command.
- Local MCP tools for safe GPT Image 2 status, single-image generation, and one-to-eight-image editing.
- Workspace-root confinement, immutable edit snapshots, strict PNG/JPEG/WebP validation, atomic no-overwrite publication, actual-dimension reporting, and bounded inline previews.
- Sensitive GUI configuration for the OpenAI API key and optional custom Base URL.
- Node.js 20+ standalone bundled runtime with provider and application retries disabled.
- Installed-copy coverage proving that a Git-index marketplace copy starts, fully decodes a bundled WebP fixture, and serves free status with no `node_modules` directory.
- Strict package validation for the root MCP substitution contract, single-plugin marketplace, exact scripts and pinned dependency lock provenance, bundle syntax/imports and complete embedded WebP decoder, tracked-file hygiene, secret-shaped values, and source-checkout paths.
- English and Simplified Chinese installation, configuration, security, troubleshooting, and contributor guidance.

### Verification scope

Offline unit, integration, protocol, build, and package-validation checks use fixtures and fake provider clients. No paid image API call was made during this verification, and no live provider verification has been performed or claimed.
