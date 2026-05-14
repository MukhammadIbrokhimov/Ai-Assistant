#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { createSourcesStore } from "shared/sources-store";
import { createYtdlp } from "../ytdlp.js";
import { createWhitelistScan } from "../index.js";
import { createOllamaUnloader } from "../../transcribe/ollama-unload.js";
import { createWhisperRunner } from "../../transcribe/whisper.js";
import { createTranscribe } from "../../transcribe/index.js";

const sourcesPath = `${process.env.HOME}/.openclaw/workspace/config/sources.yaml`;
const cacheRoot = `${process.env.HOME}/openclaw-drafts/whitelist`;
const transcriptRoot = join(cacheRoot, "transcript-cache");

const sourcesStore = createSourcesStore({ path: sourcesPath });
const ytdlp = createYtdlp();

async function freeSpaceBytes() {
  const s = await statfs(cacheRoot);
  return Number(s.bavail) * Number(s.bsize);
}

const unloader = createOllamaUnloader();
const whisper = createWhisperRunner({
  modelPath: process.env.WHISPER_MODEL_PATH || `${process.env.HOME}/.whisper-models/ggml-large-v3.bin`,
});
const transcribe = createTranscribe({
  unloadOllama: unloader.unload,
  runWhisper: whisper.runWhisper,
  writeFileSync,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  transcriptRoot,
});

const scan = createWhitelistScan({
  sourcesStore,
  listNewVideos: ytdlp.listNewVideos,
  downloadAudio: ytdlp.downloadAudio,
  downloadVideo: ytdlp.downloadVideo,
  transcribe,
  readManifest: (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { episodes: [] },
  writeManifest: (p, m) => writeFileSync(p, JSON.stringify(m, null, 2)),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  freeSpaceBytes,
  now: () => new Date(),
  cacheRoot,
});

mkdirSync(cacheRoot, { recursive: true });
const result = await scan.run();
console.log(JSON.stringify(result));
