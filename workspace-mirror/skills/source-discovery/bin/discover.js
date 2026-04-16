#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createTelegramClient } from "shared/telegram-client";
import { createYouTubeClient } from "../youtube-api.js";
import { createSourceDiscovery } from "../index.js";
import { formatCandidateMessage, candidateInlineKeyboard } from "../approval-format.js";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split("=").map(s => s.replace(/^--/, ""))));
if (!args.url && !args.niche) { console.error("Usage: bin/discover.js --url=<url> [--niche=ai]  OR  --niche=ai"); process.exit(1); }

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const youtube = createYouTubeClient({ apiKey: process.env.YOUTUBE_API_KEY });

const browser = {
  async fetchPage(url) {
    const r = await fetch(url, { headers: { "user-agent": "openclaw-sourcedisco/0.1" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ")
                     .replace(/<style[\s\S]*?<\/style>/g, " ")
                     .replace(/<[^>]+>/g, " ")
                     .replace(/&nbsp;/g, " ")
                     .replace(/\s+/g, " ").trim();
    return { text, url };
  },
};

const tg = createTelegramClient({ botToken: process.env.TG_BOT_TOKEN, chatId: Number(process.env.TG_PAIRED_USER_ID) });

const pendingRoot = `${process.env.HOME}/openclaw-drafts/pending-source`;
const pendingSourceStore = {
  create(c) {
    const dir = `${pendingRoot}/${c.candidate_id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "pending", candidate: c }, null, 2));
  },
};

const telegramSendCandidate = async (c) => {
  const text = formatCandidateMessage(c);
  return tg.sendMessage({ text, reply_markup: candidateInlineKeyboard(c) });
};

const sd = createSourceDiscovery({
  youtube, browser, router, telegramSendCandidate, pendingSourceStore,
  now: () => new Date(),
  idGenerator: () => `${new Date().toISOString().slice(0,10)}-cand-${Math.random().toString(36).slice(2, 8)}`,
});

const result = args.url ? await sd.runPush(args.url, args.niche || "ai") : await sd.runPull(args.niche);
console.log(JSON.stringify(result, null, 2));
