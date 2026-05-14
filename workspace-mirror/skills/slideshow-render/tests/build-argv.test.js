import { describe, it, expect } from "vitest";
import { buildFfmpegArgv } from "../index.js";

const beat0 = { imagePath: "/d/media/beat-0.jpg", audioPath: "/d/media/beat-0.aiff", duration_s: 10, text: "first beat" };
const beat1 = { imagePath: "/d/media/beat-1.jpg", audioPath: "/d/media/beat-1.aiff", duration_s: 10, text: "second beat" };

describe("buildFfmpegArgv", () => {
  it("includes -y as the first arg so re-renders overwrite", () => {
    const argv = buildFfmpegArgv({ beats: [beat0], outputPath: "/d/media/video.mp4" });
    expect(argv[0]).toBe("-y");
  });

  it("loops each image for its beat duration", () => {
    const argv = buildFfmpegArgv({ beats: [beat0, beat1], outputPath: "/d/v.mp4" });
    const joined = argv.join(" ");
    // Each image should appear as a looped input clamped to its duration.
    expect(joined).toMatch(/-loop 1 -t 10 -i \/d\/media\/beat-0\.jpg/);
    expect(joined).toMatch(/-loop 1 -t 10 -i \/d\/media\/beat-1\.jpg/);
  });

  it("adds each beat's audio file as an input after the images", () => {
    const argv = buildFfmpegArgv({ beats: [beat0, beat1], outputPath: "/d/v.mp4" });
    // Image inputs come first, then audio inputs (so indices stay predictable).
    const imageIdx0 = argv.findIndex((a, i) => a === "-i" && argv[i + 1] === "/d/media/beat-0.jpg");
    const imageIdx1 = argv.findIndex((a, i) => a === "-i" && argv[i + 1] === "/d/media/beat-1.jpg");
    const audioIdx0 = argv.findIndex((a, i) => a === "-i" && argv[i + 1] === "/d/media/beat-0.aiff");
    const audioIdx1 = argv.findIndex((a, i) => a === "-i" && argv[i + 1] === "/d/media/beat-1.aiff");
    expect(imageIdx0).toBeGreaterThan(-1);
    expect(audioIdx0).toBeGreaterThan(imageIdx1);
    expect(audioIdx1).toBeGreaterThan(audioIdx0);
  });

  it("builds a filter_complex that scales/crops to 1080x1920 and concats video+audio", () => {
    const argv = buildFfmpegArgv({ beats: [beat0, beat1], outputPath: "/d/v.mp4" });
    const i = argv.indexOf("-filter_complex");
    expect(i).toBeGreaterThan(-1);
    const graph = argv[i + 1];
    // Scale + crop pattern applied to each image stream.
    expect(graph).toMatch(/\[0:v\].*scale=1080:1920.*crop=1080:1920.*\[v0\]/);
    expect(graph).toMatch(/\[1:v\].*scale=1080:1920.*crop=1080:1920.*\[v1\]/);
    // Concat: 2 segments, video + audio.
    expect(graph).toMatch(/\[v0\]\[v1\]concat=n=2:v=1:a=0\[outv\]/);
  });

  it("pads each TTS audio to its beat's duration_s (so short narration doesn't shorten the video)", () => {
    const argv = buildFfmpegArgv({ beats: [beat0, beat1], outputPath: "/d/v.mp4" });
    const graph = argv[argv.indexOf("-filter_complex") + 1];
    // Audio input 2 (first beat) is padded to 10s, input 3 to 10s, then concatenated.
    expect(graph).toMatch(/\[2:a\]apad=whole_dur=10\[a0\]/);
    expect(graph).toMatch(/\[3:a\]apad=whole_dur=10\[a1\]/);
    expect(graph).toMatch(/\[a0\]\[a1\]concat=n=2:v=0:a=1\[outa\]/);
  });

  it("maps the concatenated streams and codecs to mp4 output", () => {
    const argv = buildFfmpegArgv({ beats: [beat0, beat1], outputPath: "/d/v.mp4" });
    expect(argv).toContain("-map");
    expect(argv).toContain("[outv]");
    expect(argv).toContain("[outa]");
    expect(argv).toContain("-c:v");
    expect(argv).toContain("libx264");
    expect(argv).toContain("-c:a");
    expect(argv).toContain("aac");
    expect(argv[argv.length - 1]).toBe("/d/v.mp4");
  });

  it("supports custom width/height (defaults to 1080x1920)", () => {
    const argv = buildFfmpegArgv({ beats: [beat0], outputPath: "/d/v.mp4", width: 720, height: 1280 });
    expect(argv.join(" ")).toMatch(/scale=720:1280.*crop=720:1280/);
  });

  it("rejects empty beats array", () => {
    expect(() => buildFfmpegArgv({ beats: [], outputPath: "/d/v.mp4" })).toThrow(/at least one beat/);
  });
});
