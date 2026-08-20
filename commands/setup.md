---
description: Check GPT Image 2 plugin configuration without making a paid image request
---

Invoke only `get_status`, exactly once. Do not invoke any image-generation or image-editing tool as part of setup or diagnosis.

If `get_status` is unavailable, cannot be invoked, or does not return a real current-session MCP tool result, stop. Report that setup could not inspect the plugin; do not infer status from files, prior messages, or other tools.

If the result reports an error or omits any required field, stop. Require the returned fields below to have their documented types before reporting status or giving configuration advice.

Do not use Bash, Write, Agent, local scripts, direct SDK or HTTP calls, or handwritten JSON-RPC as a fallback.

Report these returned fields without guessing or revealing configuration values:

- `api_key_configured`
- `base_url_configured` and `base_url_valid`
- approved `workspace_roots`
- `default_relative_output_dir`
- model and server version

If the API key is missing, direct the user to Claude Desktop Code GUI → plugin settings → GPT Image 2 → OpenAI API key. The key belongs only in the sensitive plugin setting.

If the Base URL is invalid, or the user expected a custom URL but `base_url_configured` is false, direct them to the same plugin settings page. Explain that the default is the official OpenAI Base URL and that a custom endpoint should usually include `/v1` because the plugin does not append it automatically.

Conclude explicitly: **No paid API request was made, and no image API request was made.**
