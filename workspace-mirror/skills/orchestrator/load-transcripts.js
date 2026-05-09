import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadTranscripts({ draftsRoot, log = { warn: console.warn } }) {
  const transcriptRoot = join(draftsRoot, "whitelist", "transcript-cache");
  const audioRoot = join(draftsRoot, "whitelist", "audio-cache");
  if (!existsSync(transcriptRoot)) return [];

  const out = [];
  for (const sourceDir of readdirSync(transcriptRoot, { withFileTypes: true })) {
    if (!sourceDir.isDirectory()) continue;
    const sourceId = sourceDir.name;
    const manifestPath = join(audioRoot, sourceId, "manifest.json");
    if (!existsSync(manifestPath)) {
      log.warn(`loadTranscripts: manifest.json missing for source ${sourceId}; skipping all transcripts for this source`);
      continue;
    }
    let manifestById;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifestById = new Map((manifest.episodes || []).map(e => [e.episode_id, e]));
    } catch (err) {
      log.warn(`loadTranscripts: failed to parse manifest for ${sourceId}: ${err.message}`);
      continue;
    }

    for (const f of readdirSync(join(transcriptRoot, sourceId))) {
      if (!f.endsWith(".json")) continue;
      let transcript;
      try {
        transcript = JSON.parse(readFileSync(join(transcriptRoot, sourceId, f), "utf8"));
      } catch {
        continue;
      }
      const entry = manifestById.get(transcript.episode_id);
      if (!entry) {
        log.warn(`loadTranscripts: no manifest entry for ${transcript.episode_id} in source ${sourceId}; skipping`);
        continue;
      }
      out.push({
        ...transcript,
        source_id: transcript.source_id || sourceId,
        video_path: entry.video_path,
      });
    }
  }
  return out;
}
