import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "bin", "discover.js");
const PKG_ROOT = resolve(here, "..");

describe("bin/discover.js startup", () => {
  let TMP_HOME;

  beforeEach(() => {
    TMP_HOME = `${tmpdir()}/openclaw-discover-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    rmSync(TMP_HOME, { recursive: true, force: true });
    mkdirSync(TMP_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("exits non-zero with a focused error naming YOUTUBE_API_KEY when the env var is missing", () => {
    const env = { PATH: process.env.PATH, HOME: TMP_HOME };
    // Intentionally do NOT pass YOUTUBE_API_KEY.
    const result = spawnSync(process.execPath, [SCRIPT, "--niche=ai"], {
      cwd: PKG_ROOT,
      env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const stderr = result.stderr || "";
    expect(stderr).toContain("YOUTUBE_API_KEY");
    const nonEmptyLines = stderr.split("\n").filter(l => l.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(3);
  });
});
