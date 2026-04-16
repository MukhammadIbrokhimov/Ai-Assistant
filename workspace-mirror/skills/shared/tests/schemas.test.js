import { describe, it, expect } from "vitest";
import {
  validateTranscript,
  validateStoryboard,
  validateCandidate,
} from "../schemas.js";

describe("validateTranscript", () => {
  const valid = {
    source_id: "lex-fridman",
    episode_id: "abc123",
    title: "Lex Fridman #999",
    language: "en",
    duration_s: 7234,
    transcribed_at: "2026-04-16T13:14:00Z",
    model: "whisper-large-v3",
    segments: [
      { t_start: 0.0, t_end: 3.2, text: "Welcome." },
      { t_start: 3.2, t_end: 7.8, text: "This is the conversation." },
    ],
  };

  it("accepts a valid transcript", () => {
    expect(validateTranscript(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing source_id", () => {
    const invalid = { ...valid, source_id: undefined };
    const result = validateTranscript(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/source_id/);
  });

  it("rejects non-array segments", () => {
    const invalid = { ...valid, segments: "not an array" };
    expect(validateTranscript(invalid).valid).toBe(false);
  });

  it("rejects segment with negative t_start", () => {
    const invalid = { ...valid, segments: [{ t_start: -1, t_end: 1, text: "x" }] };
    expect(validateTranscript(invalid).valid).toBe(false);
  });
});

describe("validateStoryboard", () => {
  const valid = {
    script: "Full 60-second script...",
    duration_s: 60,
    beats: [
      {
        text: "Beat 1 text",
        duration_s: 10,
        keywords: ["ai", "office"],
        pexels_photo_id: 123,
        image_url: "https://images.pexels.com/photos/123/example.jpg",
        pexels_attribution: "Photo by Jane on Pexels",
      },
    ],
  };

  it("accepts a valid storyboard", () => {
    expect(validateStoryboard(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects empty beats array", () => {
    expect(validateStoryboard({ ...valid, beats: [] }).valid).toBe(false);
  });

  it("rejects beat without image_url", () => {
    const bad = { ...valid, beats: [{ ...valid.beats[0], image_url: undefined }] };
    expect(validateStoryboard(bad).valid).toBe(false);
  });
});

describe("validateCandidate", () => {
  const valid = {
    candidate_id: "2026-04-16-cand-lex-001",
    discovered_at: "2026-04-16T10:03:00Z",
    discovery_mode: "push",
    creator: "Lex Fridman",
    channel_id: "UCSHZKyawb77ixDdsGog4iWA",
    channel_handle: "@lexfridman",
    url: "https://www.youtube.com/@lexfridman",
    subs: 5300000,
    recent_30d_views: 12400000,
    velocity_score: 2.34,
    niche: "ai",
    niche_fit_confidence: 0.92,
    license_type: "permission-granted",
    license_evidence_url: "https://lexfridman.com/clip-policy",
    license_evidence_snippet: "Feel free to clip and repost highlights",
    attribution_template: "🎙️ From Lex Fridman {episode_title}",
    recommendation_confidence: 0.88,
  };

  it("accepts a valid candidate", () => {
    expect(validateCandidate(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects attribution_template without a known placeholder", () => {
    const bad = { ...valid, attribution_template: "From Lex Fridman" };
    const result = validateCandidate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/attribution_template/);
  });

  it("accepts attribution_template with {episode_num}", () => {
    const ok = { ...valid, attribution_template: "Ep {episode_num}" };
    expect(validateCandidate(ok).valid).toBe(true);
  });

  it("rejects discovery_mode other than push/pull", () => {
    const bad = { ...valid, discovery_mode: "random" };
    expect(validateCandidate(bad).valid).toBe(false);
  });

  it("rejects recommendation_confidence outside [0, 1]", () => {
    const bad = { ...valid, recommendation_confidence: 1.5 };
    expect(validateCandidate(bad).valid).toBe(false);
  });
});
