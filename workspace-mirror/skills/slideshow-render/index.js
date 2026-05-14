// Compose images + per-beat TTS narration into a vertical mp4.
//
// Pipeline: caller hands us a storyboard whose beats already have local image
// and audio paths; we render a 1080x1920 mp4 with one image per beat held for
// duration_s and the matching TTS audio concatenated.

import { validateStoryboard } from "shared/schemas";

export async function renderSlideshow({
  draftId, draftsRoot, storyboard, draft,
  fetchImage, speak, runFfmpeg, writeFile, writeDraft, mkdirp,
  log = () => {},
  draftDir = `${draftsRoot}/pending/${draftId}`,
  width = 1080, height = 1920,
}) {
  const check = validateStoryboard(storyboard);
  if (!check.valid) {
    throw new Error(`renderSlideshow: invalid storyboard — ${check.errors.join("; ")}`);
  }
  const mediaDir = `${draftDir}/media`;
  mkdirp(mediaDir);

  const beats = [];
  for (let i = 0; i < storyboard.beats.length; i++) {
    const b = storyboard.beats[i];
    const imagePath = `${mediaDir}/beat-${i}.jpg`;
    const audioPath = `${mediaDir}/beat-${i}.aiff`;
    log(`render: beat ${i} fetching image`);
    const bytes = await fetchImage(b.image_url);
    writeFile(imagePath, bytes);
    log(`render: beat ${i} speaking TTS`);
    await speak({ text: b.text, outPath: audioPath });
    beats.push({ imagePath, audioPath, duration_s: b.duration_s, text: b.text });
  }

  const videoPath = `${mediaDir}/video.mp4`;
  const argv = buildFfmpegArgv({ beats, outputPath: videoPath, width, height });
  log(`render: ffmpeg ${argv.length} args`);
  await runFfmpeg(argv);

  const totalDuration = storyboard.beats.reduce((a, b) => a + b.duration_s, 0);
  const otherMedia = (draft.media ?? []).filter(m => m.type !== "video");
  const updatedDraft = {
    ...draft,
    media: [...otherMedia, { path: "media/video.mp4", type: "video", duration_s: totalDuration }],
  };
  writeDraft(draftId, updatedDraft);
  return { videoPath, draft: updatedDraft };
}

export function buildFfmpegArgv({ beats, outputPath, width = 1080, height = 1920 }) {
  if (!Array.isArray(beats) || beats.length === 0) {
    throw new Error("buildFfmpegArgv: at least one beat required");
  }
  const argv = ["-y"];

  // Image inputs first, so audio indices come after — keeps the filter graph
  // referencing predictable input numbers ([N:a] where N = beats.length + i).
  for (const b of beats) {
    argv.push("-loop", "1", "-t", String(b.duration_s), "-i", b.imagePath);
  }
  for (const b of beats) {
    argv.push("-i", b.audioPath);
  }

  const n = beats.length;
  const videoFilters = beats
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${i}]`)
    .join(";");
  // Pad each TTS clip with silence so it fills the beat — otherwise -shortest
  // would clip the entire output to the (typically shorter) narration length.
  const audioFilters = beats
    .map((b, i) => `[${n + i}:a]apad=whole_dur=${b.duration_s}[a${i}]`)
    .join(";");
  const videoConcatInputs = beats.map((_, i) => `[v${i}]`).join("");
  const audioConcatInputs = beats.map((_, i) => `[a${i}]`).join("");
  const filterComplex =
    `${videoFilters};${audioFilters};${videoConcatInputs}concat=n=${n}:v=1:a=0[outv];${audioConcatInputs}concat=n=${n}:v=0:a=1[outa]`;

  argv.push(
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  );
  return argv;
}
