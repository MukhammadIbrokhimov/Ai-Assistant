import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRsyncArgs, deployLive, EXCLUDES } from "./deploy-live.mjs";

describe("buildRsyncArgs", () => {
  it("appends trailing slashes to source and dest", () => {
    const args = buildRsyncArgs({ source: "/a", dest: "/b" });
    expect(args[args.length - 2]).toBe("/a/");
    expect(args[args.length - 1]).toBe("/b/");
  });

  it("includes archive + itemize flags", () => {
    const args = buildRsyncArgs({ source: "/a/", dest: "/b/" });
    expect(args).toContain("-a");
    expect(args).toContain("--itemize-changes");
  });

  it("threads --dry-run when requested", () => {
    expect(buildRsyncArgs({ source: "/a/", dest: "/b/", dryRun: true })).toContain("--dry-run");
    expect(buildRsyncArgs({ source: "/a/", dest: "/b/", dryRun: false })).not.toContain("--dry-run");
  });

  it("emits exclude= for each default exclude", () => {
    const args = buildRsyncArgs({ source: "/a/", dest: "/b/" });
    for (const e of EXCLUDES) {
      expect(args).toContain(`--exclude=${e}`);
    }
  });
});

describe("deployLive", () => {
  it("throws when source is not a directory", async () => {
    await expect(deployLive({ source: "/no/such/dir", dest: tmpdir() })).rejects.toThrow(/source/);
  });

  it("throws when dest is not a directory", async () => {
    const src = mkdtempSync(join(tmpdir(), "deploy-live-src-"));
    try {
      await expect(deployLive({ source: src, dest: "/no/such/dest" })).rejects.toThrow(/dest/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("invokes rsync with the built args and forwards stdout", async () => {
    const src = mkdtempSync(join(tmpdir(), "deploy-live-src-"));
    const dst = mkdtempSync(join(tmpdir(), "deploy-live-dst-"));
    try {
      mkdirSync(join(src, "skills"), { recursive: true });
      writeFileSync(join(src, "skills", "a.js"), "x");
      const runner = vi.fn(async () => ({ stdout: "ok", stderr: "" }));
      const res = await deployLive({ source: src, dest: dst, runner });
      expect(runner).toHaveBeenCalledOnce();
      const [cmd, args] = runner.mock.calls[0];
      expect(cmd).toBe("rsync");
      expect(args).toContain("-a");
      expect(args[args.length - 2]).toBe(`${src}/`);
      expect(args[args.length - 1]).toBe(`${dst}/`);
      expect(res.stdout).toBe("ok");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });
});
