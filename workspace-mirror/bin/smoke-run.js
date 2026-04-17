#!/usr/bin/env node
/**
 * bin/smoke-run.js — runs the M2 pipeline once end-to-end.
 *
 * Modes:
 *   (default)   uses cached fixture transcript+video. Skips scan/transcribe.
 *               Produces 3 drafts (clip + slideshow + quotecard) and sends
 *               them via Telegram approval.
 *   --live      runs the full chain including yt-dlp + whisper (~60min cold).
 *   --sandbox   writes drafts under /tmp/openclaw-smoke/ and skips Telegram.
 *               Use for offline validation.
 *
 * Every smoke draft_id is prefixed `smoke-` for easy bulk cleanup:
 *   rm -rf ~/openclaw-drafts/pending/smoke-*
 *
 * Set OPENCLAW_LIVE=1 to import skill modules from ~/.openclaw/workspace/
 * instead of the workspace-mirror copy this script lives in.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME;
const here = dirname(fileURLToPath(import.meta.url));
const MIRROR = resolve(here, "..");
const LIVE_WS = `${HOME}/.openclaw/workspace`;
const WS = process.env.OPENCLAW_LIVE === "1" ? LIVE_WS : MIRROR;
const DRAFTS = `${HOME}/openclaw-drafts`;
const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const SANDBOX = args.includes("--sandbox");
const ORCHESTRATOR = args.includes("--orchestrator");
const draftsRoot = SANDBOX ? "/tmp/openclaw-smoke" : DRAFTS;
mkdirSync(`${draftsRoot}/pending`, { recursive: true });

if (ORCHESTRATOR) {
  const yaml = (await import("js-yaml")).default;
  const { readdirSync: rd } = await import("node:fs");
  const { join: jn } = await import("node:path");
  const { createRouter } = await import(`${WS}/skills/provider-router/router.js`);
  const ollama = (await import(`${WS}/skills/provider-router/providers/ollama.js`)).default;
  const anthropic = (await import(`${WS}/skills/provider-router/providers/anthropic.js`)).default;
  const { createResearch } = await import(`${WS}/skills/research/index.js`);
  const { createSlideshowDraft } = await import(`${WS}/skills/slideshow-draft/index.js`);
  const { createPexelsClient } = await import(`${WS}/skills/slideshow-draft/pexels.js`);
  const { createQuotecardDraft, createRenderCard } = await import(`${WS}/skills/quotecard-draft/index.js`);
  const { createClipExtract } = await import(`${WS}/skills/clip-extract/index.js`);
  const { createFfmpegRunner } = await import(`${WS}/skills/clip-extract/ffmpeg.js`);
  const { createTelegramClient } = await import(`${WS}/skills/shared/telegram-client.js`);
  const { createDraftStore } = await import(`${WS}/skills/shared/draft-store.js`);
  const { createQuietQueue } = await import(`${WS}/skills/shared/quiet-queue.js`);
  const { createLogger } = await import(`${WS}/skills/shared/jsonl-logger.js`);
  const { runDailyLoop } = await import(`${WS}/skills/orchestrator/index.js`);
  const { sendForApproval } = await import(`${WS}/skills/approval/approval.js`);

  const router = createRouter({
    configPath: `${LIVE_WS}/config/providers.yaml`,
    adapters: { ollama, anthropic },
    logPath: `${draftsRoot}/logs/router.jsonl`,
  });
  const quietQueue = createQuietQueue({ path: `${draftsRoot}/state/quiet-queue.jsonl` });
  const logger = createLogger(`${draftsRoot}/logs/agent.jsonl`);
  const draftStore = createDraftStore(draftsRoot);

  const tgConfig = yaml.load(readFileSync(`${LIVE_WS}/config/telegram.yaml`, "utf8"));
  const token = process.env[tgConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
  const chatId = tgConfig.paired_user_id;
  const realTg = SANDBOX
    ? { sendMessage: async () => ({ message_id: 0 }) }
    : createTelegramClient(token);

  const commonWriteDraft = (id, d) => {
    const dir = `${draftsRoot}/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  };
  const mkdirp = (p) => mkdirSync(p, { recursive: true });
  const now = () => new Date();
  const idFor = (mode) => `smoke-${new Date().toISOString().slice(0, 10)}-${mode}-${Math.random().toString(36).slice(2, 6)}`;

  const research = createResearch({
    readFileSync,
    nichesPath: `${LIVE_WS}/config/niches.yaml`,
    browserSearch: async () => [],
    router,
  });

  const pexels = process.env.PEXELS_API_KEY
    ? createPexelsClient({ apiKey: process.env.PEXELS_API_KEY })
    : null;
  const slideshowDraft = pexels
    ? createSlideshowDraft({
        router, pexelsSearch: pexels.searchOne,
        writeDraft: commonWriteDraft,
        writeMedia: (p, c) => writeFileSync(p, c),
        mkdirp, now, draftsRoot, idGenerator: () => idFor("slideshow"),
      })
    : { run: async () => { throw new Error("PEXELS_API_KEY not set"); } };

  const quotecardDraft = createQuotecardDraft({
    router,
    renderCard: createRenderCard({
      pythonBin: `${LIVE_WS}/.venv/bin/python3`,
      scriptPath: `${WS}/skills/quotecard-draft/render.py`,
    }),
    writeDraft: commonWriteDraft, mkdirp, now, draftsRoot,
    idGenerator: () => idFor("quotecard"),
  });

  const clipExtract = createClipExtract({
    router,
    runFfmpeg: createFfmpegRunner(),
    writeDraft: commonWriteDraft,
    writeFileSync, mkdirp, now, draftsRoot,
    idGenerator: () => idFor("clip"),
  });

  function loadTranscripts() {
    const root = `${draftsRoot}/whitelist/transcript-cache`;
    if (!existsSync(root)) return [];
    const out = [];
    for (const s of rd(root, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      for (const f of rd(jn(root, s.name))) {
        if (!f.endsWith(".json")) continue;
        try { out.push(JSON.parse(readFileSync(jn(root, s.name, f), "utf8"))); } catch {}
      }
    }
    return out;
  }

  const approvalWrap = {
    sendForApproval: async (id) => {
      if (SANDBOX) { console.log(`[smoke] sandbox: would send approval for ${id}`); return {}; }
      return sendForApproval(id, { telegramClient: realTg, draftStore, chatId });
    },
  };

  const res = await runDailyLoop({
    clock: new Date(),
    providerRouter: router,
    skills: { research, slideshowDraft, quotecardDraft, clipExtract },
    approval: approvalWrap,
    quietQueue,
    logger,
    paths: { workspace: LIVE_WS, drafts: draftsRoot },
    transcripts: loadTranscripts(),
    telegramClient: realTg,
    chatId,
  });
  console.log(`[smoke] orchestrator result:`, JSON.stringify(res, null, 2));
  process.exit(0);
}

console.log(`[smoke] WS=${WS}`);
console.log(`[smoke] draftsRoot=${draftsRoot}`);
console.log(`[smoke] mode: ${SANDBOX ? "sandbox" : LIVE ? "live" : "cached"}`);

const { createRouter } = await import(`${WS}/skills/provider-router/router.js`);
const ollama = (await import(`${WS}/skills/provider-router/providers/ollama.js`)).default;
const anthropic = (await import(`${WS}/skills/provider-router/providers/anthropic.js`)).default;
const { createResearch } = await import(`${WS}/skills/research/index.js`);
const { createSlideshowDraft } = await import(`${WS}/skills/slideshow-draft/index.js`);
const { createQuotecardDraft, createRenderCard } = await import(`${WS}/skills/quotecard-draft/index.js`);
const { createClipExtract } = await import(`${WS}/skills/clip-extract/index.js`);
const { createFfmpegRunner } = await import(`${WS}/skills/clip-extract/ffmpeg.js`);
const { createPexelsClient } = await import(`${WS}/skills/slideshow-draft/pexels.js`);
const { createSourcesStore } = await import(`${WS}/skills/shared/sources-store.js`);

const router = createRouter({
  configPath: `${LIVE_WS}/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${DRAFTS}/logs/router.jsonl`,
});

// 1. research
const research = createResearch({
  readFileSync,
  nichesPath: `${LIVE_WS}/config/niches.yaml`,
  browserSearch: async () => [],
  router,
});
const topics = await research.run("ai");
console.log(`[smoke] research → ${topics.length} topics`);
const topic = topics[0]?.topic || "AI agents replacing junior devs";
console.log(`[smoke] picked topic: ${topic}`);

// 2. clip-extract from cached fixture
const sourcesStore = createSourcesStore({ path: `${LIVE_WS}/config/sources.yaml` });
const lex = sourcesStore.get("lex-fridman");
if (!lex) {
  console.error("[smoke] no lex-fridman in sources.yaml — run Phase 1 seed");
  process.exit(1);
}
const manifestPath = `${DRAFTS}/whitelist/audio-cache/lex-fridman/manifest.json`;
const transcriptDir = `${DRAFTS}/whitelist/transcript-cache/lex-fridman`;
let d1 = null;
if (!existsSync(manifestPath) || !existsSync(transcriptDir)) {
  console.warn(`[smoke] no fixture at ${manifestPath} → skipping clip-extract`);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fixtureEp = manifest.episodes?.[0];
  if (!fixtureEp?.video_path) {
    console.warn("[smoke] fixture episode has no video_path → skipping clip-extract");
  } else {
    const transcriptPath = `${transcriptDir}/${fixtureEp.episode_id}.json`;
    if (!existsSync(transcriptPath)) {
      console.warn(`[smoke] no transcript at ${transcriptPath} → skipping clip-extract`);
    } else {
      const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
      const ffmpeg = createFfmpegRunner();
      const clipExtract = createClipExtract({
        router,
        runFfmpeg: ffmpeg,
        writeDraft: (id, d) => {
          const dir = `${draftsRoot}/pending/${id}`;
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
        },
        writeFileSync,
        mkdirp: (p) => mkdirSync(p, { recursive: true }),
        now: () => new Date(),
        draftsRoot,
        idGenerator: () => `smoke-${new Date().toISOString().slice(0, 10)}-clip-${Math.random().toString(36).slice(2, 6)}`,
      });
      ({ draft: d1 } = await clipExtract.run({ transcript, source: lex, videoPath: fixtureEp.video_path }));
      console.log(`[smoke] clip draft: ${d1.id}`);
    }
  }
}

// 3. slideshow (skipped if PEXELS_API_KEY missing or call fails)
let d2 = null;
if (!process.env.PEXELS_API_KEY) {
  console.warn("[smoke] PEXELS_API_KEY not set → skipping slideshow-draft");
} else {
  try {
    const pexels = createPexelsClient({ apiKey: process.env.PEXELS_API_KEY });
    const ss = createSlideshowDraft({
      router,
      pexelsSearch: pexels.searchOne,
      writeDraft: (id, d) => {
        const dir = `${draftsRoot}/pending/${id}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
      },
      writeMedia: (p, c) => writeFileSync(p, c),
      mkdirp: (p) => mkdirSync(p, { recursive: true }),
      now: () => new Date(),
      draftsRoot,
      idGenerator: () => `smoke-${new Date().toISOString().slice(0, 10)}-slideshow-${Math.random().toString(36).slice(2, 6)}`,
    });
    ({ draft: d2 } = await ss.run({ topic, niche: "ai" }));
    console.log(`[smoke] slideshow draft: ${d2.id}`);
  } catch (e) {
    console.warn(`[smoke] slideshow-draft failed: ${e.message} → skipping`);
  }
}

// 4. quotecard (Ollama-only — runs even without Pexels/Anthropic)
let d3 = null;
try {
  const renderCard = createRenderCard({
    pythonBin: `${LIVE_WS}/.venv/bin/python3`,
    scriptPath: `${WS}/skills/quotecard-draft/render.py`,
  });
  const qc = createQuotecardDraft({
    router,
    renderCard,
    writeDraft: (id, d) => {
      const dir = `${draftsRoot}/pending/${id}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
    },
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    now: () => new Date(),
    draftsRoot,
    idGenerator: () => `smoke-${new Date().toISOString().slice(0, 10)}-quotecard-${Math.random().toString(36).slice(2, 6)}`,
  });
  ({ draft: d3 } = await qc.run({ topic, niche: "ai" }));
  console.log(`[smoke] quotecard draft: ${d3.id}`);
} catch (e) {
  console.warn(`[smoke] quotecard-draft failed: ${e.message} → skipping`);
}

// 5. send for approval (skipped in sandbox)
if (SANDBOX) {
  console.log("[smoke] sandbox mode: skipping Telegram send");
  process.exit(0);
}
const approval = await import(`${WS}/skills/approval/approval.js`);
const { createTelegramClient } = await import(`${WS}/skills/shared/telegram-client.js`);
const yaml = (await import("js-yaml")).default;
const { createDraftStore } = await import(`${WS}/skills/shared/draft-store.js`);

const tgConfig = yaml.load(readFileSync(`${LIVE_WS}/config/telegram.yaml`, "utf8"));
const token = process.env[tgConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
const chatId = tgConfig.paired_user_id;
const tg = createTelegramClient(token);
const draftStore = createDraftStore(draftsRoot);

for (const draft of [d1, d2, d3].filter(Boolean)) {
  try {
    await approval.sendForApproval(draft.id, { telegramClient: tg, draftStore, chatId });
    console.log(`[smoke] sent ${draft.id}`);
  } catch (e) {
    console.error(`[smoke] send failed for ${draft.id}: ${e.message}`);
  }
}
console.log("[smoke] done");
