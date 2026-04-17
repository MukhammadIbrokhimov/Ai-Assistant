#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createOllamaUnloader } from "../ollama-unload.js";
import { createWhisperRunner } from "../whisper.js";
import { createTranscribe } from "../index.js";

const [audioPath, sourceId, episodeId, title, durationS] = process.argv.slice(2);
if (!audioPath || !sourceId || !episodeId) {
  console.error("Usage: bin/transcribe.js <audio-path> <source-id> <episode-id> [title] [duration-s]");
  process.exit(1);
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
  transcriptRoot: `${process.env.HOME}/openclaw-drafts/whitelist/transcript-cache`,
});

const { path } = await transcribe.run({
  audioPath, sourceId, episodeId,
  title: title || "Untitled", durationS: Number(durationS) || 0,
});
console.log(path);
