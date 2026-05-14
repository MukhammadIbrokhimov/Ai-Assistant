import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWhitelistScan } from "../index.js";
import { createTranscribe } from "../../transcribe/index.js";
import { loadTranscripts } from "../../orchestrator/load-transcripts.js";

// Proves the path threading from bin/scan.js → transcribe → transcript-cache → loadTranscripts
// stays in sync. This is the chain that broke in openclaw-80w: download happened,
// transcript file never appeared, daily-loop saw empty clip pool.
describe("whitelist-scan → transcribe → loadTranscripts (integration)", () => {
  let draftsRoot;
  beforeEach(() => { draftsRoot = mkdtempSync(join(tmpdir(), "ws-int-")); });
  afterEach(() => { rmSync(draftsRoot, { recursive: true, force: true }); });

  it("scan output is consumable by loadTranscripts", async () => {
    const cacheRoot = join(draftsRoot, "whitelist");
    const transcriptRoot = join(cacheRoot, "transcript-cache");

    const fakeSrt = `1
00:00:00,000 --> 00:00:03,200
Welcome to the show.

2
00:00:03,200 --> 00:00:07,800
Today's guest is Sam.
`;

    const transcribe = createTranscribe({
      unloadOllama: vi.fn(async () => true),
      runWhisper: vi.fn(async () => fakeSrt),
      writeFileSync,
      mkdirp: (p) => mkdirSync(p, { recursive: true }),
      now: () => new Date("2026-04-16T13:14:00Z"),
      transcriptRoot,
    });

    const scan = createWhitelistScan({
      sourcesStore: {
        list: () => [{
          id: "lex-fridman",
          url: "https://www.youtube.com/@lexfridman",
          poll_frequency_h: 24,
          lastScanned: null,
        }],
        updateLastScanned: vi.fn(),
      },
      listNewVideos: vi.fn(async () => [
        { id: "vid1", title: "Episode 999", duration_s: 120, published_at: "2026-04-15T10:00:00Z" },
      ]),
      downloadAudio: vi.fn(async (id, dest) => writeFileSync(dest, "fake audio")),
      downloadVideo: vi.fn(async (id, dest) => writeFileSync(dest, "fake video")),
      transcribe,
      readManifest: (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { episodes: [] },
      writeManifest: (p, m) => writeFileSync(p, JSON.stringify(m, null, 2)),
      mkdirp: (p) => mkdirSync(p, { recursive: true }),
      freeSpaceBytes: async () => 10 * 1024 * 1024 * 1024,
      now: () => new Date("2026-04-16T13:00:00Z"),
      cacheRoot,
    });

    const result = await scan.run();

    expect(result.downloaded).toBe(1);
    expect(result.transcribed).toBe(1);

    // The transcript file is at the path loadTranscripts will look for it
    const transcriptPath = join(transcriptRoot, "lex-fridman", "vid1.json");
    expect(existsSync(transcriptPath)).toBe(true);

    // And loadTranscripts can read it, merging with the manifest
    const transcripts = loadTranscripts({ draftsRoot, log: { warn: vi.fn() } });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({
      source_id: "lex-fridman",
      episode_id: "vid1",
      title: "Episode 999",
      duration_s: 120,
      segments: [
        { t_start: 0.0, t_end: 3.2, text: "Welcome to the show." },
        { t_start: 3.2, t_end: 7.8, text: "Today's guest is Sam." },
      ],
    });
    // video_path is merged from the manifest, as load-transcripts requires
    expect(transcripts[0].video_path).toBe(join(cacheRoot, "video-cache", "lex-fridman", "vid1.mp4"));
  });
});
