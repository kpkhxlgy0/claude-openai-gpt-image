# Claude Desktop Code 的 GPT Image 插件

通过内置的本地 MCP server，在项目中使用 OpenAI GPT Image 模型生成或编辑图像。每次付费调用只写入一张经过验证的新图像，输出限制在已批准的项目工作区内，禁止覆盖现有目标。

[English](README.md)

## 快速开始

1. 安装：运行 `claude plugin marketplace add <repository-url-or-local-path>`，再运行 `claude plugin install gpt-image@kpk-plugins --scope user`（也可以在 Claude Desktop Code 的 **Settings → Plugins** 中安装）。
2. 配置 Key：在交互式 Claude Code 终端运行 `/plugin` → `Installed` → `gpt-image` → `Configure options`，填写敏感字段 **OpenAI API key**，然后重启 Claude Desktop 或新建 Desktop Local 会话。
3. 试一次：运行 `/gpt-image:setup` 确认 `api_key_configured: true`，然后让 Claude“生成一张 1024x1024 的红苹果图标 PNG”（一次付费调用）；文件保存在 `.claude/generated-images/gpt-image/` 下。

## 支持的 Claude 使用界面

本插件面向 Claude Desktop 应用中的项目型 **Claude Desktop Code**。**Claude Desktop Chat 不受支持。** 本插件不是 MCPB，也不是远程 MCP 服务。

## 通过 Claude Desktop Code GUI 安装

GUI 插件安装是首选方式：

1. 在 Claude Desktop Code 中打开目标项目。
2. 打开 GUI 的 **设置 → 插件** 页面；不同 Claude 版本的标签可能略有差异。
3. 将本仓库根目录添加为本地 marketplace，或选择对应仓库来源，然后安装 `gpt-image@kpk-plugins`。
4. 为当前项目启用该插件。插件启用是项目级的；安装后不会自动授权所有项目。
5. 按下文说明，在交互式 Claude Code TUI 中完成配置。不要把 `.mcp.json` 复制到普通 settings。

仓库根目录就是 marketplace 根目录，其中的插件来源为 `./`。

### Claude Code CLI 安装

Claude Code CLI 安装是次要路径。请在交互式 Claude Code 终端中先把仓库或本地 checkout 添加为 marketplace，再按 user scope 安装插件：

```bash
claude plugin marketplace add <repository-url-or-local-path>
```

```bash
claude plugin install gpt-image@kpk-plugins --scope user
```

使用 `--scope user` 时，Claude Code 会为该用户跨项目安装并启用插件；`project` scope 通过项目设置共享，`local` scope 只适用于当前 checkout。安装和启用 scope 不会授予工具权限，也不会把敏感配置移出插件的敏感设置。

### 从 `gpt-image-2` 升级

本插件已从 `gpt-image-2` 更名为 `gpt-image`。如果 `kpk-plugins` marketplace 是通过仓库 URL 添加的，请先运行 `claude plugin marketplace update kpk-plugins` 刷新。然后卸载旧插件并安装新插件：

```bash
claude plugin uninstall gpt-image-2@kpk-plugins
```

```bash
claude plugin install gpt-image@kpk-plugins --scope user
```

插件设置按插件名称分别存储，因此需要在 `gpt-image` 的 `Configure options` 中重新填写 API Key 以及任何自定义 Base URL。然后重启 Claude Desktop 或新建 Desktop Local 会话，并运行 `/gpt-image:setup`。此前生成的图像仍保留在 `.claude/generated-images/gpt-image-2` 下。

## 运行时要求

唯一运行时依赖是 **Node.js 20+**，并且 Claude Desktop Code 所见的 PATH 必须能找到它。已安装插件直接启动预构建的 `dist/server.mjs`。运行时不需要 npm、npx 或 node_modules，也不会运行 lifecycle scripts、源码编译或安装命令。

提交到 Git 的 marketplace 副本包含独立 bundle。installed-copy 测试只启动 Git 跟踪文件，并验证在没有 `node_modules` 目录、也没有 API Key 的情况下 `get_status` 仍可工作。

只有从源码构建和测试的开发者才需要 npm 与开发依赖。

## 在 Claude Code TUI 中配置

Claude Desktop 本身不提供此配置界面。请在交互式 Claude Code 终端中：

