#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollamaAdapter from "../../provider-router/providers/ollama.js";
import anthropicAdapter from "../../provider-router/providers/anthropic.js";
import { createResearch } from "../index.js";

const niche = process.argv[2];
if (!niche) {
  console.error("Usage: bin/research.js <niche>");
  process.exit(1);
}

const router = createRouter({
  configPath: process.env.OPENCLAW_PROVIDERS_YAML || `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama: ollamaAdapter, anthropic: anthropicAdapter },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const browserSearch = async (query) => {
  if (!process.env.OPENCLAW_BROWSER_URL) throw new Error("no browser tool configured");
  const r = await fetch(`${process.env.OPENCLAW_BROWSER_URL}/search?q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`browser HTTP ${r.status}`);
  const body = await r.json();
  return body.results || [];
};

const research = createResearch({
  readFileSync,
  nichesPath: `${process.env.HOME}/.openclaw/workspace/config/niches.yaml`,
  browserSearch,
  router,
});

const topics = await research.run(niche);
console.log(JSON.stringify(topics, null, 2));
