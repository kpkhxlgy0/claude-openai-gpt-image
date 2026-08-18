---
name: gpt-image-2
description: Use when the user has explicit image generation or editing intent and wants GPT Image 2 to create or modify project image files.
---

# GPT Image 2

Use this Skill only for explicit image generation intent or explicit image editing intent. Do not activate it merely because an image is mentioned, inspected, or discussed.

- When diagnosis is needed, call `get_status` before proposing configuration changes. It is the non-paid status tool.
- Use `generate_image` to create one new image and `edit_image` to modify one to eight supplied images, with an optional mask.
- Preserve a user-specified output path as `output_path`. Output paths must remain inside an approved workspace root.
- Never overwrite an existing file. If the requested destination exists, ask for a different path or let the tool choose a unique default.
- Image calls may incur provider cost. Resolve material ambiguity about the prompt, inputs, format, size, and destination before calling a paid tool; do not make speculative calls.
- Treat each tool result as authoritative. Never invent success, paths, dimensions, previews, warnings, usage, or request identifiers.
- Use the declared tool names above; do not guess or hardcode a fully scoped MCP name.

After a successful image call, follow the internal `gpt-image-result-handling` guidance.
