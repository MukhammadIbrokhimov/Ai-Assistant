import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillInvocation,
  ALLOWED_SKILLS,
  cronToCalendarInterval,
  renderPlist,
  computeDiff,
  installCron,
  listManagedPlists,
  plistPathFor,
} from "./install-cron.mjs";

describe("buildSkillInvocation", () => {
  it("returns absolute argv for orchestrator daily-loop", () => {
    const argv = buildSkillInvocation("orchestrator", { job: "daily-loop" }, { nodePath: "/opt/homebrew/bin/node", workspace: "/Users/u/.openclaw/workspace" });
    expect(argv[0]).toBe("/opt/homebrew/bin/node");
    expect(argv[1]).toBe("/Users/u/.openclaw/workspace/skills/orchestrator/bin/orchestrator.js");
    expect(argv).toContain("--job=daily-loop");
  });

  it("never contains literal ~", () => {
    const argv = buildSkillInvocation("orchestrator", { job: "flush-quiet-queue" }, { nodePath: "/opt/homebrew/bin/node", workspace: "/home/u/.openclaw/workspace" });
    for (const a of argv) expect(a).not.toMatch(/~/);
  });

  it("rejects disallowed skills", () => {
    expect(() => buildSkillInvocation("malicious-thing", { job: "x" }, { nodePath: "/n", workspace: "/w" })).toThrow(/not in allow-list/);
  });

  it("ALLOWED_SKILLS list matches plan", () => {
    expect(ALLOWED_SKILLS).toEqual(["orchestrator", "report", "whitelist-scan", "archive"]);
  });
});

describe("cronToCalendarInterval", () => {
  it("0 9 * * * -> {Hour:9, Minute:0}", () => {
    expect(cronToCalendarInterval("0 9 * * *")).toEqual({ Hour: 9, Minute: 0 });
  });
  it("0 10 * * 0 -> {Hour:10, Minute:0, Weekday:0}", () => {
    expect(cronToCalendarInterval("0 10 * * 0")).toEqual({ Hour: 10, Minute: 0, Weekday: 0 });
  });
  it("rejects ranges", () => {
    expect(() => cronToCalendarInterval("0 9-17 * * *")).toThrow(/not supported/);
  });
  it("rejects step values", () => {
    expect(() => cronToCalendarInterval("*/5 * * * *")).toThrow(/not supported/);
  });
  it("rejects wrong field count", () => {
    expect(() => cronToCalendarInterval("0 9 *")).toThrow(/5 fields/);
  });
});

describe("renderPlist", () => {
  it("produces well-formed plist with StartCalendarInterval", () => {
    const out = renderPlist({
      label: "ai.openclaw.m3.daily-loop",
      argv: ["/bin/node", "/w/skills/orchestrator/bin/orchestrator.js", "--job=daily-loop"],
      calendarInterval: { Hour: 9, Minute: 0 },
      drafts: "/u/openclaw-drafts",
      homeDir: "/u",
    });
    expect(out).toContain("<key>Label</key>");
    expect(out).toContain("<string>ai.openclaw.m3.daily-loop</string>");
    expect(out).toContain("<key>Hour</key>");
    expect(out).toContain("<integer>9</integer>");
    expect(out).toContain("<key>StandardOutPath</key>");
    expect(out).toContain("/u/openclaw-drafts/logs/launchd-daily-loop.log");
    expect(out).toContain("--job=daily-loop");
  });

  it("xml-escapes special characters in paths", () => {
    const out = renderPlist({
      label: "test",
      argv: ["/bin/node", "/w/path with & special.js"],
      calendarInterval: { Hour: 0, Minute: 0 },
      drafts: "/u/d",
      homeDir: "/u",
    });
    expect(out).toContain("&amp;");
    expect(out).not.toMatch(/\/w\/path with & special/);
  });
});

