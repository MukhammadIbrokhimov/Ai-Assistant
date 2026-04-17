import { describe, it, expect } from "vitest";
import { matchTopicToEpisode, jaccard, keywords } from "./topic-episode-match.js";

describe("jaccard", () => {
  it("identical sets = 1", () => expect(jaccard(new Set(["a","b"]), new Set(["a","b"]))).toBe(1));
  it("disjoint sets = 0", () => expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0));
  it("half overlap = 1/3", () => expect(jaccard(new Set(["a","b"]), new Set(["b","c"]))).toBeCloseTo(1/3, 3));
});

describe("keywords", () => {
  it("lowercases, tokenizes, removes stopwords, light-stems", () => {
    const kw = keywords("AI Agents replacing Junior Devs");
    expect(kw.has("ai")).toBe(true);
    expect(kw.has("agent")).toBe(true);
    expect(kw.has("replac")).toBe(true);
    expect(kw.has("junior")).toBe(true);
    expect(kw.has("dev")).toBe(true);
    expect(kw.has("the")).toBe(false);
    expect(kw.has("and")).toBe(false);
  });
});

describe("matchTopicToEpisode — keyword fallback path", () => {
  const now = new Date("2026-04-17T12:00:00Z");
  const freshTranscripts = [
    { source_id: "lex", episode_id: "ep-1", title: "Sam Altman on AGI timelines", transcribed_at: "2026-04-16T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "Welcome to the podcast." }] },
    { source_id: "lex", episode_id: "ep-2", title: "AI agents replacing junior devs deep-dive", transcribed_at: "2026-04-15T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "Today we discuss junior devs and AI." }] },
  ];
  const topics = [
    { topic: "AI agents replacing junior devs", source_url: "https://a.test/1", score: 0.9, niche: "ai" },
    { topic: "Crypto rally continues", source_url: "https://a.test/2", score: 0.8, niche: "ai" },
  ];

  it("LLM throws, keyword fallback picks ep-2", async () => {
    const router = { complete: async () => { throw new Error("router down"); } };
    const res = await matchTopicToEpisode(topics, freshTranscripts, router, { now });
    expect(res).not.toBeNull();
    expect(res.topic.topic).toBe("AI agents replacing junior devs");
    expect(res.episode.episode_id).toBe("ep-2");
    expect(res.via).toBe("keyword");
  });

  it("returns null when no recent transcripts", async () => {
    const router = { complete: async () => ({}) };
    const stale = freshTranscripts.map(t => ({ ...t, transcribed_at: "2026-01-01T00:00:00Z" }));
    const res = await matchTopicToEpisode(topics, stale, router, { now });
    expect(res).toBeNull();
  });

  it("returns null when no topic has any keyword overlap", async () => {
    const router = { complete: async () => { throw new Error("skip"); } };
    const unrelated = [{ topic: "Weather forecast Tuesday", source_url: "u", score: 1, niche: "x" }];
    const res = await matchTopicToEpisode(unrelated, freshTranscripts, router, { now });
    expect(res).toBeNull();
  });
});
