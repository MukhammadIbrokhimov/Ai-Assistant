import { describe, it, expect, vi } from "vitest";
import { renderSlideshow } from "../index.js";

function makeStoryboard(overrides = {}) {
  return {
    script: "Hello world. This is a test.",
    duration_s: 20,
    beats: [
      { text: "First beat", duration_s: 10, image_url: "https://img.example/a.jpg", pexels_photo_id: 1, pexels_attribution: "X" },
      { text: "Second beat", duration_s: 10, image_url: "https://img.example/b.jpg", pexels_photo_id: 2, pexels_attribution: "Y" },
    ],
    ...overrides,
  };
}

function makeDraft(overrides = {}) {
  return {
    id: "2026-04-16-slideshow-001",
    mode: "slideshow",
    media: [{ path: "media/storyboard.json", type: "storyboard", duration_s: 20 }],
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const draftDir = "/d/pending/2026-04-16-slideshow-001";
  return {
    draftId: "2026-04-16-slideshow-001",
    draftsRoot: "/d",
    storyboard: makeStoryboard(),
    draft: makeDraft(),
    fetchImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    speak: vi.fn(async () => {}),
    runFfmpeg: vi.fn(async () => ({ stdout: "", stderr: "" })),
    writeFile: vi.fn(),
    writeDraft: vi.fn(),
    mkdirp: vi.fn(),
    log: () => {},
    draftDir,
    ...overrides,
  };
}

describe("renderSlideshow", () => {
  it("rejects an invalid storyboard before doing any I/O", async () => {
    const deps = makeDeps({ storyboard: { script: "", beats: [] } });
    await expect(renderSlideshow(deps)).rejects.toThrow(/storyboard/i);
    expect(deps.fetchImage).not.toHaveBeenCalled();
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
  });

  it("downloads one image per beat and writes it under media/", async () => {
    const deps = makeDeps();
    await renderSlideshow(deps);
    expect(deps.fetchImage).toHaveBeenCalledTimes(2);
    expect(deps.fetchImage).toHaveBeenCalledWith("https://img.example/a.jpg");
    expect(deps.fetchImage).toHaveBeenCalledWith("https://img.example/b.jpg");
    const imageWrites = deps.writeFile.mock.calls.filter(([p]) => /beat-\d+\.jpg$/.test(p));
    expect(imageWrites).toHaveLength(2);
    expect(imageWrites[0][0]).toBe("/d/pending/2026-04-16-slideshow-001/media/beat-0.jpg");
  });

  it("speaks one TTS clip per beat to media/beat-<i>.aiff", async () => {
    const deps = makeDeps();
    await renderSlideshow(deps);
    expect(deps.speak).toHaveBeenCalledTimes(2);
    expect(deps.speak).toHaveBeenCalledWith({
      text: "First beat",
      outPath: "/d/pending/2026-04-16-slideshow-001/media/beat-0.aiff",
    });
    expect(deps.speak).toHaveBeenCalledWith({
      text: "Second beat",
      outPath: "/d/pending/2026-04-16-slideshow-001/media/beat-1.aiff",
    });
  });

  it("invokes ffmpeg with argv targeting media/video.mp4", async () => {
    const deps = makeDeps();
    await renderSlideshow(deps);
    expect(deps.runFfmpeg).toHaveBeenCalledTimes(1);
    const argv = deps.runFfmpeg.mock.calls[0][0];
    expect(argv[argv.length - 1]).toBe("/d/pending/2026-04-16-slideshow-001/media/video.mp4");
    expect(argv).toContain("-filter_complex");
  });

  it("updates draft.media to include the rendered video", async () => {
    const deps = makeDeps();
    const result = await renderSlideshow(deps);
    expect(deps.writeDraft).toHaveBeenCalledTimes(1);
    const [, updated] = deps.writeDraft.mock.calls[0];
    const video = updated.media.find(m => m.type === "video");
    expect(video).toBeDefined();
    expect(video.path).toBe("media/video.mp4");
    expect(video.duration_s).toBe(20);
    // Returns the path so the CLI can echo it.
    expect(result.videoPath).toBe("/d/pending/2026-04-16-slideshow-001/media/video.mp4");
  });

  it("does not duplicate the video entry if media already has one (re-render)", async () => {
    const draft = makeDraft({
      media: [
        { path: "media/storyboard.json", type: "storyboard", duration_s: 20 },
        { path: "media/video.mp4", type: "video", duration_s: 20 },
      ],
    });
    const deps = makeDeps({ draft });
    await renderSlideshow(deps);
    const [, updated] = deps.writeDraft.mock.calls[0];
    const videos = updated.media.filter(m => m.type === "video");
    expect(videos).toHaveLength(1);
  });
});
