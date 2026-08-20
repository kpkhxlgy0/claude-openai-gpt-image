import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[name];
  }
  return env;
}

function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeGitBlob(
  cwd: string,
  contents: string,
  env: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    env,
    input: contents,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function copyTrackedWorkingTree(destination: string): Promise<void> {
  const tracked = runGit(projectRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
  ])
    .split("\0")
    .filter(Boolean);

  for (const relativePath of tracked) {
    const target = path.join(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(projectRoot, relativePath)));
  }
}

async function linkDevelopmentDependencies(fixtureRoot: string): Promise<void> {
  await symlink(
    path.join(projectRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

test("package validator rejects invalid candidate files staged only in the Git index", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-validator-index-"),
  );
  const gitEnv = isolatedGitEnvironment();

  try {
    await copyTrackedWorkingTree(fixtureRoot);
    runGit(fixtureRoot, ["init", "--quiet"], gitEnv);
    runGit(fixtureRoot, ["add", "--all", "--force", "--", "."], gitEnv);
    await linkDevelopmentDependencies(fixtureRoot);

    const pluginPath = path.join(
      fixtureRoot,
      ".claude-plugin",
      "plugin.json",
    );
    const safePlugin = await readFile(pluginPath, "utf8");
    const stagedPlugin = JSON.parse(safePlugin);
    stagedPlugin.userConfig.openai_api_key.required = true;
    await writeFile(pluginPath, `${JSON.stringify(stagedPlugin, null, 2)}\n`);
    runGit(
      fixtureRoot,
      ["add", "--", ".claude-plugin/plugin.json"],
      gitEnv,
    );
    await writeFile(pluginPath, safePlugin);

    const skillPath = path.join(
      fixtureRoot,
      "skills",
      "gpt-image-2",
      "SKILL.md",
    );
    const safeSkill = await readFile(skillPath, "utf8");
    const credentialShapedValue = "unsafe" + "_candidate_1234567890";
    await writeFile(
      skillPath,
      `${safeSkill}\nOPENAI_API_KEY=${credentialShapedValue}\n`,
    );
    runGit(fixtureRoot, ["add", "--", "skills/gpt-image-2/SKILL.md"], gitEnv);
    await writeFile(skillPath, safeSkill);

    const distPath = path.join(fixtureRoot, "dist", "server.mjs");
    const safeDist = await readFile(distPath);
    await writeFile(distPath, "this is not valid JavaScript\n");
    runGit(fixtureRoot, ["add", "--", "dist/server.mjs"], gitEnv);
    await writeFile(distPath, safeDist);

    const result = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.notEqual(
      result.status,
      0,
      `validator accepted index metadata that differs from the safe working tree:\n${output}`,
    );
    assert.match(
      output,
      /plugin\.json must define the exact optional-at-startup sensitive API-key configuration/,
    );
    assert.match(
      output,
      /tracked file contains a credential-shaped assignment: skills\/gpt-image-2\/SKILL\.md/,
    );
    assert.match(output, /dist\/server\.mjs must pass node --check/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("package validator rejects an indexed bundle that diverges from indexed sources", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-validator-bundle-"),
  );
  const gitEnv = isolatedGitEnvironment();

  try {
    await copyTrackedWorkingTree(fixtureRoot);
    runGit(fixtureRoot, ["init", "--quiet"], gitEnv);
    runGit(fixtureRoot, ["add", "--all", "--force", "--", "."], gitEnv);
    await linkDevelopmentDependencies(fixtureRoot);

    const baseline = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const baselineOutput = `${baseline.stdout ?? ""}\n${baseline.stderr ?? ""}`;
    assert.equal(
      baseline.status,
      0,
      `validator rejected a clean bundle built from indexed sources:\n${baselineOutput}`,
    );

    const distPath = path.join(fixtureRoot, "dist", "server.mjs");
    const safeDist = await readFile(distPath, "utf8");
    await writeFile(
      distPath,
      `${safeDist}\nvoid "staged-only-bundle-divergence";\n`,
    );
    runGit(fixtureRoot, ["add", "--", "dist/server.mjs"], gitEnv);
    await writeFile(distPath, safeDist);

    const result = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.notEqual(
      result.status,
      0,
      `validator accepted an indexed bundle that differs from indexed source:\n${output}`,
    );
    assert.match(
      output,
      /dist\/server\.mjs must match the deterministic build from indexed sources/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Git-index blobs are read by object ID even when a path resembles stage syntax", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-index-reader-"),
  );
  const gitEnv = isolatedGitEnvironment();

  try {
    runGit(fixtureRoot, ["init", "--quiet"], gitEnv);
    const ambiguousBlob = writeGitBlob(
      fixtureRoot,
      "ambiguous-path-index-blob\n",
      gitEnv,
    );

    const {
      parseGitIndexEntries,
      readGitBlobText,
    } = await import("../scripts/git-index.mjs");
    const entries = parseGitIndexEntries(
      `100644 ${ambiguousBlob} 0\t0:leak.txt\0`,
    );
    assert.deepEqual(entries, [
      {
        mode: "100644",
        objectId: ambiguousBlob,
        stage: 0,
        path: "0:leak.txt",
      },
    ]);
    assert.equal(
      readGitBlobText(fixtureRoot, ambiguousBlob, gitEnv),
      "ambiguous-path-index-blob\n",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("package validator binds every indexed manifest to release 0.1.1", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-validator-version-"),
  );
  const gitEnv = isolatedGitEnvironment();

  try {
    await copyTrackedWorkingTree(fixtureRoot);
    runGit(fixtureRoot, ["init", "--quiet"], gitEnv);
    runGit(fixtureRoot, ["add", "--all", "--force", "--", "."], gitEnv);
    await linkDevelopmentDependencies(fixtureRoot);

    const packagePath = path.join(fixtureRoot, "package.json");
    const lockPath = path.join(fixtureRoot, "package-lock.json");
    const pluginPath = path.join(
      fixtureRoot,
      ".claude-plugin",
      "plugin.json",
    );
    const marketplacePath = path.join(
      fixtureRoot,
      ".claude-plugin",
      "marketplace.json",
    );
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const plugin = JSON.parse(await readFile(pluginPath, "utf8"));
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    packageJson.version = "0.1.2";
    lock.version = "0.1.2";
    lock.packages[""].version = "0.1.2";
    plugin.version = "0.1.2";
    marketplace.plugins[0].version = "0.1.2";
    await Promise.all([
      writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
      writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`),
      writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`),
      writeFile(
        marketplacePath,
        `${JSON.stringify(marketplace, null, 2)}\n`,
      ),
    ]);
    runGit(
      fixtureRoot,
      [
        "add",
        "--",
        "package.json",
        "package-lock.json",
        ".claude-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
      ],
      gitEnv,
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.notEqual(
      result.status,
      0,
      `validator accepted a release version other than 0.1.1:\n${output}`,
    );
    assert.match(output, /package\.json version must be exactly 0\.1\.1/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("package validator rejects non-regular and unmerged Git-index entries", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "gpt-image-validator-index-mode-"),
  );
  const gitEnv = isolatedGitEnvironment();

  try {
    await copyTrackedWorkingTree(fixtureRoot);
    runGit(fixtureRoot, ["init", "--quiet"], gitEnv);
    runGit(fixtureRoot, ["add", "--all", "--force", "--", "."], gitEnv);
    await linkDevelopmentDependencies(fixtureRoot);

    const linkBlob = writeGitBlob(fixtureRoot, "LICENSE", gitEnv);
    runGit(
      fixtureRoot,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "120000",
        linkBlob,
        "README.md",
      ],
      gitEnv,
    );
    const linkResult = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const linkOutput = `${linkResult.stdout ?? ""}\n${linkResult.stderr ?? ""}`;
    assert.notEqual(linkResult.status, 0, linkOutput);
    assert.match(
      linkOutput,
      /unsupported Git-index mode 120000: README\.md/,
    );

    runGit(
      fixtureRoot,
      ["update-index", "--force-remove", "--", "README.md"],
      gitEnv,
    );
    const baseBlob = writeGitBlob(fixtureRoot, "base README\n", gitEnv);
    const indexInfo = `100644 ${baseBlob} 1\tREADME.md\0`;
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: fixtureRoot,
      env: gitEnv,
      input: indexInfo,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const unmergedResult = spawnSync(
      process.execPath,
      ["scripts/validate-package.mjs"],
      {
        cwd: fixtureRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const unmergedOutput = `${unmergedResult.stdout ?? ""}\n${unmergedResult.stderr ?? ""}`;
    assert.notEqual(unmergedResult.status, 0, unmergedOutput);
    assert.match(
      unmergedOutput,
      /Git-index entry must be unique stage 0: README\.md/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
