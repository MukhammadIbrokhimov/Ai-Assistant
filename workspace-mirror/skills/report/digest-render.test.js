import { describe, it, expect } from "vitest";
import { renderDigest } from "./digest-render.js";

describe("renderDigest", () => {
  it("renders 'Quiet day' when nothing was produced", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 0, pending: 0, approved: 0, rejected: 0, modified: 0,
      byMode: { clip: 0, slideshow: 0, quotecard: 0 },
      topRejectionReason: null, spendUsd: 0, providerMix: [], spendCapHit: null,
    });
    expect(out).toContain("Quiet day");
  });

  it("renders full report with all sections", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 3, pending: 0, approved: 1, rejected: 1, modified: 1,
      byMode: { clip: 1, slideshow: 1, quotecard: 1 },
      topRejectionReason: "too clickbait",
      spendUsd: 0.08,
      providerMix: [
        { provider: "ollama:qwen2.5:14b", pct: 94 },
        { provider: "anthropic:claude-sonnet-4-6", pct: 6 },
      ],
      spendCapHit: null,
    });
    expect(out).toContain("2026-04-17");
    expect(out).toContain("Produced: 3");
    expect(out).toContain("Approved: 1");
    expect(out).toContain("too clickbait");
    expect(out).toContain("$0.08");
    expect(out).toContain("ollama:qwen2.5:14b");
  });

  it("includes spend-cap-hit line when present", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 1, pending: 0, approved: 0, rejected: 0, modified: 0,
      byMode: { clip: 0, slideshow: 1, quotecard: 0 },
      topRejectionReason: null, spendUsd: 1.02,
      providerMix: [], spendCapHit: { at: "14:32", spentUsd: 1.02 },
    });
    expect(out).toContain("Spend cap hit at 14:32");
  });

  it("omits empty sections", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 1, pending: 0, approved: 1, rejected: 0, modified: 0,
      byMode: { clip: 1, slideshow: 0, quotecard: 0 },
      topRejectionReason: null, spendUsd: 0, providerMix: [], spendCapHit: null,
    });
    expect(out).not.toContain("Top rejection");
    expect(out).not.toContain("Provider mix");
  });
});
