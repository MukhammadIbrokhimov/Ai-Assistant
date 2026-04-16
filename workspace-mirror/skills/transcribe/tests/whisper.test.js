import { describe, it, expect } from "vitest";
import { parseSrt } from "../whisper.js";

describe("parseSrt", () => {
  it("handles comma and period decimal separators", () => {
    const srt = `1\n00:00:01,500 --> 00:00:04,000\nHello.\n`;
    const segs = parseSrt(srt);
    expect(segs).toEqual([{ t_start: 1.5, t_end: 4.0, text: "Hello." }]);
  });

  it("joins multi-line segment text with a space", () => {
    const srt = `1\n00:00:00,000 --> 00:00:02,000\nLine one.\nLine two.\n`;
    expect(parseSrt(srt)[0].text).toBe("Line one. Line two.");
  });

  it("ignores empty blocks", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("\n\n\n")).toEqual([]);
  });
});
