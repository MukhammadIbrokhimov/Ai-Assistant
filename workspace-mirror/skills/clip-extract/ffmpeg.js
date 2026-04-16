import { spawn } from "node:child_process";

// FFmpeg's filtergraph lexer treats : , [ ] ' \ as metacharacters inside
// option values. Inside subtitles=<path>, the path needs : -> \: , \ -> \\ ,
// ' -> \\\' .
export function escapeFilterPath(p) {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export function createFfmpegRunner({ binary = "ffmpeg" } = {}) {
  return async function runFfmpeg({ startS, endS, inputPath, outputPath, srtPath }) {
    const escapedSrt = escapeFilterPath(srtPath);
    const vf = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      `subtitles=${escapedSrt}:force_style='FontName=Inter,Fontsize=28,Alignment=2,OutlineColour=&H00000000,BorderStyle=3'`,
    ].join(",");
    const args = [
      "-y",
      "-ss", String(startS),
      "-to", String(endS),
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "23",
      "-c:a", "aac",
      "-r", "30",
      outputPath,
    ];
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args);
      let err = "";
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => code === 0 ? resolve(true) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`)));
      proc.on("error", reject);
    });
  };
}
