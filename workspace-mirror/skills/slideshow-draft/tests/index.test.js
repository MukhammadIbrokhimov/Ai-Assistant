import { describe, it, expect, vi } from "vitest";
import { createSlideshowDraft } from "../index.js";

let deps;

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass }) => {
        if (taskClass === "write") {
          const n = deps.router.complete.mock.calls.length;
          if (n === 1) return { text: "A 60-second script about AI agents replacing junior devs...", tokensIn: 50, tokensOut: 200, providerUsed: "ollama:qwen2.5:14b" };
          if (n === 2) return {
            text: JSON.stringify([
              { text: "AI agents are transforming software teams" },
              { text: "Junior devs spent years learning loops" },
              { text: "Now agents write entire functions" },
              { text: "But agents need senior engineers" },
              { text: "The skill shift is already happening" },
              { text: "Adapt or be left behind" },
            ]),
            tokensIn: 100, tokensOut: 150, providerUsed: "ollama:qwen2.5:14b",
          };
          if (n === 3) return { text: "AI agents aren't replacing devs—they're reshaping the role.", tokensIn: 80, tokensOut: 40, providerUsed: "ollama:qwen2.5:14b" };
          if (n === 4) return { text: "#ai #coding #dev #future #agents #tech #career", tokensIn: 50, tokensOut: 20, providerUsed: "ollama:qwen2.5:14b" };
        }
        if (taskClass === "extract") {
          return { text: JSON.stringify(["office", "coding", "team"]), tokensIn: 30, tokensOut: 15, providerUsed: "ollama:qwen2.5:14b" };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    pexelsSearch: vi.fn(async () => ({
      id: 123456,
      url: "https://images.pexels.com/photos/123456/example.jpg",
      photographer: "Jane Doe",
    })),
    writeDraft: vi.fn(),
    writeMedia: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T09:00:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-slideshow-001",
    ...overrides,
  };
}

describe("slideshow-draft", () => {
  it("produces a Draft with 6 beats totaling 60s", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    const result = await ss.run({ topic: "AI agents replacing junior devs", niche: "ai" });
    expect(result.draft.mode).toBe("slideshow");
    expect(result.draft.topic).toBe("AI agents replacing junior devs");
    const storyboard = result.storyboard;
    expect(storyboard.beats).toHaveLength(6);
    const total = storyboard.beats.reduce((a, b) => a + b.duration_s, 0);
    expect(total).toBe(60);
  });

  it("writes draft.json + storyboard.json to draftsRoot/pending/<id>/", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    await ss.run({ topic: "test", niche: "ai" });
    expect(deps.writeDraft).toHaveBeenCalledWith(
      expect.stringContaining("2026-04-16-slideshow-001"),
      expect.objectContaining({ mode: "slideshow" }),
    );
    expect(deps.writeMedia).toHaveBeenCalledWith(
      expect.stringContaining("storyboard.json"),
      expect.any(String),
    );
  });

  it("calls Pexels once per beat", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    await ss.run({ topic: "test", niche: "ai" });
    expect(deps.pexelsSearch).toHaveBeenCalledTimes(6);
  });

  it("stores caption + hashtags on the draft", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    const { draft } = await ss.run({ topic: "test", niche: "ai" });
    expect(draft.caption).toBeTruthy();
    expect(Array.isArray(draft.hashtags)).toBe(true);
    expect(draft.hashtags.length).toBeGreaterThan(0);
  });

  it("draft records non-zero tokens_in/tokens_out and provider_used from router response", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    const { draft } = await ss.run({ topic: "test", niche: "ai" });
    expect(draft.tokens_in).toBe(50 + 100 + 80 + 50);
    expect(draft.tokens_out).toBe(200 + 150 + 40 + 20);
    expect(draft.provider_used).toBe("ollama:qwen2.5:14b");
  });
});
