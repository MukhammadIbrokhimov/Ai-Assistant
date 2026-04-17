// NOTE: workspace-mirror/bin/run-job.sh must be chmod +x on the live workspace
// after rsync. The wrapper is invoked by launchd as ProgramArguments[0].
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import yaml from "js-yaml";

export const ALLOWED_SKILLS = ["orchestrator", "report", "whitelist-scan", "archive"];

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

// Parse 5-field cron "min hour dom month dow" into launchd StartCalendarInterval dict.
// Only supports literal integer values or "*" — no ranges, step values, or lists.
// Throws on unsupported forms.
export function cronToCalendarInterval(cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`install-cron: cron "${cron}" must have 5 fields (min hour dom month dow)`);
  }
  const [minute, hour, dom, month, dow] = fields;
  for (const f of [minute, hour, dom, month, dow]) {
    if (f !== "*" && !/^\d+$/.test(f)) {
      throw new Error(`install-cron: cron field "${f}" not supported (only "*" or literal integers)`);
    }
  }
  const out = {};
  if (minute !== "*") out.Minute = Number(minute);
  if (hour !== "*") out.Hour = Number(hour);
  if (dom !== "*") out.Day = Number(dom);
  if (month !== "*") out.Month = Number(month);
  if (dow !== "*") out.Weekday = Number(dow);
  return out;
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CALENDAR_KEY_ORDER = ["Minute", "Hour", "Day", "Weekday", "Month"];

export function renderPlist({ label, argv, calendarInterval, drafts, homeDir }) {
  const argvXml = argv.map(a => `      <string>${escapeXml(a)}</string>`).join("\n");
  const intervalXml = CALENDAR_KEY_ORDER
    .filter(k => calendarInterval[k] !== undefined)
    .map(k => `    <key>${k}</key>\n    <integer>${calendarInterval[k]}</integer>`).join("\n");
  const logPath = `${drafts}/logs/launchd-${label.replace(/^ai\.openclaw\.m3\./, "")}.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argvXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${intervalXml}
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

export function buildArgv(job, { nodePath, workspace }) {
  const skillArgv = buildSkillInvocation(job.skill, job.args, { nodePath, workspace });
  return [`${workspace}/bin/run-job.sh`, ...skillArgv];
}

const LABEL_PREFIX = "ai.openclaw.m3.";

export function plistPathFor(homeDir, jobName) {
  return `${homeDir}/Library/LaunchAgents/${LABEL_PREFIX}${jobName}.plist`;
}

export function listManagedPlists(homeDir, fs) {
  const dir = `${homeDir}/Library/LaunchAgents`;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(LABEL_PREFIX) && f.endsWith(".plist"))
    .map(f => ({
      file: `${dir}/${f}`,
      label: f.replace(/\.plist$/, ""),
      jobName: f.replace(LABEL_PREFIX, "").replace(/\.plist$/, ""),
    }));
}

export function computeDiff(desired, currentPlists, ctx, fs) {
  const desiredByName = new Map();
  for (const d of desired) {
    desiredByName.set(d.name, {
      ...d,
      label: LABEL_PREFIX + d.name,
      path: plistPathFor(ctx.homeDir, d.name),
      argv: buildArgv(d, ctx),
      calendarInterval: cronToCalendarInterval(d.schedule),
    });
  }
  const toAdd = [];
  const toEdit = [];
  const toRemove = [];

  for (const d of desiredByName.values()) {
    const expected = renderPlist({
      label: d.label,
      argv: d.argv,
      calendarInterval: d.calendarInterval,
      drafts: ctx.drafts,
      homeDir: ctx.homeDir,
    });
    const existing = currentPlists.find(p => p.jobName === d.name);
    if (!existing) { toAdd.push({ ...d, content: expected }); continue; }
    const onDisk = fs.readFileSync(existing.file, "utf8");
    if (onDisk !== expected) toEdit.push({ ...d, content: expected });
  }

  for (const p of currentPlists) {
    if (!desiredByName.has(p.jobName)) toRemove.push(p);
  }

  return { toAdd, toEdit, toRemove };
}

export async function installCron({
  yamlPath, homeDir, nodePath, workspace, drafts, fs, runSub, dryRun,
}) {
  const desired = parseYaml(yamlPath);
  const ctx = { homeDir, nodePath, workspace, drafts };
  const current = listManagedPlists(homeDir, fs);
  const diff = computeDiff(desired, current, ctx, fs);

  const actions = [];
  for (const d of diff.toAdd) {
    actions.push({ kind: "add", path: d.path, label: d.label, content: d.content });
  }
  for (const d of diff.toEdit) {
    actions.push({ kind: "edit", path: d.path, label: d.label, content: d.content });
  }
  for (const d of diff.toRemove) {
    actions.push({ kind: "remove", path: d.file, label: d.label });
  }

  if (dryRun) {
    for (const a of actions) {
      console.log(`[${a.kind}] ${a.label} -> ${a.path}`);
    }
    return { plan: actions };
  }

  const uid = process.getuid ? process.getuid() : 0;
  const domain = `gui/${uid}`;

  for (const a of actions) {
    if (a.kind === "add" || a.kind === "edit") {
      try { await runSub("launchctl", ["bootout", `${domain}/${a.label}`]); } catch {}
      fs.mkdirSync(`${homeDir}/Library/LaunchAgents`, { recursive: true });
      fs.writeFileSync(a.path, a.content);
      await runSub("launchctl", ["bootstrap", domain, a.path]);
    } else if (a.kind === "remove") {
      try { await runSub("launchctl", ["bootout", `${domain}/${a.label}`]); } catch {}
      if (fs.existsSync(a.path)) fs.unlinkSync(a.path);
    }
  }

  return { plan: actions, applied: actions.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fsModule = await import("node:fs");
  const execFileAsync = promisify(execFile);

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const HOME = homedir();

  const runSub = (cmd, argv) => execFileAsync(cmd, argv);

  try {
    const res = await installCron({
      yamlPath: `${HOME}/.openclaw/workspace/config/cron.yaml`,
      homeDir: HOME,
      nodePath: process.execPath,
      workspace: `${HOME}/.openclaw/workspace`,
      drafts: `${HOME}/openclaw-drafts`,
      fs: fsModule,
      runSub,
      dryRun,
    });
    console.log(`install-cron: ${dryRun ? "dry-run" : "applied"} ${res.plan.length} operation(s)`);
  } catch (err) {
    console.error("install-cron failed:", err.message);
    process.exit(1);
  }
}
