import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "bin/report.js");
const PKG_ROOT = here;
const SANDBOX_DRAFTS = "/tmp/openclaw-smoke";

describe("bin/report.js --sandbox", () => {
  let TMP_HOME;

  beforeEach(() => {
    rmSync(SANDBOX_DRAFTS, { recursive: true, force: true });
    mkdirSync(`${SANDBOX_DRAFTS}/logs`, { recursive: true });
    mkdirSync(`${SANDBOX_DRAFTS}/pending`, { recursive: true });
    mkdirSync(`${SANDBOX_DRAFTS}/approved`, { recursive: true });
    mkdirSync(`${SANDBOX_DRAFTS}/rejected`, { recursive: true });
    writeFileSync(`${SANDBOX_DRAFTS}/logs/router.jsonl`, "");
    writeFileSync(`${SANDBOX_DRAFTS}/logs/rejections.jsonl`, "");

    // HOME with no ~/.openclaw/workspace/ — proves --sandbox does not read live
    // telegram.yaml or import live telegram-client.js. If sandbox path leaks to
    // the live workspace import, this test will fail with module-not-found.
    TMP_HOME = `${tmpdir()}/openclaw-report-test-${process.pid}`;
    rmSync(TMP_HOME, { recursive: true, force: true });
    mkdirSync(TMP_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(SANDBOX_DRAFTS, { recursive: true, force: true });
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("prints digest to stdout and exits 0 without touching live Telegram or workspace config", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--sandbox"], {
      cwd: PKG_ROOT,
      env: { PATH: process.env.PATH, HOME: TMP_HOME },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("🌙 Daily report");
  });
});
