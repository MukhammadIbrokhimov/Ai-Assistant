import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "bin", "orchestrator.js");

describe("bin/orchestrator startup", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "orch-startup-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync("/tmp/openclaw-smoke-startup-test", { recursive: true, force: true });
  });

  it("creates ${DRAFTS}/state/ and ${DRAFTS}/logs/ before exiting on missing --job", () => {
    const result = spawnSync(process.execPath, [BIN], {
      env: { ...process.env, HOME: tmpHome },
    });
    // No --job → orchestrator exits 2, but should have mkdir'd before that.
    expect(result.status).toBe(2);
    expect(existsSync(join(tmpHome, "openclaw-drafts", "state"))).toBe(true);
    expect(existsSync(join(tmpHome, "openclaw-drafts", "logs"))).toBe(true);
  });

  it("sandbox mode creates /tmp/openclaw-smoke/state/ and /logs/ on startup", () => {
    // The bin hardcodes DRAFTS=/tmp/openclaw-smoke when --sandbox is set. We
    // can't redirect it, so just verify those subdirs exist after a startup
    // attempt. Use a unique HOME so we don't disturb a real run.
    rmSync("/tmp/openclaw-smoke/state", { recursive: true, force: true });
    rmSync("/tmp/openclaw-smoke/logs", { recursive: true, force: true });
    const result = spawnSync(process.execPath, [BIN, "--sandbox"], {
      env: { ...process.env, HOME: tmpHome },
    });
    expect(result.status).toBe(2);
    expect(existsSync("/tmp/openclaw-smoke/state")).toBe(true);
    expect(existsSync("/tmp/openclaw-smoke/logs")).toBe(true);
  });
});
