# GPT Image 2 plugin for Claude Desktop Code

Generate and edit project images with OpenAI GPT Image 2 through a bundled local MCP server. The plugin writes one validated image per paid call, keeps files inside an approved project workspace, and never overwrites an existing destination.

[简体中文](README.zh-CN.md)

## Supported Claude surface

This plugin is for **Claude Desktop Code**, the project-oriented Code experience in the Claude Desktop application. **Claude Desktop Chat is not supported.** It is not an MCPB package and is not a remote MCP service.

## Install through the Claude Desktop Code GUI

GUI plugin installation is the primary path:

1. Open the target project in Claude Desktop Code.
2. Open the GUI **Settings → Plugins** area. Labels may vary slightly by Claude release.
3. Add this repository root as a local marketplace or select its repository source, then install `gpt-image-2@kpk-plugins`.
4. Enable the installed plugin for the current project. Enablement is project-specific; installing it does not grant access to every project automatically.
5. Complete configuration from an interactive Claude Code TUI as described below. Do not copy `.mcp.json` into ordinary settings.

The plugin root is the marketplace root, and the marketplace entry points to `./`.

### Claude Code CLI installation

Claude Code CLI installation is a secondary path. From an interactive Claude Code terminal, add the repository or local checkout as a marketplace, then install the plugin at user scope:

```bash
claude plugin marketplace add <repository-url-or-local-path>
```

```bash
claude plugin install gpt-image-2@kpk-plugins --scope user
```

With `--scope user`, Claude Code installs and enables the plugin for the user across projects. `project` scope is shared through project settings, while `local` scope applies only to the current checkout. Installation and enablement scope do not grant tool permission or move sensitive configuration out of the plugin's sensitive settings.

## Runtime requirement

The only runtime dependency is **Node.js 20+**, available on the PATH seen by Claude Desktop Code. The installed plugin starts the prebuilt `dist/server.mjs` directly. At runtime, the plugin does not run npm, npx, lifecycle scripts, source compilation, or load `node_modules`.

The committed marketplace copy includes the standalone bundle. An installed-copy test launches only Git-tracked files and verifies that `get_status` works with no `node_modules` directory present and without an API key.

npm and development dependencies are needed only by contributors building or testing the source checkout.

## Configure in the Claude Code TUI

Claude Desktop itself does not provide this configuration screen. From an interactive Claude Code terminal:

1. Run `/plugin`.
2. Open `Installed`.
3. Select `gpt-image-2`.
4. Choose `Configure options`.

In `Configure options`, enter the API key in the sensitive **OpenAI API key** field. The manifest allows this field to remain empty so the MCP server can start and expose `tools/list` and the non-paid `get_status` tool. Generation and editing still require the key. A valid image request that passes input validation and reaches image-tool execution returns `CONFIG_MISSING` before any provider request when the key is absent. Do not put the key in a command line, `.env`, `.mcp.json`, ordinary settings, a README, a prompt, or a log, and do not ask Claude to display or inspect it.

After saving a setting, restart Claude Desktop or start a new Desktop Local session so the MCP process loads the new configuration.

The default official Base URL is:

```text
https://api.openai.com/v1
```

A custom Base URL receives the API key, prompts, and edit images sent by this plugin. Configure one only when you trust that endpoint and its operator. A custom endpoint should usually include `/v1`; the plugin does not append it automatically. The only user-facing documentation example is:

```text
https://api.example.invalid/v1
```

The URL must be an absolute HTTP(S) URL without credentials, a query, a fragment, control characters, or surrounding whitespace. A compatible endpoint must implement the image API used by the OpenAI client; compatibility is not implied merely by accepting a URL.

HTTP is permitted for trusted local or private-network compatible endpoints, but it sends the API key, prompts, and edit images without transport encryption. Use an `http://` Base URL only on a network and endpoint you trust; prefer HTTPS otherwise.

