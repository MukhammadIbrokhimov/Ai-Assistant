import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCronFields, mostRecentFire, checkDrift } from "./check-cron-drift.mjs";

describe("parseCronFields", () => {
  it("parses literals and wildcards", () => {
    expect(parseCronFields("0 9 * * *")).toEqual({
      minute: 0, hour: 9, dom: null, month: null, dow: null,
    });
    expect(parseCronFields("0 10 * * 0")).toMatchObject({ dow: 0 });
  });

  it("rejects non-5-field cron", () => {
    expect(() => parseCronFields("0 9 * *")).toThrow(/5 fields/);
  });

  it("rejects unsupported ranges/lists", () => {
    expect(() => parseCronFields("0 9-17 * * *")).toThrow(/not supported/);
  });
});

describe("mostRecentFire", () => {
  it("daily: returns today at HH:MM if now is past it", () => {
    const now = new Date("2026-05-14T15:00:00");
    const fire = mostRecentFire("0 9 * * *", now);
    expect(fire.toISOString()).toBe(new Date("2026-05-14T09:00:00").toISOString());
  });

  it("daily: returns yesterday if now is before today's slot", () => {
    const now = new Date("2026-05-14T08:00:00");
    const fire = mostRecentFire("0 9 * * *", now);
    expect(fire.toISOString()).toBe(new Date("2026-05-13T09:00:00").toISOString());
  });

  it("weekly Sunday: returns most recent Sunday at 10:00", () => {
    // 2026-05-14 is a Thursday; previous Sunday was 2026-05-10
    const now = new Date("2026-05-14T15:00:00");
    const fire = mostRecentFire("0 10 * * 0", now);
    expect(fire.getDay()).toBe(0);
    expect(fire.toISOString()).toBe(new Date("2026-05-10T10:00:00").toISOString());
  });
});

describe("checkDrift", () => {
  function fixtureRepo() {
    const tmp = mkdtempSync(join(tmpdir(), "cron-drift-"));
    const cronPath = join(tmp, "cron.yaml");
    writeFileSync(cronPath, [
      "jobs:",
      "  - name: daily-loop",
      "    schedule: \"0 9 * * *\"",
      "    skill: orchestrator",
      "  - name: nightly-report",
      "    schedule: \"0 23 * * *\"",
      "    skill: report",
    ].join("\n"));
    return { tmp, cronPath };
  }

  it("flags jobs whose log mtime predates the expected fire by > graceHours", () => {
    const { tmp, cronPath } = fixtureRepo();
    try {
      const now = new Date("2026-05-14T15:00:00");
      const stat = (p) => {
        // daily-loop fired today at 09:00 — pretend log was touched yesterday.
        if (p.endsWith("launchd-daily-loop.log")) return { mtime: new Date("2026-05-13T09:00:30") };
        // nightly-report most recent expected fire is yesterday 23:00 — pretend it ran.
        if (p.endsWith("launchd-nightly-report.log")) return { mtime: new Date("2026-05-13T23:01:00") };
        return null;
      };
      const drifts = checkDrift({ cronYamlPath: cronPath, logsDir: tmp, now, stat });
      expect(drifts).toHaveLength(1);
      expect(drifts[0].name).toBe("daily-loop");
      expect(drifts[0].expectedFire).toBe(new Date("2026-05-14T09:00:00").toISOString());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags jobs whose log file is missing entirely", () => {
    const { tmp, cronPath } = fixtureRepo();
    try {
      const now = new Date("2026-05-14T15:00:00");
      const drifts = checkDrift({ cronYamlPath: cronPath, logsDir: tmp, now, stat: () => null });
      expect(drifts.map(d => d.name).sort()).toEqual(["daily-loop", "nightly-report"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not flag jobs whose log was touched after the expected fire", () => {
    const { tmp, cronPath } = fixtureRepo();
    try {
      const now = new Date("2026-05-14T15:00:00");
      const stat = () => ({ mtime: new Date("2026-05-14T09:00:30") });
      const drifts = checkDrift({ cronYamlPath: cronPath, logsDir: tmp, now, stat });
      const names = drifts.map(d => d.name);
      expect(names).not.toContain("daily-loop");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not flag jobs whose grace window has not elapsed yet", () => {
    const { tmp, cronPath } = fixtureRepo();
    try {
      // 30 min after the expected 09:00 fire — under default 2h grace.
      const now = new Date("2026-05-14T09:30:00");
      const drifts = checkDrift({
        cronYamlPath: cronPath, logsDir: tmp, now,
        stat: () => null, // no logs at all
      });
      expect(drifts.map(d => d.name)).not.toContain("daily-loop");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