1. 运行 `/plugin`。
2. 打开 `Installed`。
3. 选择 `gpt-image`。
4. 选择 `Configure options`。

在 `Configure options` 中，将密钥填入敏感的 **OpenAI API Key** 字段。Manifest 允许该字段暂时留空，使 MCP server 仍可启动并暴露 `tools/list` 和非付费的 `get_status` 工具；生成和编辑仍然需要密钥。能够通过输入验证并进入图片工具执行的有效请求，会在任何服务商请求之前返回 `CONFIG_MISSING`。

保存设置后，重启 Claude Desktop 或新建 Desktop Local 会话，使 MCP 进程加载新配置。

用户 API Key 不能被打印、读取、写入仓库、命令行、.env、.mcp.json、普通 settings、README、prompt 或日志。

默认官方 Base URL 是：

```text
https://api.openai.com/v1
```

自定义 Base URL 会接收 API Key、prompt（提示词）和编辑输入图像（包括蒙版或标注层）。只有在信任该端点及其运营方时才应配置。自定义端点通常应包含 `/v1`；插件不会自动追加或补全它。面向用户文档中唯一的自定义端点示例是：

```text
https://api.example.invalid/v1
```

URL 必须是绝对 HTTP(S) 地址，不能包含用户名或密码、query、fragment、控制字符或首尾空白。仅仅能填写 URL 并不代表端点兼容；该端点必须实现 OpenAI client 所调用的图像 API。

插件允许为受信任的本地或私有网络兼容端点使用 HTTP，但 `http://` 会在没有传输加密的情况下发送 API Key、prompt 和编辑输入图像（包括蒙版或标注层）。只有在信任该网络和端点时才使用 HTTP；其他情况应优先使用 HTTPS。

安装后可运行 `/gpt-image:setup`。该命令只调用 `get_status`，不会发出服务商请求。如果 MCP 状态工具不可用、没有返回当前会话中的真实结果、报告错误或缺少必需状态元数据，setup 会停止；它不会改用 Bash、文件工具、Agent、本地脚本、直接 SDK/HTTP 调用或手写 JSON-RPC。

## 工具

### `get_status`

只返回安全状态：API Key 是否已配置、是否配置了自定义 Base URL、运行中 server 的活动 URL 所对应的 `base_url_valid: true`、已批准工作区根目录、默认模型（`gpt-image-2.6-flare`）、server 版本和默认相对输出目录。无效的已配置 Base URL 会阻止 server 启动；请通过 Claude Code TUI 的 `Configure options` 修正，然后重启 Claude Desktop 或新建 Desktop Local 会话。`get_status` 不会调用服务商或图像 API，也不会返回密钥或 Base URL 的值。

### `generate_image`

使用所选 `model`（默认 `gpt-image-2.6-flare`；也可选择 `gpt-image-2`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare` 和 `gpt-image-2.6-sunburst`）和固定 `n: 1` 生成一张图像，并保存为一个新文件。主要参数包括：

- `prompt`
- `model`：`gpt-image-2`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`（默认）
- `quality`：`auto`、`low`、`medium`、`high`（默认）、`xhigh` 或 `max`；`xhigh` 和 `max` 需要 `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`
- `size`
- `output_format`：`png`（默认）、`jpeg`、`webp`、`gif`（动图）或 `svg`；`gif` 和 `svg` 需要 `gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`
- JPEG/WebP 可选 `output_compression`：0 到 100
- `background`：`auto`（默认）、`opaque` 或 `transparent`
- 可选 `complexity`：`low`、`medium` 或 `high`；需要 `gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`
- GIF 可选 `frame_count`（2 到 16）和 `frame_duration_ms`（20 到 2000）
- `moderation`：`auto` 或 `low`
- 可选相对 `output_path` 和已批准 `workspace_root`

### `edit_image`

按给定顺序接收 1–8 张编辑输入图像，并保存一张新图像。输入支持 PNG、JPEG 和 WebP；GIF 和 SVG 文件不能作为编辑输入。每个输入最多 50 MiB；所有编辑图像与可选蒙版或标注层合计最多 200 MiB。`edit_image` 接受与 `generate_image` 相同的 `model` 和 `background` 参数。它也接受相同的 `quality` 取值、默认值和模型限制，以及相同的 `complexity`、`frame_count` 和 `frame_duration_ms` 参数。它的 `output_format` 可以是 `png`（默认）、`jpeg`、`webp` 或 `gif`；`edit_image` 不能输出 SVG。

