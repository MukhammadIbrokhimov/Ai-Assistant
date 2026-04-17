import { spawn } from "node:child_process";

export function createYtdlp({ binary = "yt-dlp" } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args);
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`yt-dlp exit ${code}: ${err}`));
      });
      proc.on("error", reject);
    });
  }

  async function listNewVideos(channelUrl, sinceIso) {
    const args = ["--flat-playlist", "--print-json"];
    if (sinceIso) {
      const d = sinceIso.slice(0, 10).replaceAll("-", "");
      args.push("--dateafter", d);
    }
    args.push(channelUrl);
    const raw = await run(args);
    return raw.split("\n").filter(Boolean).map((line) => {
      const j = JSON.parse(line);
      return {
        id: j.id,
        title: j.title,
        duration_s: j.duration || 0,
        published_at: j.upload_date ? `${j.upload_date.slice(0,4)}-${j.upload_date.slice(4,6)}-${j.upload_date.slice(6,8)}T00:00:00Z` : null,
      };
    });
  }

  async function downloadAudio(videoId, destPath) {
    await run(["-f", "m4a", "-o", destPath, `https://www.youtube.com/watch?v=${videoId}`]);
    return destPath;
  }

  async function downloadVideo(videoId, destPath) {
    await run([
      "-f", "bestvideo[height<=1080]+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", destPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    return destPath;
  }

  return { listNewVideos, downloadAudio, downloadVideo };
}
