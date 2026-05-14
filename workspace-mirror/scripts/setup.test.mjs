import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstallTargets, setup } from "./setup.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "setup-test-"));
  mkdirSync(join(root, "workspace-mirror/skills/foo"), { recursive: true });
  mkdirSync(join(root, "workspace-mirror/skills/bar"), { recursive: true });
  mkdirSync(join(root, "workspace-mirror/skills/no-pkg"), { recursive: true });
  mkdirSync(join(root, "workspace-mirror/scripts"), { recursive: true });
  writeFileSync(join(root, "workspace-mirror/skills/foo/package.json"), "{}");
  writeFileSync(join(root, "workspace-mirror/skills/bar/package.json"), "{}");
  writeFileSync(join(root, "workspace-mirror/scripts/package.json"), "{}");
  return root;
}

describe("findInstallTargets", () => {
  it("returns all skills with a package.json plus scripts", () => {
    const root = makeRepo();
    try {
      const targets = findInstallTargets(root).map(p => p.replace(root + "/", ""));
      expect(targets).toContain("workspace-mirror/skills/foo");
      expect(targets).toContain("workspace-mirror/skills/bar");
      expect(targets).toContain("workspace-mirror/scripts");
      expect(targets).not.toContain("workspace-mirror/skills/no-pkg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips skills/ entries without package.json", () => {
    const root = makeRepo();
    try {
      const targets = findInstallTargets(root);
      expect(targets.every(p => !p.endsWith("no-pkg"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("setup", () => {
  it("runs `npm install --no-audit --no-fund` in every target", async () => {
    const root = makeRepo();
    try {
      const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const results = await setup({ repoRoot: root, runner, log: () => {} });
      expect(results).toHaveLength(3);
      expect(results.every(r => r.ok)).toBe(true);
      for (const call of runner.mock.calls) {
        expect(call[0]).toBe("npm");
        expect(call[1]).toEqual(["install", "--no-audit", "--no-fund"]);
        expect(call[2].cwd).toBeTruthy();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports per-target failures without aborting", async () => {
    const root = makeRepo();
    try {
      let calls = 0;
      const runner = vi.fn(async () => {
        calls++;
        if (calls === 2) throw new Error("npm boom");
        return { stdout: "", stderr: "" };
      });
      const results = await setup({ repoRoot: root, runner, log: () => {} });
      expect(results).toHaveLength(3);
      expect(results.filter(r => r.ok)).toHaveLength(2);
      const failed = results.find(r => !r.ok);
      expect(failed.error).toMatch(/npm boom/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
