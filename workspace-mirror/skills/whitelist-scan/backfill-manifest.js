import { join, basename, extname } from "node:path";

export function createBackfillManifest(deps) {
  const {
    listAudio, listVideo, fileExists,
    readManifest, writeManifest,
    probeDurationS, fetchVideoMeta,
    sourceId, audioDir, videoDir,
    log,
  } = deps;

  function basenamesOf(files, ext) {
    return new Set(
      files
        .filter(f => extname(f).toLowerCase() === ext.toLowerCase())
        .map(f => basename(f, ext))
    );
  }

  async function buildEntry(episodeId) {
    const videoPath = join(videoDir, `${episodeId}.mp4`);
    const audioPath = join(audioDir, `${episodeId}.m4a`);
    let duration_s;
    try {
      duration_s = await probeDurationS(videoPath);
    } catch (err) {
      log.warn(`ffprobe failed for ${episodeId}: ${err.message}; skipping`);
      return null;
    }
    let title = episodeId;
    let published_at = null;
    try {
      const meta = await fetchVideoMeta(episodeId);
      if (meta?.title) title = meta.title;
      if (meta?.publishedAt) published_at = meta.publishedAt;
    } catch (err) {
      log.warn(`fetchVideoMeta failed for ${episodeId}: ${err.message}; using fallbacks`);
    }
    return {
      episode_id: episodeId,
      title,
      duration_s,
      published_at,
      audio_path: audioPath,
      video_path: videoPath,
      video_pruned_at: null,
    };
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      if (a.published_at && b.published_at) {
        if (a.published_at > b.published_at) return -1;
        if (a.published_at < b.published_at) return 1;
        return 0;
      }
      if (a.published_at && !b.published_at) return -1;
      if (!a.published_at && b.published_at) return 1;
      return a.episode_id < b.episode_id ? -1 : a.episode_id > b.episode_id ? 1 : 0;
    });
  }

  async function run() {
    const audioIds = basenamesOf(listAudio(), ".m4a");
    const videoIds = basenamesOf(listVideo(), ".mp4");
    const intersection = [...audioIds].filter(id => videoIds.has(id));

    const existing = readManifest() || { episodes: [] };
    const existingById = new Map();
    for (const ep of existing.episodes || []) {
      if (fileExists(ep.video_path)) {
        existingById.set(ep.episode_id, ep);
      } else {
        log.warn(`pruning stale manifest entry: ${ep.episode_id} (video file missing)`);
      }
    }

    const result = [];
    for (const id of intersection) {
      if (existingById.has(id)) {
        result.push(existingById.get(id));
        continue;
      }
      const entry = await buildEntry(id);
      if (entry) result.push(entry);
    }

    const manifest = { episodes: sortEntries(result) };
    writeManifest(manifest);
    return { manifest };
  }

  return { run };
}
