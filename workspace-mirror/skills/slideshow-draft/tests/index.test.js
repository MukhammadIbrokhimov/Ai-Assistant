import { describe, it, expect, vi } from "vitest";
import { createSlideshowDraft } from "../index.js";

let deps;

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass }) => {
        if (taskClass === "write") {
          const n = deps.router.complete.mock.calls.length;
          if (n === 1) return { text: "A 60-second script about AI agents replacing junior devs...", tokens_in: 50, tokens_out: 200 };
          if (n === 2) return {
            text: JSON.stringify([
              { text: "AI agents are transforming software teams" },
              { text: "Junior devs spent years learning loops" },
              { text: "Now agents write entire functions" },
              { text: "But agents need senior engineers" },
              { text: "The skill shift is already happening" },
              { text: "Adapt or be left behind" },
            ]),
            tokens_in: 100, tokens_out: 150,
          };
          if (n === 3) return { text: "AI agents aren't replacing devs—they're reshaping the role.", tokens_in: 80, tokens_out: 40 };
          if (n === 4) return { text: "#ai #coding #dev #future #agents #tech #career", tokens_in: 50, tokens_out: 20 };
        }
        if (taskClass === "extract") {
          return { text: JSON.stringify(["office", "coding", "team"]), tokens_in: 30, tokens_out: 15 };
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
});
