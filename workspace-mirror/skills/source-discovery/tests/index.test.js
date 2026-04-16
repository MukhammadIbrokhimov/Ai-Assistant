import { describe, it, expect, vi } from "vitest";
import { createSourceDiscovery } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    youtube: {
      getChannelById: vi.fn(async () => ({
        id: "UCSHZK",
        title: "Lex Fridman",
        handle: "@lexfridman",
        subs: 5300000,
        description: "Podcast about science. See clip policy at https://lexfridman.com/clip-policy",
      })),
      searchChannelsInNiche: vi.fn(async () => [{ id: "UCSHZK", title: "Lex" }]),
      getRecentVideoStats: vi.fn(async () => ({ recent_30d_views: 12400000 })),
    },
    browser: {
      fetchPage: vi.fn(async () => ({
        text: "Feel free to clip highlights from the podcast. Credit with 🎙️ From Lex Fridman {episode_title}.",
        url: "https://lexfridman.com/clip-policy",
      })),
    },
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "bulk-classify") {
          return {
            text: JSON.stringify({
              license_type: "permission-granted",
              confidence: 0.92,
              evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
              attribution_template: "🎙️ From Lex Fridman {episode_title}",
              niche_fit: "ai",
              niche_fit_confidence: 0.9,
            }),
            tokens_in: 200, tokens_out: 100,
          };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    telegramSendCandidate: vi.fn(async () => ({ message_id: 42 })),
    pendingSourceStore: {
      create: vi.fn(),
    },
    now: () => new Date("2026-04-16T10:00:00Z"),
    idGenerator: () => "2026-04-16-cand-lex-001",
    ...overrides,
  };
}

describe("source-discovery", () => {
  it("push mode: creates candidate from URL and DMs user", async () => {
    const deps = makeDeps();
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@lexfridman", "ai");
    expect(deps.telegramSendCandidate).toHaveBeenCalled();
    expect(result.candidate).toMatchObject({
      discovery_mode: "push",
      creator: "Lex Fridman",
      license_type: "permission-granted",
    });
    expect(deps.pendingSourceStore.create).toHaveBeenCalled();
  });

  it("push mode: drops candidate when regex precheck fails", async () => {
    const deps = makeDeps({
      browser: {
        fetchPage: vi.fn(async () => ({ text: "All rights reserved. © 2026.", url: "https://x.com" })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
    expect(deps.telegramSendCandidate).not.toHaveBeenCalled();
  });

  it("drops candidate when LLM evidence snippet is not substring of fetched page", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.95,
            evidence_snippet_verbatim: "PARAPHRASED — not in page",
            attribution_template: "🎙️ From X {episode_title}",
            niche_fit: "ai",
            niche_fit_confidence: 0.9,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
    expect(deps.telegramSendCandidate).not.toHaveBeenCalled();
  });

  it("drops candidate when recommendation_confidence < 0.7", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.5,
            evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
            attribution_template: "🎙️ From X {episode_title}",
            niche_fit: "ai",
            niche_fit_confidence: 0.3,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
  });

  it("drops candidate with invalid attribution_template (no placeholder)", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.95,
            evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
            attribution_template: "From Lex Fridman",
            niche_fit: "ai",
            niche_fit_confidence: 0.9,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
  });
});
