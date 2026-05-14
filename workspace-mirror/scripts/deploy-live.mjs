#!/usr/bin/env node
// Sync workspace-mirror/ → ~/.openclaw/workspace/ so launchd plists picking up
// `${HOME}/.openclaw/workspace/skills/.../bin/*.js` see post-merge code.
// Without --delete: live-only files (HEARTBEAT.md, state/, USER.md…) are preserved.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

export const EXCLUDES = [
  "node_modules",
  ".git",
  ".DS_Store",
  "*.test.js",
  "*.test.mjs",
  "tests/",
];

export function buildRsyncArgs({ source, dest, dryRun = false, excludes = EXCLUDES }) {
  if (!source.endsWith("/")) source += "/";
  if (!dest.endsWith("/")) dest += "/";
  const args = ["-a", "--itemize-changes"];
  if (dryRun) args.push("--dry-run");
  for (const e of excludes) args.push(`--exclude=${e}`);
  args.push(source, dest);
  return args;
}

export async function deployLive({
  source,
  dest,
  dryRun = false,
  runner = (cmd, args) => execFileP(cmd, args),
} = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = source ?? resolve(here, "..");
  const dst = dest ?? `${homedir()}/.openclaw/workspace`;

  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`deploy-live: source "${src}" not a directory`);
  }
  if (!existsSync(dst) || !statSync(dst).isDirectory()) {
    throw new Error(`deploy-live: dest "${dst}" not a directory (run setup first)`);
  }

  const args = buildRsyncArgs({ source: src, dest: dst, dryRun });
  const { stdout, stderr } = await runner("rsync", args);
  return { stdout, stderr, args };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const { stdout, stderr } = await deployLive({ dryRun });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