describe("computeDiff (launchd)", () => {
  let tmp, home;
  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "ic-"));
    home = tmp;
    mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true });
  }
  function teardown() {
    rmSync(tmp, { recursive: true, force: true });
  }

  const desired = [
    { name: "daily-loop", schedule: "0 9 * * *", skill: "orchestrator", args: { job: "daily-loop" }, description: "daily" },
    { name: "nightly-report", schedule: "0 23 * * *", skill: "report", args: { job: "nightly" }, description: "report" },
  ];

  it("add missing + remove stale", () => {
    setup();
    try {
      const ctx = { nodePath: "/n", workspace: "/w", drafts: "/d", homeDir: home };
      writeFileSync(`${home}/Library/LaunchAgents/ai.openclaw.m3.old-job.plist`, "<stale/>");
      const current = listManagedPlists(home, { readdirSync, existsSync });
      const diff = computeDiff(desired, current, ctx, { readFileSync, existsSync });
      expect(diff.toAdd.map(d => d.name).sort()).toEqual(["daily-loop", "nightly-report"]);
      expect(diff.toRemove.map(p => p.jobName)).toEqual(["old-job"]);
    } finally { teardown(); }
  });

  it("ignores unmanaged plists (without prefix)", () => {
    setup();
    try {
      writeFileSync(`${home}/Library/LaunchAgents/com.example.other.plist`, "<other/>");
      const current = listManagedPlists(home, { readdirSync, existsSync });
      expect(current).toEqual([]);
    } finally { teardown(); }
  });

  it("no-op when existing plist matches exactly", () => {
    setup();
    try {
      const ctx = { nodePath: "/n", workspace: "/w", drafts: "/d", homeDir: home };
      const argv = [`/w/bin/run-job.sh`, "/n", "/w/skills/orchestrator/bin/orchestrator.js", "--job=daily-loop"];
      const expected = renderPlist({
        label: "ai.openclaw.m3.daily-loop",
        argv,
        calendarInterval: { Hour: 9, Minute: 0 },
        drafts: "/d",
        homeDir: home,
      });
      writeFileSync(`${home}/Library/LaunchAgents/ai.openclaw.m3.daily-loop.plist`, expected);
      const current = listManagedPlists(home, { readdirSync, existsSync });
      const diff = computeDiff([desired[0]], current, ctx, { readFileSync, existsSync });
      expect(diff.toAdd).toEqual([]);
      expect(diff.toEdit).toEqual([]);
      expect(diff.toRemove).toEqual([]);
    } finally { teardown(); }
  });

  it("edit when existing plist differs", () => {
    setup();
    try {
      const ctx = { nodePath: "/n", workspace: "/w", drafts: "/d", homeDir: home };
      writeFileSync(`${home}/Library/LaunchAgents/ai.openclaw.m3.daily-loop.plist`, "<different/>");
      const current = listManagedPlists(home, { readdirSync, existsSync });
      const diff = computeDiff([desired[0]], current, ctx, { readFileSync, existsSync });
      expect(diff.toEdit.map(d => d.name)).toEqual(["daily-loop"]);
    } finally { teardown(); }
  });
});

describe("installCron (dry-run)", () => {
  it("prints planned actions without spawning launchctl", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ic2-"));
    try {
      const home = tmp;
      mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true });
      const yamlPath = join(tmp, "cron.yaml");
      writeFileSync(yamlPath, `jobs:\n  - name: daily-loop\n    schedule: "0 9 * * *"\n    skill: orchestrator\n    args: { job: daily-loop }\n    description: d\n`);

      let subCalls = 0;
      const runSub = async () => { subCalls++; return { stdout: "", stderr: "" }; };
      const fs = { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync: () => {} };
      const res = await installCron({
        yamlPath, homeDir: home, nodePath: "/n", workspace: "/w", drafts: "/d",
        fs, runSub, dryRun: true,
      });
      expect(res.plan.length).toBe(1);
      expect(res.plan[0].kind).toBe("add");
      expect(subCalls).toBe(0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
