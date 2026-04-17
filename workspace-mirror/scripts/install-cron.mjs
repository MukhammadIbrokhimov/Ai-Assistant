import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import yaml from "js-yaml";

export const ALLOWED_SKILLS = ["orchestrator", "report", "whitelist-scan", "archive"];
const NAME_PREFIX = "openclaw-managed-";

const SKILL_ENTRY_BIN = {
  orchestrator: "skills/orchestrator/bin/orchestrator.js",
  report: "skills/report/bin/report.js",
  "whitelist-scan": "skills/whitelist-scan/bin/scan.js",
  archive: "skills/archive/bin/archive.js",
};

function argsToCliFlags(args = {}) {
  return Object.entries(args).map(([k, v]) => `--${k}=${v}`);
}

export function buildSkillInvocation(skill, args, { nodePath, workspace }) {
  if (!ALLOWED_SKILLS.includes(skill)) {
    throw new Error(`install-cron: skill "${skill}" not in allow-list`);
  }
  const rel = SKILL_ENTRY_BIN[skill];
  return [nodePath, `${workspace}/${rel}`, ...argsToCliFlags(args)];
}

function parseYaml(path) {
  const doc = yaml.load(readFileSync(path, "utf8"));
  const jobs = doc?.jobs ?? [];
  for (const j of jobs) {
    if (!j.name || !j.schedule || !j.skill) {
      throw new Error(`install-cron: job missing name/schedule/skill: ${JSON.stringify(j)}`);
    }
    if (!ALLOWED_SKILLS.includes(j.skill)) {
      throw new Error(`install-cron: skill "${j.skill}" not in allow-list`);
    }
  }
  return jobs;
}

export function computeDiff(desired, actualAll, ctx) {
  const actual = actualAll.filter(a => a.name.startsWith(NAME_PREFIX));
  const byName = new Map(actual.map(a => [a.name, a]));
  const toAdd = [];
  const toEdit = [];
  const toRemove = [];
  const desiredNames = new Set();

  for (const d of desired) {
    const managedName = NAME_PREFIX + d.name;
    desiredNames.add(managedName);
    const argv = buildSkillInvocation(d.skill, d.args, ctx);
    const msg = JSON.stringify(argv);
    const existing = byName.get(managedName);
    if (!existing) {
      toAdd.push({ ...d, managedName, argv, message: msg });
    } else if (existing.schedule !== d.schedule || existing.message !== msg) {
      toEdit.push({ ...d, managedName, argv, message: msg });
    }
  }

  for (const a of actual) {
    if (!desiredNames.has(a.name)) toRemove.push(a);
  }

  return { toAdd, toEdit, toRemove };
}

export async function installCron({
  yamlPath, openClawBin, nodePath, workspace, runSub, dryRun,
}) {
  const desired = parseYaml(yamlPath);
  const ctx = { nodePath, workspace };

  const listResult = await runSub(openClawBin, ["cron", "list", "--json"]);
  let actual;
  try { actual = JSON.parse(listResult.stdout || "[]"); }
  catch (e) { throw new Error(`install-cron: 'openclaw cron list --json' did not return JSON: ${e.message}`); }
  if (!Array.isArray(actual)) actual = actual.jobs ?? [];
  for (const a of actual) {
    if (typeof a.name !== "string") {
      throw new Error(`install-cron: 'actual' job missing 'name' field: ${JSON.stringify(a)}`);
    }
  }

  const diff = computeDiff(desired, actual, ctx);
  const plan = [];

  for (const j of diff.toAdd) {
    plan.push(["cron", "add", "--name", j.managedName, "--cron", j.schedule, "--message", j.message, "--description", j.description ?? ""]);
  }
  for (const j of diff.toEdit) {
    plan.push(["cron", "edit", "--name", j.managedName, "--cron", j.schedule, "--message", j.message]);
  }
  for (const j of diff.toRemove) {
    plan.push(["cron", "rm", "--name", j.name]);
  }

  if (dryRun) {
    for (const a of plan) console.log(openClawBin, ...a);
    return { plan };
  }

  for (const a of plan) await runSub(openClawBin, a);
  return { plan, applied: plan.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const HOME = homedir();

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const runSub = (cmd, argv) => execFileAsync(cmd, argv);

  try {
    const res = await installCron({
      yamlPath: `${HOME}/.openclaw/workspace/config/cron.yaml`,
      openClawBin: "/opt/homebrew/bin/openclaw",
      nodePath: process.execPath,
      workspace: `${HOME}/.openclaw/workspace`,
      runSub,
      dryRun,
    });
    console.log(`install-cron: ${dryRun ? "dry-run" : "applied"} ${res.plan.length} operation(s)`);
  } catch (err) {
    console.error("install-cron failed:", err.message);
    process.exit(1);
  }
}
