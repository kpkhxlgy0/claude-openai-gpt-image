import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("repository root is the single marketplace plugin", async () => {
  const marketplace = await json(".claude-plugin/marketplace.json");
  assert.equal(marketplace.name, "kpk-plugins");
  assert.deepEqual(
    marketplace.plugins.map((p: { name: string; source: string }) => ({
      name: p.name,
      source: p.source,
    })),
    [{ name: "gpt-image-2", source: "./" }],
  );
});

test("package scripts and engines match the scaffold contract", async () => {
  const pkg = await json("package.json");
  assert.equal(pkg.name, "claude-openai-gpt-image");
  assert.equal(pkg.version, "0.1.1");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20");
  assert.deepEqual(pkg.scripts, {
    typecheck: "tsc --noEmit",
    test: "tsx --test test/**/*.test.ts",
    build: "node scripts/build.mjs",
    "test:dist": "tsx --test test/dist/**/*.test.ts",
    "test:host": "tsx --test test/host/**/*.smoke.ts",
    validate: "node scripts/validate-package.mjs",
  });
});

test("release version is synchronized across source and package metadata", async () => {
  const [pkg, lock, plugin, marketplace, entrypoint] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    json(".claude-plugin/plugin.json"),
    json(".claude-plugin/marketplace.json"),
    readFile("src/index.ts", "utf8"),
  ]);

  assert.equal(pkg.version, "0.1.1");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.match(entrypoint, /const SERVER_VERSION = "0\.1\.1";/);
});

test("production entry point delegates process tool-context wiring", async () => {
  const entrypoint = await readFile("src/index.ts", "utf8");

  assert.match(
    entrypoint,
    /import \{ createProcessToolContext \} from "\.\/process-context\.ts";/,
  );
  assert.match(entrypoint, /const context = createProcessToolContext\(\{/);
  assert.doesNotMatch(entrypoint, /processPaidCallGate|paidCallGate\s*:/);
});

test("marketplace owner is KPK and plugin version matches package", async () => {
  const marketplace = await json(".claude-plugin/marketplace.json");
  const plugin = await json(".claude-plugin/plugin.json");
  const pkg = await json("package.json");
  assert.equal(marketplace.owner.name, "KPK");
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins[0].author.name, "KPK");
});

test("required scaffold files exist", async () => {
  for (const path of [
    ".gitignore",
    "tsconfig.json",
    "scripts/build.mjs",
    "scripts/git-index.mjs",
    "scripts/git-index.d.mts",
    "scripts/validate-package.mjs",
    "src/index.ts",
    "dist/server.mjs",
  ]) {
    await access(path);
  }
});

test("dist/server.mjs is not gitignored and is tracked for marketplace installs", () => {
  let ignored = false;
  try {
    git(["check-ignore", "-q", "dist/server.mjs"]);
    ignored = true;
  } catch {
    ignored = false;
  }
  assert.equal(
    ignored,
    false,
    "dist/server.mjs must not be ignored so marketplace checkouts ship the bundled server",
  );

  const tracked = git(["ls-files", "--", "dist/server.mjs"]);
  assert.equal(
    tracked.replaceAll("\\", "/"),
    "dist/server.mjs",
    "dist/server.mjs must be tracked so Git marketplace installs include the runtime entry point",
  );
});

test(".gitignore ignores dist contents but allows dist/server.mjs", async () => {
  const ignore = await readFile(".gitignore", "utf8");
  const lines = ignore.split(/\r?\n/).map((line) => line.trim());
  assert.ok(
    lines.includes("dist/*") || lines.includes("dist/"),
    ".gitignore must ignore other dist contents",
  );
  assert.ok(
    lines.includes("!dist/server.mjs"),
    ".gitignore must explicitly un-ignore dist/server.mjs",
  );
});
