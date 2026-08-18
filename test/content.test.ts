import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CONTENT_FILES = [
  "skills/gpt-image-2/SKILL.md",
  "skills/gpt-image-result-handling/SKILL.md",
  "commands/setup.md",
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;

interface FrontmatterDocument {
  attributes: Readonly<Record<string, string>>;
  body: string;
  rawFrontmatter: string;
}

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function parseFrontmatter(source: string, path: string): FrontmatterDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  assert.ok(match, `${path} must start with YAML frontmatter`);
  const rawFrontmatter = match[1] ?? "";
  const attributes: Record<string, string> = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `${path} has invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert.match(key, /^[a-z][a-z0-9-]*$/i, `${path} has invalid key ${key}`);
    assert.notEqual(value, "", `${path} has empty frontmatter value ${key}`);
    assert.equal(attributes[key], undefined, `${path} repeats frontmatter key ${key}`);
    attributes[key] = value;
  }
  return {
    attributes,
    body: source.slice(match[0].length),
    rawFrontmatter,
  };
}

function assertIncludesAll(
  source: string,
  required: readonly string[],
  label: string,
): void {
  for (const value of required) {
    assert.ok(source.includes(value), `${label} must include ${JSON.stringify(value)}`);
  }
}

function assertMatchesAll(
  source: string,
  required: readonly RegExp[],
  label: string,
): void {
  for (const pattern of required) {
    assert.match(source, pattern, `${label} must match ${pattern}`);
  }
}

test("Skills have valid bounded frontmatter and distinct invocation roles", async () => {
  const primaryPath = "skills/gpt-image-2/SKILL.md";
  const resultPath = "skills/gpt-image-result-handling/SKILL.md";
  const primary = parseFrontmatter(await text(primaryPath), primaryPath);
  const result = parseFrontmatter(await text(resultPath), resultPath);

  assert.equal(primary.attributes.name, "gpt-image-2");
  assert.equal(result.attributes.name, "gpt-image-result-handling");
  for (const [path, document] of [
    [primaryPath, primary],
    [resultPath, result],
  ] as const) {
    const description = document.attributes.description;
    assert.ok(description, `${path} must have a description`);
    assert.ok(description.length <= 500, `${path} description must be bounded`);
    assert.ok(
      document.rawFrontmatter.length <= 1024,
      `${path} frontmatter must be at most 1024 characters`,
    );
  }

  assert.notEqual(primary.attributes["user-invocable"], "false");
  assert.equal(result.attributes["user-invocable"], "false");
  assert.match(primary.attributes.description ?? "", /^Use when\b/);
  assert.match(primary.attributes.description ?? "", /explicit/i);
  assert.match(primary.attributes.description ?? "", /image/i);
  assert.match(primary.attributes.description ?? "", /generat|edit/i);
});

test("primary Skill routes explicit image intent safely and accounts for cost", async () => {
  const source = await text("skills/gpt-image-2/SKILL.md");
  assertMatchesAll(
    source,
    [
      /explicit (?:image )?(?:generation|editing|edit) intent/i,
      /\bget_status\b/,
      /\bgenerate_image\b/,
      /\bedit_image\b/,
      /preserve.{0,60}(?:output path|output_path)/is,
      /never overwrite/i,
      /never invent/i,
      /cost|paid/i,
    ],
    "primary Skill",
  );
  assert.doesNotMatch(source, /mcp__[^\s`]+/i);
});