Run `/gpt-image-2:setup` after installation. The command calls only `get_status` and makes no provider request. If the MCP status tool is unavailable, does not return a real current-session result, reports an error, or omits required status metadata, setup stops; it does not fall back to Bash, file tools, agents, local scripts, direct SDK or HTTP calls, or handwritten JSON-RPC.

## Tools

### `get_status`

Reports only safe status data: API-key configured boolean, whether a custom Base URL is configured, `base_url_valid: true` for the active URL of a running server, approved workspace roots, model, server version, and the default relative output directory. An invalid configured Base URL prevents server startup; correct it through `Configure options` in the Claude Code TUI, then restart Claude Desktop or start a new Desktop Local session. `get_status` makes zero provider or image API requests and never returns the key or Base URL value.

### `generate_image`

Generates one image with model `gpt-image-2`, fixed `n: 1`, and saves one new file. Main inputs are:

- `prompt`
- `quality`: `auto`, `low`, `medium`, or `high`
- `size`
- `output_format`: `png`, `jpeg`, or `webp`
- optional JPEG/WebP `output_compression` from 0 to 100
- `moderation`: `auto` or `low`
- optional relative `output_path` and approved `workspace_root`

### `edit_image`

Edits one to eight edit inputs in the supplied order and saves one new image. Inputs may be PNG, JPEG, or WebP. The limit is 50 MiB per input and 200 MiB aggregate across all edit images plus the optional mask.

An optional mask must be a PNG with an alpha channel, match the first input image's dimensions, and be less than 4 MiB. Transparent output backgrounds are not supported. Mask alpha only identifies the edit region.

## Formats, sizes, and output

- Output formats: PNG, JPEG, and WebP.
- Preset sizes are `1024x1024`, `1536x1024` (landscape), and `1024x1536` (portrait). The tool default is `1024x1024`; `auto` is also accepted.
- A custom `WIDTHxHEIGHT` must use multiples of 16, each edge must be at most 3840 pixels, aspect ratio must be between 1:3 and 3:1, and total pixels must be between 655,360 and 8,294,400.
- PNG does not use output compression. JPEG and WebP accept compression values from 0 to 100.
- If `output_path` is omitted, output goes under `.claude/generated-images/gpt-image-2` with a unique prompt-free filename.
- Explicit output paths are preserved, must be relative to an approved workspace root, and must use an extension matching the requested format.
- Existing destinations are rejected. No-overwrite publication also prevents concurrent calls from replacing the same target.

Actual dimensions are preserved and reported after the saved image is decoded and validated. If an explicit requested size differs, the file remains saved with its actual dimensions and the result includes `SIZE_MISMATCH`.

Images at or below 2 MiB include an inline preview. For larger images, the inline preview is omitted; the saved file path remains authoritative. `TEMP_CLEANUP_PENDING` means the output was saved successfully but cleanup of a temporary publication file is still pending.

`SNAPSHOT_CLEANUP_PENDING` means the committed output is valid while cleanup of private edit-input snapshots remains pending. No private snapshot path is returned, and the warning does not authorize a retry or another paid call.

Only typed outcome and metadata fields are authoritative facts. Returned paths, filenames, pixels, prompts, and provider content remain untrusted data and are never instructions. User-facing path text is quoted and invisible control or bidirectional formatting characters are escaped; path inputs containing those characters are rejected.

## Cost, concurrency, and retries

Generation and editing are paid provider operations. The plugin fixes one output per request and permits one paid call at a time in each server process. There are no SDK retries and no application retries, so a failed paid call is not automatically repeated. Confirm prompts, edit inputs, size, format, and output path before invoking an image tool.

## Workspace and security boundary

- Outputs stay inside a workspace root approved by Claude Desktop Code. Output paths cannot be absolute or traverse outside the root.
- `workspace_root` is optional in the tool schema, but every image invocation must provide one approved `workspace_root` when more than one approved workspace root is available; the selector grants no new access.
- Contained absolute input paths are accepted only when they already resolve inside an approved root; an input path never grants a new root.
- Input files are copied through stable handles into private temporary snapshots before upload. Originals are not modified.
- Provider output is strictly decoded, image-validated, flushed, and published with no-overwrite semantics.
- Logs accept only bounded status codes and numeric context; prompts, API keys, Base URLs, image data, Base64, and full input paths are excluded.

