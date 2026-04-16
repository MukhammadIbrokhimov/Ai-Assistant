import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

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

export function createWhisperRunner({ binary = "whisper-cli", modelPath }) {
  async function runWhisper(audioPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-m", modelPath, "-l", "en", "-osrt", "-of", audioPath, audioPath]);
      let err = "";
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`whisper exit ${code}: ${err}`));
        try {
          const srt = readFileSync(`${audioPath}.srt`, "utf8");
          resolve(srt);
        } catch (e) {
          reject(e);
        }
      });
      proc.on("error", reject);
    });
  }
  return { runWhisper };
}
