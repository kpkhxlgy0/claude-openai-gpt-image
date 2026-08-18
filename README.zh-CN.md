# Claude Desktop Code 的 GPT Image 2 插件

通过内置的本地 MCP server，在项目中使用 OpenAI GPT Image 2 生成或编辑图像。每次付费调用只写入一张经过验证的新图像，输出限制在已批准的项目工作区内，禁止覆盖现有目标。

[English](README.md)

## 支持的 Claude 使用界面

本插件面向 Claude Desktop 应用中的项目型 **Claude Desktop Code**。**Claude Desktop Chat 不受支持。** 本插件不是 MCPB，也不是远程 MCP 服务。

## 通过 Claude Desktop Code GUI 安装

GUI 插件安装是首选方式：

1. 在 Claude Desktop Code 中打开目标项目。
2. 打开 GUI 的 **设置 → 插件** 页面；不同 Claude 版本的标签可能略有差异。
3. 将本仓库根目录添加为本地 marketplace，或选择对应仓库来源，然后安装 `gpt-image-2@kpk-plugins`。
4. 为当前项目启用该插件。插件启用是项目级的；安装后不会自动授权所有项目。
5. 打开插件设置完成配置。不要把 `.mcp.json` 复制到普通 settings。

仓库根目录就是 marketplace 根目录，其中的插件来源为 `./`。

## 运行时要求

唯一运行时依赖是 **Node.js 20+**，并且 Claude Desktop Code 所见的 PATH 必须能找到它。已安装插件直接启动预构建的 `dist/server.mjs`。运行时不需要 npm、npx 或 node_modules，也不会运行 lifecycle scripts、源码编译或安装命令。

只有从源码构建和测试的开发者才需要 npm 与开发依赖。

## 在 GUI 中配置

请在插件设置的敏感 **OpenAI API Key** 字段中填写密钥。

用户 API Key 不能被打印、读取、写入仓库、命令行、.env、.mcp.json、普通 settings、README、prompt 或日志。

默认官方 Base URL 是：

```text
https://api.openai.com/v1
```

自定义 Base URL 会接收 API Key、prompt（提示词）和编辑输入图像。只有在信任该端点及其运营方时才应配置。自定义端点通常应包含 `/v1`；插件不会自动追加或补全它。文档和测试中唯一的自定义端点示例是：

```text
https://api.example.invalid/v1
```

URL 必须是绝对 HTTP(S) 地址，不能包含用户名或密码、query、fragment、控制字符或首尾空白。仅仅能填写 URL 并不代表端点兼容；该端点必须实现 OpenAI client 所调用的图像 API。

安装后可运行 `/gpt-image-2:setup`。该命令只调用 `get_status`，不会发出服务商请求。

## 工具

### `get_status`

只返回安全状态：API Key 是否已配置、Base URL 是否已配置/有效、已批准工作区根目录、模型、server 版本和默认相对输出目录。`get_status` 不会调用服务商或图像 API，也不会返回密钥或 Base URL 的值。

### `generate_image`

使用固定模型 `gpt-image-2` 和固定 `n: 1` 生成一张图像，并保存为一个新文件。主要参数包括：

- `prompt`
- `quality`：`auto`、`low`、`medium`、`high`
- `size`
- `output_format`：`png`、`jpeg`、`webp`
- JPEG/WebP 可选 `output_compression`：0 到 100
- `moderation`：`auto` 或 `low`
- 可选相对 `output_path` 和已批准 `workspace_root`

### `edit_image`

按给定顺序接收 1–8 张编辑输入图像，并保存一张新图像。输入支持 PNG、JPEG 和 WebP。每个输入最多 50 MiB；所有编辑图像与可选蒙版合计最多 200 MiB。

可选蒙版必须是 PNG，必须包含 alpha 通道，尺寸必须匹配第一张输入图像，并且小于 4 MiB。透明输出背景不受支持；蒙版 alpha 只用于标识编辑区域。

## 格式、尺寸与输出

- 输出格式：PNG、JPEG、WebP。
- 工具默认尺寸是 `1024x1024`，也接受 `auto`。
- 自定义 `WIDTHxHEIGHT` 的宽高必须是 16 的倍数；单边最大 3840 像素；宽高比必须在 1:3 到 3:1 之间；总像素必须在 655,360 到 8,294,400 之间。
- PNG 不使用输出压缩；JPEG 和 WebP 接受 0 到 100 的压缩值。
- 未提供 `output_path` 时，文件保存在 `.claude/generated-images/gpt-image-2` 下，并使用不含 prompt 的唯一文件名。
- 显式输出路径会被保留，但必须是已批准工作区根目录内的相对路径，并使用与请求格式一致的扩展名。
- 现有目标会被拒绝；无覆盖发布也会阻止并发调用替换同一目标。

图像保存并解码验证后，实际尺寸会被保留并报告，以返回值为准。显式请求尺寸不一致时，文件仍按实际尺寸保留，并返回 `SIZE_MISMATCH`。

不超过 2 MiB 的图像会包含 inline preview；更大的图像省略预览，已保存路径仍是权威结果。`TEMP_CLEANUP_PENDING` 表示输出已成功保存，但临时发布文件的清理仍在等待。

## 费用、并发与重试

生成和编辑是付费服务商操作。每个请求固定只输出一张图像，每个 server 进程同一时间只允许一个付费调用。SDK 和应用程序都不重试，因此失败的付费调用不会自动再次执行。调用图像工具前，应确认 prompt、编辑输入、尺寸、格式和输出路径。

## 工作区与安全边界

- 输出只能位于 Claude Desktop Code 已批准的工作区根目录内；输出路径不能是绝对路径，也不能越界。
- 绝对输入路径只有在已经解析到已批准根目录内时才可使用；输入路径不会授予新的根目录权限。
- 输入文件会通过稳定句柄复制为私有临时快照后再上传，原文件不会被修改。
- 服务商输出会经过严格 Base64 解码、图像验证、flush 和无覆盖发布。
- 日志只接受有限状态码和数字上下文；prompt、API Key、Base URL、图像内容、Base64 和完整本地输入路径不会进入日志。

### Windows Node 20 Junction 边界

在 Windows Node 20 下，现有重解析点/Junction 逃逸会被拒绝，并在独占发布前重新检查输出父路径。检查之间若有同等权限进程主动替换目录，该情况仍在威胁边界之外。原生 Win32 句柄相对 helper 才可彻底消除这个同等权限替换竞态。

## 故障排查

- **API Key 未配置：** 打开 Claude Desktop Code 的插件设置，填写敏感 API Key 字段；不要把密钥粘贴到 chat 或 shell。
- **自定义 Base URL 未生效：** 确认插件设置已保存。自定义端点通常应以 `/v1` 结尾，插件不会自动补全 `/v1`。
- **没有已批准工作区根目录：** 在 Claude Desktop Code 中打开项目，并为该项目启用插件。
- **`OUTPUT_EXISTS`：** 更换相对输出路径；插件禁止覆盖。
- **`SIZE_MISMATCH`：** 使用返回的实际宽高；已保存图像仍然有效。
- **预览被省略：** 打开返回的相对或绝对路径；inline preview 上限是 2 MiB。

## 从源码构建与测试

以下开发命令可以安装并使用开发依赖，但它们不是已安装插件的运行时行为：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run validate
```

这些检查使用本地 fixture、fake 和协议测试，不需要付费图像请求。**未进行任何实时服务商验证，也不作此类声明。**

## 许可证

MIT © 2026 KPK。参见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
