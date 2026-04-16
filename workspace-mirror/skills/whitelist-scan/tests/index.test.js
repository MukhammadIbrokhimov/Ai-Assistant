import { describe, it, expect, vi } from "vitest";
import { createWhitelistScan } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    sourcesStore: {
      list: vi.fn(() => [{
        id: "lex-fridman",
        url: "https://www.youtube.com/@lexfridman",
        poll_frequency_h: 24,
        lastScanned: null,
      }]),
      updateLastScanned: vi.fn(),
    },
    listNewVideos: vi.fn(async () => [
      { id: "vid1", title: "Episode 999", duration_s: 7200, published_at: "2026-04-15T10:00:00Z" },
    ]),
    downloadAudio: vi.fn(async (videoId, dest) => dest),
    downloadVideo: vi.fn(async (videoId, dest) => dest),
    readManifest: vi.fn(() => ({ episodes: [] })),
    writeManifest: vi.fn(),
    mkdirp: vi.fn(),
    freeSpaceBytes: vi.fn(async () => 10 * 1024 * 1024 * 1024),
    now: () => new Date("2026-04-16T13:00:00Z"),
    cacheRoot: "/tmp/whitelist-cache",
    minFreeGb: 5,
    ...overrides,
  };
}

describe("whitelist-scan", () => {
  it("downloads new episodes audio+video and updates manifest", async () => {
    const deps = makeDeps();
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.downloadAudio).toHaveBeenCalledTimes(1);
    expect(deps.downloadVideo).toHaveBeenCalledTimes(1);
    expect(deps.sourcesStore.updateLastScanned).toHaveBeenCalledWith("lex-fridman", expect.any(String));
    expect(result.downloaded).toBe(1);
  });

  it("skips source whose poll_frequency_h hasn't elapsed", async () => {
    const deps = makeDeps({
      sourcesStore: {
        list: vi.fn(() => [{
          id: "lex-fridman",
          url: "https://www.youtube.com/@lexfridman",
          poll_frequency_h: 24,
          lastScanned: "2026-04-16T10:00:00Z",
        }]),
        updateLastScanned: vi.fn(),
      },
    });
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.listNewVideos).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("aborts with error when free space < 5 GB", async () => {
    const deps = makeDeps({
      freeSpaceBytes: vi.fn(async () => 2 * 1024 * 1024 * 1024),
    });
    const scan = createWhitelistScan(deps);
    await expect(scan.run()).rejects.toThrow(/free space/i);
  });

  it("deduplicates by episode_id in manifest", async () => {
    const deps = makeDeps({
      readManifest: vi.fn(() => ({ episodes: [{ episode_id: "vid1", audio_path: "/cached/vid1.m4a" }] })),
    });
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.downloadAudio).not.toHaveBeenCalled();
    expect(result.downloaded).toBe(0);
  });
});