test("internal result Skill preserves returned image facts and warnings", async () => {
  const source = await text("skills/gpt-image-result-handling/SKILL.md");
  assertMatchesAll(
    source,
    [
      /relative path/i,
      /absolute path/i,
      /actual (?:width|dimensions?)/i,
      /SIZE_MISMATCH/,
      /TEMP_CLEANUP_PENDING/,
      /preview.{0,40}(?:omitted|omission|not included)/is,
      /never (?:invent|claim)/i,
    ],
    "result-handling Skill",
  );
  assert.doesNotMatch(source, /mcp__[^\s`]+/i);
});

test("setup command uses only get_status for diagnosis and makes no image request", async () => {
  const source = await text("commands/setup.md");
  const document = parseFrontmatter(source, "commands/setup.md");
  assert.ok(document.attributes.description);
  assert.match(source, /\bget_status\b/);
  assert.doesNotMatch(source, /\bgenerate_image\b|\bedit_image\b/);
  assertMatchesAll(
    source,
    [
      /only.{0,30}\bget_status\b|\bget_status\b.{0,30}only/is,
      /no (?:paid|image) API request was made/i,
      /Claude Desktop Code/i,
      /plugin settings/i,
      /API key/i,
      /Base URL/i,
    ],
    "setup command",
  );
});

test("English README documents supported GUI installation, runtime, safety, and limits", async () => {
  const source = await text("README.md");
  assertIncludesAll(
    source,
    [
      "Claude Desktop Code",
      "Claude Desktop Chat is not supported",
      "project-specific",
      "Node.js 20+",
      "https://api.openai.com/v1",
      "https://api.example.invalid/v1",
      "The only user-facing documentation example is:",
      ".claude/generated-images/gpt-image-2",
      "SIZE_MISMATCH",
      "TEMP_CLEANUP_PENDING",
      "get_status",
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run test:dist",
      "npm --ignore-scripts run validate",
    ],
    "README.md",
  );
  assertMatchesAll(
    source,
    [
      /GUI.{0,120}(?:install|Plugins)|(?:install|Plugins).{0,120}GUI/is,
      /plugin settings.{0,120}API key/is,
      /custom Base URL.{0,240}(?:receives|receive).{0,80}(?:API key|key).{0,120}prompts?.{0,120}edit images/is,
      /custom.{0,100}\/v1.{0,180}(?:not|no).{0,80}(?:append|added)/is,
      /HTTP.{0,220}API key.{0,100}prompts?.{0,100}edit images.{0,100}without transport encryption/is,
      /(?:Git-tracked|tracked).{0,120}(?:copy|files).{0,180}(?:without|no).{0,40}node_modules/is,
      /runtime.{0,160}(?:does not|doesn't|no).{0,80}npm.{0,80}npx.{0,100}node_modules/is,
      /one paid call at a time/i,
      /no (?:SDK|application).{0,80}retr(?:y|ies)/i,
      /never overwrite|no-overwrite/i,
      /1.{0,10}8 edit inputs|one to eight edit inputs/i,
      /mask.{0,80}PNG.{0,100}alpha.{0,140}match.{0,100}dimensions.{0,100}(?:less than|under|<) 4 MiB/is,
      /50 MiB.{0,80}(?:each|per).{0,120}200 MiB.{0,80}aggregate/is,
      /PNG.{0,30}JPEG.{0,30}WebP/is,
      /multiples of 16.{0,160}3840.{0,160}1:3.{0,30}3:1.{0,200}655,360.{0,50}8,294,400/is,
      /2 MiB.{0,100}(?:inline )?preview/is,
      /actual dimensions?.{0,140}(?:preserv|reported|authoritative)/is,
      /existing.{0,80}(?:reparse|junction).{0,120}(?:reject|recheck)/is,
      /same-authority.{0,160}outside.{0,80}(?:boundary|threat)/is,
      /native Win32 handle.{0,80}required/is,
      /get_status.{0,180}(?:no|zero).{0,80}(?:provider|image API)/is,
      /invalid configured Base URL.{0,100}prevents.{0,60}(?:server )?startup.{0,160}plugin settings/is,
      /no live provider verification/i,
      /validation command.{0,100}disables.{0,80}lifecycle hooks/is,
    ],
    "README.md",
  );
});

test("Chinese README documents the same supported surface and exact key rule", async () => {
  const source = await text("README.zh-CN.md");
  assertIncludesAll(
    source,
    [
      "Claude Desktop Code",
      "Claude Desktop Chat 不受支持",
      "项目级",
      "Node.js 20+",
      "https://api.openai.com/v1",
      "https://api.example.invalid/v1",
      "面向用户文档中唯一的自定义端点示例是：",
      ".claude/generated-images/gpt-image-2",
      "SIZE_MISMATCH",
      "TEMP_CLEANUP_PENDING",
      "get_status",
      "PNG",
      "JPEG",
      "WebP",
      "50 MiB",
      "200 MiB",
      "2 MiB",
      "用户 API Key 不能被打印、读取、写入仓库、命令行、.env、.mcp.json、普通 settings、README、prompt 或日志。",
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run test:dist",
      "npm --ignore-scripts run validate",
    ],
    "README.zh-CN.md",
  );
  assertMatchesAll(
    source,
    [
      /GUI.{0,120}(?:安装|插件)|(?:安装|插件).{0,120}GUI/is,
      /插件设置.{0,120}API Key/is,
      /自定义 Base URL.{0,260}(?:接收|收到).{0,100}(?:API Key|密钥).{0,140}(?:prompt|提示词).{0,140}(?:编辑图像|编辑输入图像)/is,
      /自定义.{0,100}\/v1.{0,180}(?:不会|不).{0,80}(?:自动追加|自动补)/is,
      /HTTP.{0,220}API Key.{0,100}prompt.{0,140}编辑输入图像/is,
      /HTTP.{0,220}没有传输加密/is,
      /(?:Git 跟踪|跟踪的).{0,120}(?:副本|文件).{0,180}(?:不含|没有|无需).{0,40}node_modules/is,
      /运行时.{0,180}(?:不需要|不会运行).{0,100}npm.{0,100}npx.{0,120}node_modules/is,
      /同一时间.{0,80}(?:一个|1 个).{0,80}付费调用/is,
      /SDK.{0,80}(?:应用|程序).{0,80}(?:不重试|重试已禁用)/is,
      /不覆盖|禁止覆盖/is,
      /1.{0,10}8.{0,80}(?:编辑输入|输入图像)/is,
      /蒙版.{0,100}PNG.{0,100}alpha.{0,140}尺寸.{0,120}(?:小于|<) 4 MiB/is,
      /16 的倍数.{0,160}3840.{0,160}1:3.{0,30}3:1.{0,200}655,360.{0,50}8,294,400/is,
      /实际尺寸.{0,160}(?:保留|报告|为准)/is,
      /现有.{0,100}(?:重解析点|Junction).{0,160}(?:拒绝|重新检查)/is,
      /同等权限.{0,180}威胁边界之外/is,
      /原生 Win32 句柄.{0,100}(?:才可|需要)/is,
      /get_status.{0,180}(?:不会|零).{0,100}(?:服务商|图像 API)/is,
      /无效.{0,60}Base URL.{0,100}阻止.{0,80}(?:server|服务器).{0,60}启动.{0,160}插件设置/is,
      /未进行.{0,80}实时服务商验证/is,
      /验证命令.{0,100}禁用.{0,100}lifecycle hooks/is,
    ],
    "README.zh-CN.md",
  );
});

test("legal and release files identify the release without unsupported verification claims", async () => {
  const [license, notices, changelog] = await Promise.all([
    text("LICENSE"),
    text("THIRD_PARTY_NOTICES.md"),
    text("CHANGELOG.md"),
  ]);

  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 KPK/);
  assertIncludesAll(
    notices,
    [
      "@jsquash/webp 1.5.0",
      "Apache-2.0",
      "@modelcontextprotocol/sdk 1.30.0",
      "openai 6.49.0",
      "zod 4.4.3",
      "MIT",
      "Copyright (c) 2010, Google Inc.",
      "Copyright (c) 2024 Anthropic, PBC",
      "Copyright 2026 OpenAI",
      "Copyright (c) 2025 Colin McDonnell",
    ],
    "THIRD_PARTY_NOTICES.md",
  );
  assert.match(changelog, /0\.1\.0/);
  assert.match(changelog, /installed-copy/i);
  assert.match(changelog, /Git-(?:tracked|index).{0,120}node_modules/is);
  assert.match(changelog, /strict package validation/i);
  assert.match(changelog, /no paid image API call/i);
  assert.match(changelog, /no live provider verification/i);
  assert.doesNotMatch(
    `${notices}\n${changelog}`,
    /(?:live provider|production endpoint).{0,40}(?:verified|tested successfully)/i,
  );
});

test("user-facing content contains no secret-shaped values or unsupported claims", async () => {
  const entries = await Promise.all(
    CONTENT_FILES.map(async (path) => [path, await text(path)] as const),
  );
  const apiKeyPattern = /sk-[A-Za-z0-9_-]{16,}/g;
  const unsupportedClaims = [
    /Claude Desktop Chat is supported/i,
    /支持 Claude Desktop Chat/i,
    /live provider (?:was )?(?:verified|tested)/i,
    /verified against (?:the )?(?:live|production) (?:provider|API)/i,
    /实时服务商(?:已经|已)(?:验证|测试通过)/,
  ];

  for (const [path, source] of entries) {
    assert.doesNotMatch(source, apiKeyPattern, `${path} contains an API-key-shaped value`);
    apiKeyPattern.lastIndex = 0;
    for (const pattern of unsupportedClaims) {
      assert.doesNotMatch(source, pattern, `${path} contains unsupported claim ${pattern}`);
    }
  }
});
