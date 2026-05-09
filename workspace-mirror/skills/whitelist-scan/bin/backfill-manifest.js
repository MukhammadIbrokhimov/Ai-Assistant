#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBackfillManifest } from "../backfill-manifest.js";

const run = promisify(execFile);
const sourceId = process.argv[2];
if (!sourceId) {
  console.error("Usage: backfill-manifest.js <source-id>");
  process.exit(2);
}

const HOME = process.env.HOME;
const audioDir = `${HOME}/openclaw-drafts/whitelist/audio-cache/${sourceId}`;
const videoDir = `${HOME}/openclaw-drafts/whitelist/video-cache/${sourceId}`;
const manifestPath = join(audioDir, "manifest.json");

if (!existsSync(audioDir)) {
  console.error(`audio cache directory not found: ${audioDir}`);
  process.exit(1);
}
if (!existsSync(videoDir)) {
  console.error(`video cache directory not found: ${videoDir}`);
  process.exit(1);
}

async function probeDurationS(videoPath) {
  try {
    const { stdout } = await run("ffprobe", [
      "-i", videoPath,
      "-show_entries", "format=duration",
      "-v", "quiet",
      "-of", "csv=p=0",
    ]);
    const v = parseFloat(stdout.trim());
    if (!Number.isFinite(v)) throw new Error(`unparseable duration: ${stdout}`);
    return v;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("ffprobe not found. Install via: brew install ffmpeg");
      process.exit(1);
    }
    throw err;
  }
}

async function fetchVideoMeta(episodeId) {
  try {
    const { stdout } = await run("yt-dlp", [
      "--skip-download",
      "--print", "%(title)s|||%(upload_date)s",
      `https://youtu.be/${episodeId}`,
    ]);
    const [title, uploadDate] = stdout.trim().split("|||");
    let publishedAt = null;
    if (uploadDate && /^\d{8}$/.test(uploadDate)) {
      publishedAt = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`;
    }
    return { title, publishedAt };
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("yt-dlp not found. Install via: brew install yt-dlp");
      process.exit(1);
    }
    throw err;
  }
}

const bf = createBackfillManifest({
  listAudio: () => readdirSync(audioDir),
  listVideo: () => readdirSync(videoDir),
  fileExists: (p) => existsSync(p),
  readManifest: () => existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
  writeManifest: (m) => {
    const tmp = manifestPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, manifestPath);
  },
  probeDurationS,
  fetchVideoMeta,
  sourceId,
  audioDir,
  videoDir,
  log: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
});

const { manifest } = await bf.run();
console.log(JSON.stringify({ source: sourceId, episodes: manifest.episodes.length, manifest_path: manifestPath }));