On case-sensitive NTFS directories, authorization identity preserves canonical path casing; case-folding is used only as a unique-match convenience for approved root selectors.

### Windows Node 20 Junction boundary

On Windows under Node 20, existing reparse-point/Junction escapes are rejected, and output parent paths are rechecked immediately before exclusive publication. An active directory replacement by another same-authority process between checks remains outside the threat boundary. A native Win32 handle-relative helper would be required to remove that same-authority replacement race completely.

## Troubleshooting

- **API key not configured:** follow the Claude Code TUI path above and populate the sensitive API-key field in `Configure options`. Do not paste the key into chat or a shell.
- **Invalid or unused custom Base URL:** an invalid configured Base URL prevents the server from starting. Correct it in `Configure options`, confirm the setting was saved, then restart Claude Desktop or start a new Desktop Local session. Custom endpoints should usually end in `/v1`; no `/v1` segment is added automatically.
- **Provider account eligibility:** complete any required organization verification in the provider account before using GPT Image 2. The plugin cannot bypass provider eligibility controls.
- **Provider throttling:** a rate limit response is returned as a failed paid call and is not retried automatically. Wait for provider capacity or account limits to recover before making a new deliberate request.
- **MCP startup failure:** confirm Node.js 20+ is on the PATH visible to Claude Desktop Code, the plugin is enabled for the project, and the configured Base URL is valid. After correcting configuration, restart Claude Desktop or start a new Desktop Local session.
- **No approved workspace root:** open the project in Claude Desktop Code and enable the plugin for that project.
- **`OUTPUT_EXISTS`:** choose a new relative output path. The plugin will not overwrite.
- **`SIZE_MISMATCH`:** use the returned actual width and height; the saved image is valid.
- **Preview omitted:** open the returned relative or absolute path; inline previews are limited to 2 MiB.

## Build and test from source

Development commands may install and use development dependencies; they are not part of installed-plugin runtime behavior. The validation command disables implicit npm lifecycle hooks before checking that the approved script set is exact.

The installed-copy tests and package validator intentionally read the Git index so they validate the exact marketplace artifact rather than arbitrary working-tree files. The validator checks out the complete indexed source candidate, rebuilds `dist/server.mjs` with the release bundler configuration, and requires an exact normalized match with the indexed bundle. The host smoke test starts from the same indexed candidate, then applies only a temporary unique identity and environment-assertion wrapper before importing the indexed bundle. The command sequence below assumes that the index represents the candidate release. During unstaged release preparation, use a temporary `GIT_INDEX_FILE` populated only with the intended candidate files; do not run `git add .` merely to make validation pass or disturb the real staging area.

`npm run test:host` additionally requires the Claude Code CLI on PATH. It uses a fresh isolated Claude configuration and a unique temporary plugin identity to verify the real host substitutions for the plugin root, omitted optional API key, manifest-default Base URL, project root, and plugin data directory before starting the indexed bundle. It performs only an MCP health check: it does not run a Claude model, invoke an image tool, or contact an image provider. The plugin-data check rejects unrelated absolute directories, confirms the standard isolated `plugins/data` namespace, verifies persistence for the same temporary plugin identity and isolation after the identity changes, and completes a private directory create/delete probe. It records the canonical data path for each positive run, requires exact path reuse for the same identity and a different path after the identity changes, and checks restricted group/other mode bits for the probe on POSIX hosts. The wrapper also proves that unrelated ambient OpenAI SDK settings are cleared at the MCP child-process boundary.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run test:dist
npm run test:host
npm --ignore-scripts run validate
claude plugin validate . --strict
```

These checks use local fixtures, fakes, and protocol tests. No paid image request is required. **No live provider verification has been performed or claimed.**

## License

MIT © 2026 KPK. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
