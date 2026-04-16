import { describe, test, expect } from "vitest";
import {
  STATUSES,
  CALLBACK_PREFIXES,
  formatTemplateA,
  formatTemplateB,
} from "../constants.js";

describe("constants", () => {
  test("STATUSES contains all valid status values", () => {
    expect(STATUSES).toEqual({
      PENDING: "pending",
      APPROVED: "approved",
      REJECTED: "rejected",
      MODIFYING: "modifying",
      SUPERSEDED: "superseded",
    });
  });

  test("CALLBACK_PREFIXES use single-char keys", () => {
    expect(CALLBACK_PREFIXES).toEqual({
      APPROVE: "a:",
      MODIFY: "m:",
      REJECT: "r:",
    });
  });

  test("formatTemplateA renders full draft with source and media", () => {
    const draft = {
      id: "2026-04-16-clip-001",
      mode: "clip",
      topic: "AI agents",
      caption: "Sam Altman explains why...",
      hashtags: ["#aiagents", "#lexfridman"],
      media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
      source: {
        title: "Lex Fridman #999",
        license: "permission-granted",
      },
    };
    const text = formatTemplateA(draft);
    expect(text).toContain("🆕 Draft 2026-04-16-clip-001");
    expect(text).toContain("CLIP mode");
    expect(text).toContain("Source: Lex Fridman #999 (permission-granted)");
    expect(text).toContain("AI agents");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
    expect(text).toContain("🎬 Media: video, 47s");
  });

  test("formatTemplateA omits source and media when absent", () => {
    const draft = {
      id: "2026-04-16-quote-001",
      mode: "quotecard",
      topic: "Productivity tips",
      caption: "Focus is a superpower.",
      hashtags: ["#productivity"],
      media: [],
      source: null,
    };
    const text = formatTemplateA(draft);
    expect(text).toContain("🆕 Draft 2026-04-16-quote-001");
    expect(text).toContain("QUOTECARD mode");
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("🎬 Media:");
  });

  test("formatTemplateB renders approved package with media path", () => {
    const draft = {
      id: "2026-04-16-clip-001",
      caption: "Sam Altman explains why...",
      hashtags: ["#aiagents", "#lexfridman"],
      media: [{ path: "media/0.mp4", type: "video" }],
    };
    const destDir = "~/openclaw-drafts/approved/2026-04-16/2026-04-16-clip-001";
    const text = formatTemplateB(draft, destDir);
    expect(text).toContain("✅ READY TO POST");
    expect(text).toContain("═══ COPY THIS ═══");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
    expect(text).toContain("═════════════════");
    expect(text).toContain("🎬 Media:");
    expect(text).toContain("Saved to:");
  });

  test("formatTemplateB omits media line when no media", () => {
    const draft = {
      id: "2026-04-16-quote-001",
      caption: "Focus is a superpower.",
      hashtags: ["#productivity"],
      media: [],
    };
    const destDir = "~/openclaw-drafts/approved/2026-04-16/2026-04-16-quote-001";
    const text = formatTemplateB(draft, destDir);
    expect(text).not.toContain("🎬 Media:");
    expect(text).toContain("Saved to:");
  });

  test("callback_data stays under 64 bytes for max-length ID", () => {
    const longId = "a".repeat(56);
    const data = `${CALLBACK_PREFIXES.APPROVE}${longId}`;
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });
});
