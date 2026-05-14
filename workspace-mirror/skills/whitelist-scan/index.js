import { join } from "node:path";

export function createWhitelistScan(deps) {
  const {
    sourcesStore, listNewVideos, downloadAudio, downloadVideo, transcribe,
    readManifest, writeManifest, mkdirp,
    freeSpaceBytes, now, cacheRoot, minFreeGb = 5,
  } = deps;

  function shouldScan(source, nowDate) {
    if (!source.lastScanned) return true;
    const last = new Date(source.lastScanned);
    const h = (nowDate - last) / 1000 / 3600;
    return h >= (source.poll_frequency_h || 24);
  }

  async function run() {
    const free = await freeSpaceBytes();
    if (free < minFreeGb * 1024 * 1024 * 1024) {
      throw new Error(`free space ${(free / 1024 / 1024 / 1024).toFixed(1)}GB below ${minFreeGb}GB`);
    }

    const nowDate = now();
    const sources = sourcesStore.list();
    let downloaded = 0, transcribed = 0, transcribe_failed = 0, skipped = 0, failed = 0;

    for (const s of sources) {
      if (!shouldScan(s, nowDate)) { skipped++; continue; }
      try {
        const audioDir = join(cacheRoot, "audio-cache", s.id);
        const videoDir = join(cacheRoot, "video-cache", s.id);
        mkdirp(audioDir);
        mkdirp(videoDir);

        const manifestPath = join(audioDir, "manifest.json");
        const manifest = readManifest(manifestPath);
        const seen = new Set((manifest.episodes || []).map(e => e.episode_id));

        const newEps = await listNewVideos(s.url, s.lastScanned);
        for (const ep of newEps) {
          if (seen.has(ep.id)) continue;
          const audioPath = join(audioDir, `${ep.id}.m4a`);
          const videoPath = join(videoDir, `${ep.id}.mp4`);
          await downloadAudio(ep.id, audioPath);
          await downloadVideo(ep.id, videoPath);

          // Transcribe inline so the next daily-loop's clip pool has it.
          // On failure, skip the episode (don't add to manifest) so the next
          // scan retries the whole episode — keeps manifest+transcript pair
          // consistent for loadTranscripts().
          try {
            await transcribe.run({
              audioPath,
              sourceId: s.id,
              episodeId: ep.id,
              title: ep.title,
              durationS: ep.duration_s,
            });
            transcribed++;
          } catch (terr) {
            transcribe_failed++;
            console.error(`transcribe failed for ${s.id}/${ep.id}: ${terr.message}`);
            continue;
          }

          manifest.episodes.push({
            episode_id: ep.id,
            title: ep.title,
            duration_s: ep.duration_s,
            published_at: ep.published_at,
            audio_path: audioPath,
            video_path: videoPath,
            video_pruned_at: null,
          });
          downloaded++;
        }

        writeManifest(manifestPath, manifest);
        sourcesStore.updateLastScanned(s.id, nowDate.toISOString());
      } catch (e) {
        failed++;
        console.error(`scan failed for ${s.id}: ${e.message}`);
      }
    }
    return { downloaded, transcribed, transcribe_failed, skipped, failed };
  }

  return { run };
}
