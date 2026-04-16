import { describe, it, expect, vi } from "vitest";
import { createQuotecardDraft } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "extract" || taskClass === "write") {
          if (/quote/i.test(prompt) && !/caption/i.test(prompt) && !/hashtag/i.test(prompt)) {
            return { text: "AI agents won't replace junior devs — they'll create them.", tokens_in: 100, tokens_out: 20 };
          }
          if (/caption/i.test(prompt)) return { text: "The future of junior devs.", tokens_in: 50, tokens_out: 15 };
          if (/hashtag/i.test(prompt)) return { text: "#ai #agents #dev #coding #future #tech #career #software #growth #learning", tokens_in: 50, tokens_out: 20 };
        }
        throw new Error(`unexpected ${taskClass} / ${prompt.slice(0, 40)}`);
      }),
    },
    renderCard: vi.fn(async (spec, outPath) => outPath),
    writeDraft: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T09:00:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-quotecard-001",
    ...overrides,
  };
}

describe("quotecard-draft", () => {
  it("produces a Draft with quotecard mode and card.png media", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    const { draft, cardPath } = await q.run({ topic: "AI agents replacing junior devs", niche: "ai" });
    expect(draft.mode).toBe("quotecard");
    expect(draft.media[0].type).toBe("image");
    expect(cardPath).toContain("card.png");
  });

  it("invokes render subprocess with spec including quote + attribution", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    await q.run({ topic: "test topic", niche: "ai" });
    expect(deps.renderCard).toHaveBeenCalled();
    const [spec, outPath] = deps.renderCard.mock.calls[0];
    expect(spec.quote).toBeTruthy();
    expect(spec.niche).toBe("ai");
    expect(outPath).toContain("card.png");
  });

  it("uses `extract` task class when sourceContext provided, else `write`", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    await q.run({ topic: "test", niche: "ai", sourceContext: "Some long article text..." });
    const calls = deps.router.complete.mock.calls;
    expect(calls.some(c => c[0].taskClass === "extract")).toBe(true);
  });

  it("caption + hashtags populated on draft", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    const { draft } = await q.run({ topic: "test", niche: "ai" });
    expect(draft.caption).toBeTruthy();
    expect(draft.hashtags.length).toBeGreaterThan(5);
  });
});
