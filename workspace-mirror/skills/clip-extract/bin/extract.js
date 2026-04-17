#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createFfmpegRunner } from "../ffmpeg.js";
import { createClipExtract } from "../index.js";

const [transcriptPath, sourceId] = process.argv.slice(2);
if (!transcriptPath || !sourceId) { console.error("Usage: bin/extract.js <transcript-path> <source-id>"); process.exit(1); }

const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
const sources = yaml.load(readFileSync(`${process.env.HOME}/.openclaw/workspace/config/sources.yaml`, "utf8"));
const source = sources.sources.find(s => s.id === sourceId);
if (!source) { console.error(`source ${sourceId} not found`); process.exit(1); }

const manifestPath = `${process.env.HOME}/openclaw-drafts/whitelist/audio-cache/${sourceId}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ep = manifest.episodes.find(e => e.episode_id === transcript.episode_id);
if (!ep?.video_path) { console.error(`video not cached for ${transcript.episode_id}`); process.exit(1); }

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});
const ffmpeg = createFfmpegRunner();

const ce = createClipExtract({
  router,
  runFfmpeg: ffmpeg,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeFileSync,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => `${new Date().toISOString().slice(0,10)}-clip-${Math.random().toString(36).slice(2,6)}`,
});

const { dir } = await ce.run({ transcript, source, videoPath: ep.video_path });
console.log(dir);