可选蒙版必须是 PNG，必须包含 alpha 通道，尺寸必须匹配第一张输入图像，并且小于 4 MiB。蒙版 alpha 只用于标识编辑区域，并不请求透明输出背景。蒙版不能与 GIF 输出或 `markup_path` 同时使用。

可选的 `markup_path` 用于标注引导编辑。标注层必须是包含 alpha 通道的 PNG：一个承载标注、叠加在第一张输入图像上的透明图层。它的尺寸必须与第一张输入图像一致；当第一张输入图像是 JPEG 或 WebP 时，也接受宽高互换的尺寸，使在经过 EXIF 旋转的照片上绘制的标注层仍能匹配。标注层需要 `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`，且不能与 `mask_path` 同时使用。prompt 应描述所需修改、引用标注（例如“红圈内”），并要求从结果中去除标注。

### 模型、质量与背景

默认模型是 `gpt-image-2.6-flare`。结果会报告实际使用的模型；无论选择哪个模型，默认输出目录都是 `.claude/generated-images/gpt-image`。不同模型的费用和输出可能不同。`gpt-image-2.6-sunburst` 和 `gpt-image-2.6-flare` 的请求按 GPT Image 2.6 费率计费。由于默认模型现在是 `gpt-image-2.6-flare`，未设置 `model` 的调用也按该费率计费，费用会随之变化；如需使用其他模型，请显式设置 `model`。

默认 `quality` 是 `high`，每次调用的费用可能高于 API 默认值 `auto`；如需降低费用，请显式设置较低的 `quality`，例如 `medium` 或 `low`。`xhigh` 和 `max` 是费用更高的档位，仅 `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2.6-sunburst` 和 `gpt-image-2.6-flare` 支持。`gpt-image-2` 的透明背景和 `xhigh`/`max` 质量请求会在任何付费调用之前于本地以 `INVALID_INPUT` 被拒绝。

`complexity` 为可选参数，取值为 `low`、`medium` 或 `high`。仅 `gpt-image-2.6-sunburst` 和 `gpt-image-2.6-flare` 支持该参数；其他模型的此类请求会在任何付费调用之前于本地以 `INVALID_INPUT` 被拒绝。省略 `complexity` 时，插件不发送 complexity 字段，由模型默认值（`high`）生效。它与 `quality` 是相互独立的控制项，不会改变 `quality` 的默认值。

