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
5. Open the plugin settings for configuration. Do not copy `.mcp.json` into ordinary settings.

The plugin root is the marketplace root, and the marketplace entry points to `./`.

## Runtime requirement

The only runtime dependency is **Node.js 20+**, available on the PATH seen by Claude Desktop Code. The installed plugin starts the prebuilt `dist/server.mjs` directly. At runtime, the plugin does not run npm, npx, lifecycle scripts, source compilation, or load `node_modules`.

npm and development dependencies are needed only by contributors building or testing the source checkout.

## Configure in the GUI

In plugin settings, enter the API key in the sensitive **OpenAI API key** field. Do not put it in a command line, `.env`, `.mcp.json`, ordinary settings, a README, a prompt, or a log, and do not ask Claude to display or inspect it.

The default official Base URL is:

```text
https://api.openai.com/v1
```

A custom Base URL receives the API key, prompts, and edit images sent by this plugin. Configure one only when you trust that endpoint and its operator. A custom endpoint should usually include `/v1`; the plugin does not append it automatically. For documentation and tests, the only custom endpoint example is:

```text
https://api.example.invalid/v1
```

The URL must be an absolute HTTP(S) URL without credentials, a query, a fragment, control characters, or surrounding whitespace. A compatible endpoint must implement the image API used by the OpenAI client; compatibility is not implied merely by accepting a URL.

Run `/gpt-image-2:setup` after installation. The command calls only `get_status` and makes no provider request.

## Tools

### `get_status`

Reports only safe status data: API-key configured boolean, Base-URL configured/valid booleans, approved workspace roots, model, server version, and the default relative output directory. `get_status` makes zero provider or image API requests and never returns the key or Base URL value.

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

An optional mask must be a PNG with an alpha channel, match the first input image's dimensions, and be less than 4 MiB. Transparent output backgrounds are not supported; mask alpha only identifies the edit region.

## Formats, sizes, and output

- Output formats: PNG, JPEG, and WebP.
- The tool default size is `1024x1024`. `auto` is also accepted.
- A custom `WIDTHxHEIGHT` must use multiples of 16, each edge must be at most 3840 pixels, aspect ratio must be between 1:3 and 3:1, and total pixels must be between 655,360 and 8,294,400.
- PNG does not use output compression. JPEG and WebP accept compression values from 0 to 100.
- If `output_path` is omitted, output goes under `.claude/generated-images/gpt-image-2` with a unique prompt-free filename.
- Explicit output paths are preserved, must be relative to an approved workspace root, and must use an extension matching the requested format.
- Existing destinations are rejected. No-overwrite publication also prevents concurrent calls from replacing the same target.

Actual dimensions are preserved and reported after the saved image is decoded and validated. If an explicit requested size differs, the file remains saved with its actual dimensions and the result includes `SIZE_MISMATCH`.

Images at or below 2 MiB include an inline preview. For larger images, the inline preview is omitted; the saved file path remains authoritative. `TEMP_CLEANUP_PENDING` means the output was saved successfully but cleanup of a temporary publication file is still pending.

## Cost, concurrency, and retries

Generation and editing are paid provider operations. The plugin fixes one output per request and permits one paid call at a time in each server process. There are no SDK retries and no application retries, so a failed paid call is not automatically repeated. Confirm prompts, edit inputs, size, format, and output path before invoking an image tool.

## Workspace and security boundary

- Outputs stay inside a workspace root approved by Claude Desktop Code. Output paths cannot be absolute or traverse outside the root.
- Contained absolute input paths are accepted only when they already resolve inside an approved root; an input path never grants a new root.
- Input files are copied through stable handles into private temporary snapshots before upload. Originals are not modified.
- Provider output is strictly decoded, image-validated, flushed, and published with no-overwrite semantics.
- Logs accept only bounded status codes and numeric context; prompts, API keys, Base URLs, image data, Base64, and full input paths are excluded.

### Windows Node 20 Junction boundary

On Windows under Node 20, existing reparse-point/Junction escapes are rejected, and output parent paths are rechecked immediately before exclusive publication. An active directory replacement by another same-authority process between checks remains outside the threat boundary. A native Win32 handle-relative helper would be required to remove that same-authority replacement race completely.

## Troubleshooting

- **API key not configured:** open Claude Desktop Code plugin settings and populate the sensitive API-key field. Do not paste the key into chat or a shell.
- **Custom Base URL not used:** confirm the plugin setting was saved. Custom endpoints should usually end in `/v1`; no `/v1` segment is added automatically.
- **No approved workspace root:** open the project in Claude Desktop Code and enable the plugin for that project.
- **`OUTPUT_EXISTS`:** choose a new relative output path. The plugin will not overwrite.
- **`SIZE_MISMATCH`:** use the returned actual width and height; the saved image is valid.
- **Preview omitted:** open the returned relative or absolute path; inline previews are limited to 2 MiB.

## Build and test from source

Development commands may install and use development dependencies; they are not part of installed-plugin runtime behavior.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run validate
```

These checks use local fixtures, fakes, and protocol tests. No paid image request is required. **No live provider verification has been performed or claimed.**

## License

MIT © 2026 KPK. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
