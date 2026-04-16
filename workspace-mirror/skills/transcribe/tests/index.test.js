import { describe, it, expect, vi } from "vitest";
import { createTranscribe } from "../index.js";

const FAKE_SRT = `1
00:00:00,000 --> 00:00:03,200
Welcome to the podcast.

2
00:00:03,200 --> 00:00:07,800
Today's guest is Sam Altman.
`;

function makeDeps(overrides = {}) {
  return {
    unloadOllama: vi.fn(async () => true),
    runWhisper: vi.fn(async () => FAKE_SRT),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T13:14:00Z"),
    transcriptRoot: "/tmp/transcripts",
    modelPath: "/fake/model.bin",
    ...overrides,
  };
}

describe("transcribe", () => {
  it("unloads Ollama before calling whisper", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(deps.unloadOllama).toHaveBeenCalled();
    const unloadOrder = deps.unloadOllama.mock.invocationCallOrder[0];
    const whisperOrder = deps.runWhisper.mock.invocationCallOrder[0];
    expect(unloadOrder).toBeLessThan(whisperOrder);
  });

  it("parses SRT into segments with correct timestamps", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    const result = await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(result.transcript.segments).toEqual([
      { t_start: 0.0, t_end: 3.2, text: "Welcome to the podcast." },
      { t_start: 3.2, t_end: 7.8, text: "Today's guest is Sam Altman." },
    ]);
  });

  it("writes Transcript JSON to expected path", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      "/tmp/transcripts/lex/ep1.json",
      expect.stringContaining('"episode_id": "ep1"')
    );
  });

  it("emits language field and whisper-large-v3 as model", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    const r = await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(r.transcript.language).toBe("en");
    expect(r.transcript.model).toBe("whisper-large-v3");
  });
});
