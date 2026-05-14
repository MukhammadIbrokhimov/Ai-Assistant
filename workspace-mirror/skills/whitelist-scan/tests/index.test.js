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
    transcribe: { run: vi.fn(async () => ({ transcript: {}, path: "/fake.json" })) },
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
    expect(deps.transcribe.run).not.toHaveBeenCalled();
    expect(result.downloaded).toBe(0);
  });

  it("invokes transcribe.run for each newly downloaded episode with correct args", async () => {
    const deps = makeDeps();
    const scan = createWhitelistScan(deps);
    const result = await scan.run();

    expect(deps.transcribe.run).toHaveBeenCalledTimes(1);
    const callArgs = deps.transcribe.run.mock.calls[0][0];
    expect(callArgs).toEqual({
      audioPath: "/tmp/whitelist-cache/audio-cache/lex-fridman/vid1.m4a",
      sourceId: "lex-fridman",
      episodeId: "vid1",
      title: "Episode 999",
      durationS: 7200,
    });
    expect(result.transcribed).toBe(1);
    expect(result.transcribe_failed).toBe(0);
  });

  it("skips episode (no manifest entry, no downloaded++) when transcribe throws, continues with next episode", async () => {
    const deps = makeDeps({
      listNewVideos: vi.fn(async () => [
        { id: "fail1", title: "Will fail", duration_s: 60, published_at: "2026-04-15T10:00:00Z" },
        { id: "ok1", title: "Will succeed", duration_s: 120, published_at: "2026-04-15T11:00:00Z" },
      ]),
      transcribe: {
        run: vi.fn(async ({ episodeId }) => {
          if (episodeId === "fail1") throw new Error("whisper crashed");
          return { transcript: {}, path: "/fake.json" };
        }),
      },
    });
    const scan = createWhitelistScan(deps);
    const result = await scan.run();

    // Both episodes attempted
    expect(deps.transcribe.run).toHaveBeenCalledTimes(2);
    // Manifest written, but only the successful episode is in it
    expect(deps.writeManifest).toHaveBeenCalledTimes(1);
    const writtenManifest = deps.writeManifest.mock.calls[0][1];
    expect(writtenManifest.episodes).toHaveLength(1);
    expect(writtenManifest.episodes[0].episode_id).toBe("ok1");
    // Counters reflect outcome
    expect(result.downloaded).toBe(1);
    expect(result.transcribed).toBe(1);
    expect(result.transcribe_failed).toBe(1);
    // Source still marked as scanned (don't keep listing the same episodes forever)
    expect(deps.sourcesStore.updateLastScanned).toHaveBeenCalled();
  });

  it("transcribe runs AFTER both downloads complete", async () => {
    const callOrder = [];
    const deps = makeDeps({
      downloadAudio: vi.fn(async () => { callOrder.push("audio"); }),
      downloadVideo: vi.fn(async () => { callOrder.push("video"); }),
      transcribe: { run: vi.fn(async () => { callOrder.push("transcribe"); }) },
    });
    const scan = createWhitelistScan(deps);
    await scan.run();
    expect(callOrder).toEqual(["audio", "video", "transcribe"]);
  });
});
