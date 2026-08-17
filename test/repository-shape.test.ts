import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
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
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20");
  assert.deepEqual(pkg.scripts, {
    typecheck: "tsc --noEmit",
    test: "tsx --test test/**/*.test.ts",
    build: "node scripts/build.mjs",
    "test:dist": "tsx --test test/dist/**/*.test.ts",
    validate: "node scripts/validate-package.mjs",
  });
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
    "scripts/validate-package.mjs",
    "src/index.ts",
  ]) {
    await access(path);
  }
});
