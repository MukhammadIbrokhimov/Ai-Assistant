import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSourceDiscoveryPull } from "./source-discovery-pull.js";

let tmp, workspace;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sdp-"));
  workspace = join(tmp, "workspace");
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(join(workspace, "config/niches.yaml"),
    `niches:\n  ai: { rss: [] }\n  finance: { rss: [] }\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runSourceDiscoveryPull", () => {
  it("invokes runPull(niche) for each niche", async () => {
    const sourceDiscovery = { runPull: vi.fn().mockResolvedValue({ candidatesCount: 2 }) };
    const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
    const res = await runSourceDiscoveryPull({ sourceDiscovery, logger, paths: { workspace } });
    expect(sourceDiscovery.runPull).toHaveBeenCalledTimes(2);
    expect(sourceDiscovery.runPull).toHaveBeenCalledWith("ai");
    expect(sourceDiscovery.runPull).toHaveBeenCalledWith("finance");
    expect(res.nichesRun).toBe(2);
  });

  it("one niche failure does not block others", async () => {
    const runPull = vi.fn()
      .mockResolvedValueOnce({ candidatesCount: 1 })
      .mockRejectedValueOnce(new Error("quota exceeded"));
    const sourceDiscovery = { runPull };
    const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
    const res = await runSourceDiscoveryPull({ sourceDiscovery, logger, paths: { workspace } });
    expect(res.nichesRun).toBe(2);
    expect(res.nichesFailed).toBe(1);
    expect(logger.errorjsonl).toHaveBeenCalledOnce();
  });
});
