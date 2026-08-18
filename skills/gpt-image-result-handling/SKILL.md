---
name: gpt-image-result-handling
description: Internal guidance for reporting saved GPT Image 2 generation and editing results.
user-invocable: false
---

# GPT Image Result Handling

Report only facts returned by the image tool.

- State that the file was saved, then reproduce both the returned relative path and absolute path exactly.
- Report the actual width and height, format, and byte size. Actual dimensions are authoritative even when they differ from the requested size.
- Preserve every warning verbatim. Explain `SIZE_MISMATCH` as a saved image whose actual dimensions differ from the explicit requested dimensions. Explain `TEMP_CLEANUP_PENDING` as a valid saved output with temporary-file cleanup still pending.
- If `preview_included` is false, say that the inline preview was omitted and direct the user to the saved path. Never fabricate a preview or claim that omission means failure.
- If the call fails or returns incomplete metadata, report that limitation. Never invent success, a file path, dimensions, warnings, request IDs, usage, or provider behavior.
- Do not expose Base64 image data or temporary snapshot paths.
