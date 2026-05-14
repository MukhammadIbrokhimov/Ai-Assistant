#!/usr/bin/env node
// Installs (or removes) the healthchecks.io watchdog launchd job. Unlike
// install-cron.mjs, this uses StartInterval (every N seconds from load time)
// rather than StartCalendarInterval — we want a steady heartbeat, not a
// wall-clock schedule. The watchdog fires every 5 min by default; healthchecks.io
// holds a grace window (typically 15 min) before alerting the user externally.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HEALTHCHECK_LABEL = "ai.openclaw.m3.healthcheck-ping";

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHealthcheckPlist({ label = HEALTHCHECK_LABEL, argv, intervalSec, drafts, homeDir }) {
  const argvXml = argv.map(a => `      <string>${escapeXml(a)}</string>`).join("\n");
  const logPath = `${drafts}/logs/launchd-healthcheck-ping.log`;
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
  <key>StartInterval</key>
  <integer>${intervalSec}</integer>
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
  <true/>
</dict>
</plist>
`;
}

export function plistPath(homeDir) {
  return `${homeDir}/Library/LaunchAgents/${HEALTHCHECK_LABEL}.plist`;
}

export function buildArgv({ nodePath, workspace }) {
  return [
    `${workspace}/bin/run-job.sh`,
    nodePath,
    `${workspace}/scripts/healthcheck-ping.mjs`,
  ];
}

export async function installHealthcheck({
  homeDir, nodePath, workspace, drafts, intervalSec = 300,
  fs, runSub, dryRun = false, uninstall = false,
}) {
  const path = plistPath(homeDir);
  const uid = process.getuid ? process.getuid() : 0;
  const domain = `gui/${uid}`;

  if (uninstall) {
    const action = { kind: "remove", path, label: HEALTHCHECK_LABEL };
    if (dryRun) return { plan: [action] };
    try { await runSub("launchctl", ["bootout", `${domain}/${HEALTHCHECK_LABEL}`]); } catch {}
    if (fs.existsSync(path)) fs.unlinkSync(path);
    return { plan: [action], applied: 1 };
  }

  const content = renderHealthcheckPlist({
    argv: buildArgv({ nodePath, workspace }),
    intervalSec,
    drafts,
    homeDir,
  });

  const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
  const kind = existing === null ? "add" : existing === content ? "noop" : "edit";
  const action = { kind, path, label: HEALTHCHECK_LABEL, content };

  if (dryRun || kind === "noop") return { plan: [action], applied: 0 };

  try { await runSub("launchctl", ["bootout", `${domain}/${HEALTHCHECK_LABEL}`]); } catch {}
  fs.mkdirSync(`${homeDir}/Library/LaunchAgents`, { recursive: true });
  fs.writeFileSync(path, content);
  await runSub("launchctl", ["bootstrap", domain, path]);
  return { plan: [action], applied: 1 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fsModule = await import("node:fs");
  const execFileAsync = promisify(execFile);

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const HOME = homedir();

  try {
    const res = await installHealthcheck({
      homeDir: HOME,
      nodePath: process.execPath,
      workspace: `${HOME}/.openclaw/workspace`,
      drafts: `${HOME}/openclaw-drafts`,
      fs: fsModule,
      runSub: (cmd, argv) => execFileAsync(cmd, argv),
      dryRun,
      uninstall,
    });
    const verb = dryRun ? "dry-run" : uninstall ? "uninstalled" : "applied";
    console.log(`install-healthcheck: ${verb} (${res.plan[0].kind})`);
  } catch (err) {
    console.error("install-healthcheck failed:", err.message);
    process.exit(1);
  }
}
