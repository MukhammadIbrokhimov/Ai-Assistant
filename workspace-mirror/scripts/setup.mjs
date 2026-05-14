#!/usr/bin/env node
// One-shot bootstrap: runs `npm install` in every workspace-mirror/skills/*
// and workspace-mirror/scripts/ so `npm test` works from a clean clone.
// Some skills (approval, provider-router) had partial node_modules checked in
// before this script — running setup.mjs once normalizes the tree.

import { readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export function findInstallTargets(repoRoot) {
  const mirror = join(repoRoot, "workspace-mirror");
  const targets = [];
  const skillsDir = join(mirror, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const p = join(skillsDir, name);
      if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) {
        targets.push(p);
      }
    }
  }
  const scriptsDir = join(mirror, "scripts");
  if (existsSync(join(scriptsDir, "package.json"))) targets.push(scriptsDir);
  return targets;
}

export async function setup({ repoRoot, runner = execFileP, log = console.log } = {}) {
  const targets = findInstallTargets(repoRoot);
  const results = [];
  for (const dir of targets) {
    log(`→ npm install (${dir.replace(repoRoot + "/", "")})`);
    try {
      await runner("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
      results.push({ dir, ok: true });
    } catch (err) {
      results.push({ dir, ok: false, error: String(err?.message ?? err) });
    }
  }
  return results;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const results = await setup({ repoRoot });
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFailed in ${failed.length}/${results.length}:`);
    for (const f of failed) console.error(`  ${f.dir}: ${f.error}`);
    process.exit(1);
  }
  console.log(`\n✓ ${results.length} packages installed`);
}
