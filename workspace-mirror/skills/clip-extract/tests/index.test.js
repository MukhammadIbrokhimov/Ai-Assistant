import { describe, it, expect, vi } from "vitest";
import { createClipExtract } from "../index.js";

const TRANSCRIPT = {
  source_id: "lex-fridman",
  episode_id: "ep999",
  title: "Lex Fridman #999",
  language: "en",
  duration_s: 7200,
  transcribed_at: "2026-04-16T13:14:00Z",
  model: "whisper-large-v3",
  segments: [
    { t_start: 1830.0, t_end: 1832.5, text: "AI agents won't replace junior devs." },
    { t_start: 1832.5, t_end: 1837.0, text: "They'll create them." },
  ],
};

let deps;

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass }) => {
        if (taskClass === "reason") {
          return {
            text: JSON.stringify([
              { start_s: 1830.0, end_s: 1877.0, reasoning: "hook quote", hook_quote: "AI agents won't replace junior devs" },
            ]),
            tokens_in: 5000, tokens_out: 200,
          };
        }
        if (taskClass === "write") {
          const calls = deps.router.complete.mock.calls.length;
          if (calls === 2) return { text: "Sam Altman on why agents won't replace devs.", tokens_in: 100, tokens_out: 30 };
          if (calls === 3) return { text: "#ai #agents #dev #coding #future #software #tech #growth #career #podcast", tokens_in: 50, tokens_out: 20 };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    runFfmpeg: vi.fn(async () => true),
    writeDraft: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T13:20:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-clip-001",
    ...overrides,
  };
}

describe("clip-extract", () => {
  it("produces a clip Draft with mode=clip and media/0.mp4", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    const result = await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    expect(result.draft.mode).toBe("clip");
    expect(result.draft.media[0].path).toBe("media/0.mp4");
    expect(result.draft.source).toBeTruthy();
    expect(result.draft.source.clip_range).toEqual([1830.0, 1877.0]);
  });

  it("writes clip-local SRT before invoking ffmpeg", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    const srtWriteIdx = deps.writeFileSync.mock.calls.findIndex(c => /clip\.srt$/.test(c[0]));
    expect(srtWriteIdx).toBeGreaterThanOrEqual(0);
    const ffmpegOrder = deps.runFfmpeg.mock.invocationCallOrder[0];
    const srtWriteOrder = deps.writeFileSync.mock.invocationCallOrder[srtWriteIdx];
    expect(srtWriteOrder).toBeLessThan(ffmpegOrder);
  });

  it("passes start_s, end_s, video path, srt path to ffmpeg", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    const [args] = deps.runFfmpeg.mock.calls[0];
    expect(args).toMatchObject({
      startS: 1830.0,
      endS: 1877.0,
      inputPath: "/fake/ep999.mp4",
      outputPath: expect.stringContaining("0.mp4"),
      srtPath: expect.stringContaining("clip.srt"),
    });
  });

  it("draft.source.attribution_template renders with episode title substituted", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    const { draft } = await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    expect(draft.source.attribution).toContain("Lex Fridman #999");
  });
});
