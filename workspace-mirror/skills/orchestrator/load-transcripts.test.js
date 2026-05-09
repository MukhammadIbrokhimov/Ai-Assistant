import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTranscripts } from "./load-transcripts.js";

let drafts;
let log;
beforeEach(() => {
  drafts = mkdtempSync(join(tmpdir(), "lt-"));
  mkdirSync(join(drafts, "whitelist/transcript-cache/lex-fridman"), { recursive: true });
  mkdirSync(join(drafts, "whitelist/audio-cache/lex-fridman"), { recursive: true });
  log = { warn: vi.fn() };
});
afterEach(() => rmSync(drafts, { recursive: true, force: true }));

function writeTranscript(sourceDir, id, extra = {}) {
  const t = {
    source_id: "lex-fridman",
    episode_id: id,
    title: `Title ${id}`,
    language: "en",
    duration_s: 1800,
    transcribed_at: "2026-04-20T12:00:00Z",
    model: "whisper-large-v3",
    segments: [{ t_start: 0, t_end: 1, text: "hello" }],
    ...extra,
  };
  writeFileSync(
    join(drafts, "whitelist/transcript-cache", sourceDir, `${id}.json`),
    JSON.stringify(t),
  );
}
function writeManifest(sourceDir, episodes) {
  writeFileSync(
    join(drafts, "whitelist/audio-cache", sourceDir, "manifest.json"),
    JSON.stringify({ episodes }),
  );
}

describe("loadTranscripts", () => {
  it("returns empty array when transcript-cache root does not exist", () => {
    rmSync(join(drafts, "whitelist/transcript-cache"), { recursive: true });
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toEqual([]);
  });

  it("merges video_path from manifest into each transcript", () => {
    writeTranscript("lex-fridman", "ep1");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "Lex Title 1", duration_s: 1800, published_at: "2026-04-19T00:00:00Z",
        audio_path: "/cache/audio/ep1.m4a", video_path: "/cache/video/ep1.mp4", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toHaveLength(1);
    expect(result[0].episode_id).toBe("ep1");
    expect(result[0].video_path).toBe("/cache/video/ep1.mp4");
    expect(result[0].source_id).toBe("lex-fridman");
  });

  it("warns and skips transcripts whose source has no manifest.json", () => {
    writeTranscript("lex-fridman", "ep1");
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("manifest.json missing for source lex-fridman"),
    );
  });

  it("warns and skips an individual transcript whose episode_id is not in the manifest", () => {
    writeTranscript("lex-fridman", "ep1");
    writeTranscript("lex-fridman", "ghost");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result.map(t => t.episode_id)).toEqual(["ep1"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("no manifest entry for ghost"),
    );
  });

  it("handles multiple sources independently — manifest miss on one does not affect the other", () => {
    mkdirSync(join(drafts, "whitelist/transcript-cache/other-channel"), { recursive: true });
    mkdirSync(join(drafts, "whitelist/audio-cache/other-channel"), { recursive: true });
    writeTranscript("lex-fridman", "epL");
    writeTranscript("other-channel", "epO", { source_id: "other-channel" });
    writeManifest("other-channel", [
      { episode_id: "epO", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v-other", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result.map(t => t.episode_id)).toEqual(["epO"]);
    expect(result[0].video_path).toBe("/v-other");
  });

  it("ignores non-json files in source directories", () => {
    writeFileSync(join(drafts, "whitelist/transcript-cache/lex-fridman/notes.txt"), "ignore me");
    writeTranscript("lex-fridman", "ep1");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toHaveLength(1);
  });
});
