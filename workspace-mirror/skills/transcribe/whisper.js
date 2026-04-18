import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

export function parseSrt(srt) {
  const segments = [];
  const blocks = srt.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find(l => l.includes("-->"));
    if (!timeLine) continue;
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    const [startStr, endStr] = timeLine.split("-->").map(s => s.trim());
    const toSec = (t) => {
      const clean = t.replace(",", ".");
      const [h, m, s] = clean.split(":");
      return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
    };
    segments.push({
      t_start: toSec(startStr),
      t_end: toSec(endStr),
      text: textLines.join(" ").trim(),
    });
  }
  return segments;
}

function runProcess(spawnFn, binary, args) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(binary, args);
    let err = "";
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} exit ${code}: ${err}`));
    });
    proc.on("error", reject);
  });
}

export function createWhisperRunner({
  binary = "whisper-cli",
  ffmpegBinary = "ffmpeg",
  modelPath,
  spawn = nodeSpawn,
}) {
  async function runWhisper(audioPath) {
    const isWav = audioPath.toLowerCase().endsWith(".wav");
    const wavPath = isWav ? audioPath : `${audioPath}.whisper.wav`;
    let tempWav = null;
    if (!isWav) {
      await runProcess(spawn, ffmpegBinary, [
        "-y", "-i", audioPath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wavPath,
      ]);
      tempWav = wavPath;
    }
    const srtPath = `${wavPath}.srt`;
    try {
      await runProcess(spawn, binary, ["-m", modelPath, "-l", "en", "-osrt", "-of", wavPath, wavPath]);
      return readFileSync(srtPath, "utf8");
    } finally {
      for (const p of [tempWav, srtPath]) {
        if (p && existsSync(p)) {
          try { unlinkSync(p); } catch { /* ignore */ }
        }
      }
    }
  }
  return { runWhisper };
}
