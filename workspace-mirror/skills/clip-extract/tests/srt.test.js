import { describe, it, expect } from "vitest";
import { buildClipSrt, formatSrtTime } from "../srt.js";
import { escapeFilterPath } from "../ffmpeg.js";

describe("formatSrtTime", () => {
  it("0.0 → 00:00:00,000", () => {
    expect(formatSrtTime(0.0)).toBe("00:00:00,000");
  });
  it("3.5 → 00:00:03,500", () => {
    expect(formatSrtTime(3.5)).toBe("00:00:03,500");
  });
  it("65.25 → 00:01:05,250", () => {
    expect(formatSrtTime(65.25)).toBe("00:01:05,250");
  });
});

describe("buildClipSrt", () => {
  const segments = [
    { t_start: 100.0, t_end: 103.0, text: "Before the clip." },
    { t_start: 1830.0, t_end: 1832.5, text: "Viral moment starts." },
    { t_start: 1832.5, t_end: 1837.0, text: "Followed by a hook." },
    { t_start: 1840.0, t_end: 1842.0, text: "After clip ends." },
  ];
  it("filters segments inside [start, end] and shifts timestamps to clip-local", () => {
    const srt = buildClipSrt(segments, 1830.0, 1839.0);
    expect(srt).toContain("00:00:00,000 --> 00:00:02,500");
    expect(srt).toContain("Viral moment starts.");
    expect(srt).toContain("00:00:02,500 --> 00:00:07,000");
    expect(srt).toContain("Followed by a hook.");
    expect(srt).not.toContain("Before the clip.");
    expect(srt).not.toContain("After clip ends.");
  });
});

describe("escapeFilterPath", () => {
  it("escapes colons", () => {
    expect(escapeFilterPath("/tmp/foo:bar")).toBe("/tmp/foo\\:bar");
  });
  it("escapes single quotes", () => {
    expect(escapeFilterPath("/tmp/it's.srt")).toBe("/tmp/it\\\\'s.srt");
  });
  it("escapes commas, brackets, backslashes", () => {
    expect(escapeFilterPath("/p[a],b\\c")).toBe("/p\\[a\\]\\,b\\\\c");
  });
  it("leaves a clean path untouched", () => {
    expect(escapeFilterPath("/tmp/clip.srt")).toBe("/tmp/clip.srt");
  });
});
