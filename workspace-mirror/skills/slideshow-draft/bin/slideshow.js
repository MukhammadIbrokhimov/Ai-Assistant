#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createPexelsClient } from "../pexels.js";
import { createSlideshowDraft } from "../index.js";

const topic = process.argv[2];
const niche = process.argv[3];
if (!topic || !niche) {
  console.error("Usage: bin/slideshow.js \"<topic>\" <niche>");
  process.exit(1);
}

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const pexels = createPexelsClient({ apiKey: process.env.PEXELS_API_KEY });

const ss = createSlideshowDraft({
  router,
  pexelsSearch: pexels.searchOne,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeMedia: (path, content) => writeFileSync(path, content),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-slideshow-${rand}`;
  },
});

const result = await ss.run({ topic, niche });
console.log(result.dir);
