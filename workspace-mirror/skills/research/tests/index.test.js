import { describe, it, expect, vi } from "vitest";
import { createResearch } from "../index.js";

const nichesYaml = `
niches:
  ai:
    rss:
      - https://example.com/ai.xml
    web_search_queries:
      - "AI agent {today}"
    keywords_must_include: [ai]
    keywords_must_exclude: [crypto]
`;

function makeDeps(overrides = {}) {
  return {
    readFileSync: vi.fn(() => nichesYaml),
    fetchRss: vi.fn(async () => [
      { title: "New AI Agent Released", link: "https://x.com/1", pubDate: "2026-04-16" },
      { title: "Crypto Web3 News", link: "https://x.com/2", pubDate: "2026-04-16" },
    ]),
    browserSearch: vi.fn(async () => [
      { title: "OpenAI launches new model", url: "https://y.com/1" },
    ]),
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "bulk-classify") {
          return { text: JSON.stringify({ keep: [0, 2] }), tokens_in: 100, tokens_out: 10 };
        }
        if (taskClass === "reason") {
          return {
            text: JSON.stringify([
              { topic: "New AI Agent Released", source_url: "https://x.com/1", score: 0.9 },
              { topic: "OpenAI launches new model", source_url: "https://y.com/1", score: 0.7 },
            ]),
            tokens_in: 200,
            tokens_out: 50,
          };
        }
        throw new Error(`unexpected taskClass ${taskClass}`);
      }),
    },
    nichesPath: "/fake/niches.yaml",
    ...overrides,
  };
}

describe("research", () => {
  it("returns ranked topics for a niche", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0]).toHaveProperty("topic");
    expect(topics[0]).toHaveProperty("source_url");
    expect(topics[0]).toHaveProperty("score");
    expect(topics[0]).toHaveProperty("niche", "ai");
  });

  it("filters out must_exclude keywords", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(topics.map(t => t.topic).some(t => /crypto/i.test(t))).toBe(false);
  });

  it("throws when niche not in config", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    await expect(r.run("unknown-niche")).rejects.toThrow(/unknown-niche/);
  });

  it("falls back to RSS-only when browser fails 3× consecutively (queries=1, so 1 failure = silent skip)", async () => {
    const deps = makeDeps({
      browserSearch: vi.fn(async () => { throw new Error("browser flake"); }),
    });
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(topics.length).toBeGreaterThan(0);
    expect(deps.browserSearch).toHaveBeenCalledTimes(1);
  });

  it("stops calling browserSearch after 3 consecutive failures", async () => {
    const nichesYamlMany = `
niches:
  ai:
    rss:
      - https://example.com/ai.xml
    web_search_queries:
      - "q1 {today}"
      - "q2 {today}"
      - "q3 {today}"
      - "q4 {today}"
      - "q5 {today}"
    keywords_must_include: [ai]
    keywords_must_exclude: []
`;
    const deps = makeDeps({
      readFileSync: vi.fn(() => nichesYamlMany),
      browserSearch: vi.fn(async () => { throw new Error("flake"); }),
    });
    const r = createResearch(deps);
    await r.run("ai");
    expect(deps.browserSearch).toHaveBeenCalledTimes(3);
  });
});