透明输出需要 `background: "transparent"`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare` 模型，以及 `png` 或 `webp` 输出格式。API 将 `gpt-image-2` 的透明背景支持标记为预览，因此插件会在任何付费调用之前于本地以 `INVALID_INPUT` 拒绝 `gpt-image-2` 的透明请求。使用 `jpeg`、`gif` 或 `svg` 输出的透明请求也会以同样方式被拒绝。默认的 `background: "auto"` 不会向服务商发送 background 字段。

## 格式、尺寸与输出

- 输出格式：PNG、JPEG、WebP、GIF 动图和 SVG。GIF 和 SVG 需要 `gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`；`generate_image` 可以输出 SVG，`edit_image` 不能。
- 预设尺寸包括 `1024x1024`、横向 `1536x1024` 和纵向 `1024x1536`。工具默认尺寸是 `1024x1024`，也接受 `auto`。
- 自定义 `WIDTHxHEIGHT` 的宽高必须是 16 的倍数；单边最大 3840 像素；宽高比必须在 1:3 到 3:1 之间；总像素必须在 655,360 到 8,294,400 之间。
- GIF 输出时，`size` 描述单帧尺寸。省略 `size` 时插件发送 `auto`；显式 GIF 尺寸的宽高必须是 16 的倍数，单边最大 3840 像素，不受宽高比和总像素限制。
- PNG、GIF 和 SVG 不使用输出压缩；对它们传入非零 `output_compression` 会在任何付费调用之前于本地以 `INVALID_INPUT` 被拒绝。JPEG 和 WebP 接受 0 到 100 的压缩值。
- `frame_count`（2 到 16 的整数，API 默认 9）和 `frame_duration_ms`（20 到 2000 的整数，单位为毫秒，API 默认 200）都是可选参数，只能与 `output_format: "gif"` 一起使用。GIF 输出不能与 `mask_path` 同时使用。
- SVG 输出在保存前会被验证为静态矢量内容。服务商返回的 SVG 若包含脚本、外部引用或嵌入的位图图像，会以 `INVALID_PROVIDER_RESPONSE` 被拒绝，且不会保存任何文件。
- 已保存的 SVG 经过静态矢量内容验证，应作为文件使用：直接打开，或作为图像引用。如需把其源码内联粘贴到网页中，请先审查标记，因为内联后其样式规则和元素 `id` 会作用于所在页面，页面自身的脚本也可能读取其属性。
- 未提供 `output_path` 时，无论选择哪个模型，文件都保存在 `.claude/generated-images/gpt-image` 下，并使用不含 prompt 的唯一文件名。
- 显式输出路径会被保留，但必须是已批准工作区根目录内的相对路径，并使用与请求格式一致的扩展名：`.png`、`.jpg` 或 `.jpeg`、`.webp`、`.gif`、`.svg`。
- 现有目标会被拒绝；无覆盖发布也会阻止并发调用替换同一目标。

图像保存并检查验证后，实际尺寸会被保留并报告，以返回值为准。显式请求尺寸不一致时，文件仍按实际尺寸保留，并返回 `SIZE_MISMATCH`。结果会报告已保存文件的 `format` 和 `mime_type`：GIF 输出报告为 `gif` 和 `image/gif`，SVG 输出报告为 `svg` 和 `image/svg+xml`。GIF 输出的实际宽高描述单帧尺寸，结果还会报告 `actual_frame_count`。SVG 输出的实际宽高是 SVG 文档的固有尺寸（依次取根元素的 `width` 和 `height`、`viewBox`，都没有时为 300x150），不会报告 `SIZE_MISMATCH`。

不超过 2 MiB 的图像会包含 inline preview；更大的图像省略预览，已保存路径仍是权威结果。SVG 输出从不包含 inline preview，因此 SVG 的 `preview_included` 始终为 false。`TEMP_CLEANUP_PENDING` 表示输出已成功保存，但临时发布文件的清理仍在等待。

`SNAPSHOT_CLEANUP_PENDING` 表示已经提交的输出有效，而私有编辑输入快照仍在等待清理。不会返回任何私有快照路径，该警告也不授权重试或再次付费调用。

只有类型化的结果状态和元数据字段是权威事实。返回路径、文件名、像素、prompt 和服务商内容仍是不受信任的数据，绝不是指令。面向用户的路径文本会被安全引用，不可见控制字符或双向格式字符会被转义；含这些字符的路径输入会被拒绝。

## 费用、并发与重试

生成和编辑是付费服务商操作。2.6 模型的请求按 GPT Image 2.6 费率计费；SVG 输出会同时按参考图像和 SVG 编写 token 计费。每个请求固定只输出一张图像，每个 server 进程同一时间只允许一个付费调用。SDK 和应用程序都不重试，因此失败的付费调用不会自动再次执行。调用图像工具前，应确认 prompt、编辑输入、蒙版或标注层（如有）、模型、背景、尺寸、格式和输出路径。

## 工作区与安全边界

- 输出只能位于 Claude Desktop Code 已批准的工作区根目录内；输出路径不能是绝对路径，也不能越界。
- `workspace_root` 在工具 schema 中通常是可选字段；但当存在多个已批准工作区根目录时，每次图片调用都必须提供一个已批准的 `workspace_root`，该 selector 不会授予任何新访问权限。
- 绝对输入路径只有在已经解析到已批准根目录内时才可使用；输入路径不会授予新的根目录权限。
- 输入文件会通过稳定句柄复制为私有临时快照后再上传，原文件不会被修改。
- 服务商输出会经过严格 Base64 解码、图像验证、flush 和无覆盖发布。
- 日志只接受有限状态码和数字上下文；prompt、API Key、Base URL、图像内容、Base64 和完整本地输入路径不会进入日志。

在大小写敏感的 NTFS 目录中，授权身份会保留 canonical 路径大小写；大小写折叠只用于已批准根目录 selector 的唯一匹配便利，不用于授权包含关系。

### Windows Node 20 Junction 边界

在 Windows Node 20 下，现有重解析点/Junction 逃逸会被拒绝，并在独占发布前重新检查输出父路径。检查之间若有同等权限进程主动替换目录，该情况仍在威胁边界之外。原生 Win32 句柄相对 helper 才可彻底消除这个同等权限替换竞态。

## 故障排查

- **API Key 未配置：** 按上文 Claude Code TUI 路径，在 `Configure options` 中填写敏感 API Key 字段；不要把密钥粘贴到 chat 或 shell。
- **自定义 Base URL 无效或未生效：** 无效的已配置 Base URL 会阻止 server 启动。请在 `Configure options` 中修正并确认已保存，然后重启 Claude Desktop 或新建 Desktop Local 会话。自定义端点通常应以 `/v1` 结尾，插件不会自动补全 `/v1`。
- **服务商账户资格：** 使用 GPT Image 模型前，请在服务商账户中完成任何必需的组织验证；插件无法绕过服务商资格控制。
- **服务商限流：** 速率限制响应会作为失败的付费调用返回，且不会自动重试。等待服务商容量或账户限额恢复后，再有意识地发起新请求。
- **MCP 启动失败：** 确认 Claude Desktop Code 可见的 PATH 中有 Node.js 20+、插件已为当前项目启用，并且 Base URL 有效。修正配置后，重启 Claude Desktop 或新建 Desktop Local 会话。
- **没有已批准工作区根目录：** 在 Claude Desktop Code 中打开项目，并为该项目启用插件。
- **`OUTPUT_EXISTS`：** 更换相对输出路径；插件禁止覆盖。
- **`SIZE_MISMATCH`：** 使用返回的实际宽高；已保存图像仍然有效。
- **预览被省略：** 打开返回的相对或绝对路径；inline preview 上限是 2 MiB，SVG 输出始终没有预览。
- **SVG 输出返回 `INVALID_PROVIDER_RESPONSE`：** 服务商返回的 SVG 未通过验证，例如包含脚本、外部引用或嵌入的位图图像。不会保存任何文件，也不会自动重试。

## 从源码构建与测试

以下开发命令可以安装并使用开发依赖，但它们不是已安装插件的运行时行为。验证命令会先禁用 npm 隐式 lifecycle hooks，再检查批准的 scripts 集合是否完全一致。

installed-copy 测试和 package validator 会有意读取 Git index，以验证准确的 marketplace 发布副本，而不是任意工作树内容。validator 会 checkout 完整的 index 源码候选，使用发布 bundler 配置重新构建 `dist/server.mjs`，并要求规范化后的结果与 index 中的 bundle 完全一致。host smoke test 从同一个 index 候选副本开始，只应用临时唯一身份和环境断言 wrapper，随后导入 index 中的 bundle。下面的命令序列假定 index 已代表候选发布版本。在未暂存的发布准备阶段，应使用只包含预期候选文件的临时 `GIT_INDEX_FILE`；不要仅为让验证通过而运行 `git add .`，也不要扰动真实暂存区。

`npm run test:host` 还要求 PATH 中可找到 Claude Code CLI。它使用全新的隔离 Claude 配置和唯一的临时插件身份，通过真实 host 验证 plugin root、未配置的可选 API Key、manifest 默认 Base URL、项目根目录与插件数据目录的替换，然后启动 index 中的 bundle。它只执行 MCP health check：不运行 Claude 模型、不调用图片工具，也不联系图片服务商。插件数据检查会拒绝无关绝对目录，确认标准隔离 `plugins/data` 命名空间，验证同一临时插件身份下的持久性和身份改变后的隔离性，并完成一次私有目录创建/删除探测。每次正向运行都会记录规范化数据路径：同一身份必须精确复用该路径，身份改变后必须得到不同路径；POSIX host 还会检查探测目录未开放 group/other mode bits。wrapper 也会证明无关的 ambient OpenAI SDK 设置在 MCP 子进程边界被清空。

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

这些检查使用本地 fixture、fake 和协议测试，不需要付费图像请求。**未进行任何实时服务商验证，也不作此类声明。**

## 许可证

MIT © 2026 KPK。参见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
