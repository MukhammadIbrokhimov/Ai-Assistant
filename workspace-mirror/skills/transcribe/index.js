import { parseSrt } from "./whisper.js";
import { validateTranscript } from "shared/schemas";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

export function createTranscribe(deps) {
  const { unloadOllama, runWhisper, writeFileSync, mkdirp, now, transcriptRoot } = deps;

  async function run({ audioPath, sourceId, episodeId, title, durationS }) {
    await unloadOllama();
    const srt = await runWhisper(audioPath);
    const segments = parseSrt(srt);
    const outDir = join(transcriptRoot, sourceId);
    mkdirp(outDir);
    const transcript = {
      source_id: sourceId,
      episode_id: episodeId,
      title,
      language: "en",
      duration_s: durationS,
      transcribed_at: now().toISOString(),
      model: "whisper-large-v3",
      segments,
    };
    const v = validateTranscript(transcript);
    if (!v.valid) throw new Error(`Transcript invalid: ${v.errors.join(", ")}`);
    const outPath = join(outDir, `${episodeId}.json`);
    writeFileSync(outPath, JSON.stringify(transcript, null, 2));
    try { if (existsSync(`${audioPath}.srt`)) unlinkSync(`${audioPath}.srt`); } catch {}
    return { transcript, path: outPath };
  }

  return { run };
}
