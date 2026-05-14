#!/usr/bin/env node
// Detect missed launchd fires. For each job in cron.yaml, compute the most
// recent expected fire time and compare against the mtime of
// ~/openclaw-drafts/logs/launchd-{name}.log. If the log wasn't touched within
// graceHours of the expected fire, flag a drift.
//
// Background: on-battery sleep can skip launchd fires entirely; wake-from-sleep
// catches up only if RunAtLoad=true (we don't use that). M3 §11 wants a
// proactive check so silent skips don't accumulate.

import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// Cron parser: supports literal integer or "*" only. Matches install-cron.mjs's
// supported subset — anything richer should be added in both places at once.
export function parseCronFields(cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${cron}" must have 5 fields (min hour dom month dow)`);
  }
  const [minute, hour, dom, month, dow] = fields;
  const parse = (s, name) => {
    if (s === "*") return null;
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`cron field ${name}="${s}" not supported`);
    return n;
  };
  return {
    minute: parse(minute, "minute"),
    hour: parse(hour, "hour"),
    dom: parse(dom, "dom"),
    month: parse(month, "month"),
    dow: parse(dow, "dow"),
  };
}

// Walk back day-by-day from `now` and return the most recent moment that
// matches the cron fields (or null if no match in the past 8 days).
export function mostRecentFire(cron, now = new Date()) {
  const f = parseCronFields(cron);
  const probe = new Date(now);
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(probe);
    candidate.setHours(f.hour ?? 0, f.minute ?? 0, 0, 0);
    const matches =
      candidate <= now &&
      (f.dow == null || candidate.getDay() === f.dow) &&
      (f.dom == null || candidate.getDate() === f.dom) &&
      (f.month == null || candidate.getMonth() + 1 === f.month);
    if (matches) return candidate;
    probe.setDate(probe.getDate() - 1);
  }
  return null;
}

export function checkDrift({
  cronYamlPath,
  logsDir,
  now = new Date(),
  graceHours = 2,
  stat = (p) => existsSync(p) ? statSync(p) : null,
} = {}) {
  const doc = yaml.load(readFileSync(cronYamlPath, "utf8"));
  const jobs = doc?.jobs ?? [];
  const drifts = [];
  for (const job of jobs) {
    const expected = mostRecentFire(job.schedule, now);
    if (!expected) continue;
    const ageMs = now - expected;
    if (ageMs < 0) continue;
    const graceMs = graceHours * 3600 * 1000;
    const logPath = join(logsDir, `launchd-${job.name}.log`);
    const st = stat(logPath);
    const ranAfterExpected = st && st.mtime >= expected;
    if (!ranAfterExpected && ageMs > graceMs) {
      drifts.push({
        name: job.name,
        schedule: job.schedule,
        expectedFire: expected.toISOString(),
        logMtime: st ? st.mtime.toISOString() : null,
        ageHours: Math.round((ageMs / 3600000) * 10) / 10,
      });
    }
  }
  return drifts;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const drifts = checkDrift({
    cronYamlPath: resolve(here, "../config/cron.yaml"),
    logsDir: `${homedir()}/openclaw-drafts/logs`,
  });
  process.stdout.write(JSON.stringify({ drifts }, null, 2) + "\n");
  if (drifts.length > 0) process.exit(1);
}
