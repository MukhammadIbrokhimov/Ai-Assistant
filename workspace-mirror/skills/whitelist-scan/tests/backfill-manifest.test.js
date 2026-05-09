import { describe, it, expect, vi } from "vitest";
import { createBackfillManifest } from "../backfill-manifest.js";

function makeDeps(overrides = {}) {
  return {
    listAudio: vi.fn(() => ["epA.m4a", "epB.m4a", "audio-only.m4a"]),
    listVideo: vi.fn(() => ["epA.mp4", "epB.mp4", "video-only.mp4"]),
    fileExists: vi.fn(() => true),
    readManifest: vi.fn(() => null),
    writeManifest: vi.fn(),
    probeDurationS: vi.fn(async () => 3600),
    fetchVideoMeta: vi.fn(async (id) => ({ title: `Title ${id}`, publishedAt: "2026-01-15T00:00:00Z" })),
    sourceId: "lex-fridman",
    audioDir: "/cache/audio-cache/lex-fridman",
    videoDir: "/cache/video-cache/lex-fridman",
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("backfill-manifest", () => {
  it("includes only episodes with both audio and video files", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id).sort();
    expect(ids).toEqual(["epA", "epB"]);
    expect(deps.fetchVideoMeta).toHaveBeenCalledTimes(2);
  });

  it("each entry has the canonical manifest schema fields", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ep = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(ep).toEqual({
      episode_id: "epA",
      title: "Title epA",
      duration_s: 3600,
      published_at: "2026-01-15T00:00:00Z",
      audio_path: "/cache/audio-cache/lex-fridman/epA.m4a",
      video_path: "/cache/video-cache/lex-fridman/epA.mp4",
      video_pruned_at: null,
    });
  });

  it("falls back to episode_id and null published_at when fetchVideoMeta fails", async () => {
    const deps = makeDeps({
      fetchVideoMeta: vi.fn(async () => { throw new Error("network down"); }),
    });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ep = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(ep.title).toBe("epA");
    expect(ep.published_at).toBeNull();
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("skips episode entirely when probeDurationS fails", async () => {
    const probe = vi.fn(async (path) => {
      if (path.includes("epA")) throw new Error("ffprobe failed");
      return 3600;
    });
    const deps = makeDeps({ probeDurationS: probe });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id);
    expect(ids).not.toContain("epA");
    expect(ids).toContain("epB");
  });

  it("merges with existing manifest, preserving entries whose video_path still resolves", async () => {
    const existing = {
      episodes: [
        {
          episode_id: "epA",
          title: "Pre-existing Title",
          duration_s: 1234,
          published_at: "2025-12-01T00:00:00Z",
          audio_path: "/cache/audio-cache/lex-fridman/epA.m4a",
          video_path: "/cache/video-cache/lex-fridman/epA.mp4",
          video_pruned_at: null,
        },
      ],
    };
    const deps = makeDeps({ readManifest: vi.fn(() => existing) });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const epA = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(epA.title).toBe("Pre-existing Title");
    expect(deps.fetchVideoMeta).toHaveBeenCalledTimes(1);
    expect(deps.fetchVideoMeta).toHaveBeenCalledWith("epB");
  });

  it("drops existing entries whose video_path no longer exists on disk", async () => {
    const existing = {
      episodes: [
        {
          episode_id: "ghost",
          title: "Deleted Episode",
          duration_s: 1234,
          published_at: "2025-12-01T00:00:00Z",
          audio_path: "/cache/audio-cache/lex-fridman/ghost.m4a",
          video_path: "/cache/video-cache/lex-fridman/ghost.mp4",
          video_pruned_at: null,
        },
      ],
    };
    const fileExists = vi.fn((p) => !p.includes("ghost"));
    const deps = makeDeps({ readManifest: vi.fn(() => existing), fileExists });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id);
    expect(ids).not.toContain("ghost");
  });

  it("sorts entries by published_at desc with episode_id fallback for nulls", async () => {
    const deps = makeDeps({
      listAudio: vi.fn(() => ["a.m4a", "b.m4a", "c.m4a"]),
      listVideo: vi.fn(() => ["a.mp4", "b.mp4", "c.mp4"]),
      fetchVideoMeta: vi.fn(async (id) => {
        const map = {
          a: { title: "A", publishedAt: "2026-01-01T00:00:00Z" },
          b: { title: "B", publishedAt: "2026-03-01T00:00:00Z" },
          c: { title: "C", publishedAt: null },
        };
        return map[id];
      }),
    });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    expect(result.manifest.episodes.map(e => e.episode_id)).toEqual(["b", "a", "c"]);
  });

  it("writes via writeManifest with the merged manifest", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    await bf.run();
    expect(deps.writeManifest).toHaveBeenCalledTimes(1);
    const written = deps.writeManifest.mock.calls[0][0];
    expect(written.episodes).toHaveLength(2);
  });
});
