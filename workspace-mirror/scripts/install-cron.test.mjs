import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { computeDiff, buildSkillInvocation, ALLOWED_SKILLS } from "./install-cron.mjs";

describe("buildSkillInvocation", () => {
  it("returns absolute argv for orchestrator daily-loop", () => {
    const argv = buildSkillInvocation(
      "orchestrator",
      { job: "daily-loop" },
      { nodePath: "/opt/homebrew/bin/node", workspace: "/Users/u/.openclaw/workspace" }
    );
    expect(argv[0]).toBe("/opt/homebrew/bin/node");
    expect(argv[1]).toBe("/Users/u/.openclaw/workspace/skills/orchestrator/bin/orchestrator.js");
    expect(argv).toContain("--job=daily-loop");
  });

  it("never contains literal ~", () => {
    const argv = buildSkillInvocation(
      "orchestrator",
      { job: "flush-quiet-queue" },
      { nodePath: "/opt/homebrew/bin/node", workspace: "/home/user/.openclaw/workspace" }
    );
    for (const a of argv) expect(a).not.toMatch(/~/);
  });

  it("rejects disallowed skills", () => {
    expect(() =>
      buildSkillInvocation("malicious-thing", { job: "x" }, { nodePath: "/n", workspace: "/w" })
    ).toThrow(/not in allow-list/);
  });

  it("ALLOWED_SKILLS list matches plan", () => {
    expect(ALLOWED_SKILLS).toEqual(["orchestrator", "report", "whitelist-scan", "archive"]);
  });
});

describe("computeDiff", () => {
  const ctx = { nodePath: "/n", workspace: "/w" };
  const desired = [
    { name: "daily-loop", schedule: "0 9 * * *", skill: "orchestrator", args: { job: "daily-loop" }, description: "daily" },
    { name: "nightly-report", schedule: "0 23 * * *", skill: "report", args: { job: "nightly" }, description: "report" },
  ];

  it("add missing + remove stale", () => {
    const actual = [{ name: "openclaw-managed-old-job", schedule: "0 1 * * *", message: "[]" }];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toAdd.map(j => j.name)).toEqual(["daily-loop", "nightly-report"]);
    expect(diff.toRemove.map(j => j.name)).toEqual(["openclaw-managed-old-job"]);
    expect(diff.toEdit).toEqual([]);
  });

  it("ignore unmanaged jobs", () => {
    const actual = [{ name: "user-personal-job", schedule: "0 3 * * *", message: "[]" }];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toRemove).toEqual([]);
  });

  it("edit on schedule change", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 8 * * *", message: JSON.stringify(buildSkillInvocation("orchestrator", { job: "daily-loop" }, ctx)) },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toEdit.map(j => j.name)).toEqual(["daily-loop"]);
  });

  it("edit on message change", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 9 * * *", message: "[]" },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toEdit.map(j => j.name)).toEqual(["daily-loop"]);
  });

  it("no-op when everything matches", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 9 * * *", message: JSON.stringify(buildSkillInvocation("orchestrator", { job: "daily-loop" }, ctx)) },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toEdit).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });
});

describe("installCron — shape validation", () => {
  it("throws when cron list JSON has unexpected shape (no name field)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "ic-"));
    writeFileSync(join(tmp, "cron.yaml"), `jobs:\n  - name: daily-loop\n    schedule: "0 9 * * *"\n    skill: orchestrator\n    args: { job: daily-loop }\n    description: d\n`);
    const runSub = async () => ({ stdout: JSON.stringify([{ cron: "0 9 * * *" }]), stderr: "" });
    const { installCron } = await import("./install-cron.mjs");
    await expect(installCron({
      yamlPath: join(tmp, "cron.yaml"),
      openClawBin: "/fake/openclaw",
      nodePath: "/fake/node",
      workspace: "/fake/ws",
      runSub,
      dryRun: true,
    })).rejects.toThrow(/missing 'name'/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts wrapped { jobs: [...] } shape", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "ic2-"));
    writeFileSync(join(tmp, "cron.yaml"), `jobs:\n  - name: daily-loop\n    schedule: "0 9 * * *"\n    skill: orchestrator\n    args: { job: daily-loop }\n    description: d\n`);
    const runSub = async () => ({ stdout: JSON.stringify({ jobs: [] }), stderr: "" });
    const { installCron } = await import("./install-cron.mjs");
    const res = await installCron({
      yamlPath: join(tmp, "cron.yaml"),
      openClawBin: "/fake/openclaw",
      nodePath: "/fake/node",
      workspace: "/fake/ws",
      runSub,
      dryRun: true,
    });
    expect(res.plan.length).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});
