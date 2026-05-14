import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "bin", "smoke-run.js");

describe("bin/smoke-run.js without ~/.openclaw/workspace/", () => {
  let TMP_HOME;

  beforeEach(() => {
    TMP_HOME = `${tmpdir()}/openclaw-smoke-run-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    rmSync(TMP_HOME, { recursive: true, force: true });
    mkdirSync(TMP_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("exits non-zero with a single-line setup message that names ~/.openclaw/workspace/", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--sandbox"], {
      env: { PATH: process.env.PATH, HOME: TMP_HOME },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const stderr = result.stderr || "";
    expect(stderr).toMatch(/\.openclaw\/workspace/);
    // Must be a focused, actionable message — not a 30-line node stack trace.
    const nonEmptyLines = stderr.split("\n").filter(l => l.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(3);
  });
});
