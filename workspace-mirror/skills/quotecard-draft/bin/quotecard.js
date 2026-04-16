#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createRenderCard, createQuotecardDraft } from "../index.js";

const [topic, contextPath] = process.argv.slice(2);
if (!topic) { console.error("Usage: bin/quotecard.js \"<topic>\" [<context-path>]"); process.exit(1); }

const sourceContext = contextPath ? readFileSync(contextPath, "utf8") : null;

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const here = dirname(fileURLToPath(import.meta.url));
const renderCard = createRenderCard({
  pythonBin: `${process.env.HOME}/.openclaw/workspace/.venv/bin/python3`,
  scriptPath: resolve(here, "..", "render.py"),
});

const q = createQuotecardDraft({
  router,
  renderCard,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => {
    const d = new Date();
    const stamp = d.toISOString().slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-quotecard-${rand}`;
  },
});

const { dir } = await q.run({ topic, niche: "ai", sourceContext });
console.log(dir);
