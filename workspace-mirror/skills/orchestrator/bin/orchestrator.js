#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createLogger } from "shared/jsonl-logger";
import { createQuietQueue } from "shared/quiet-queue";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : (args.includes(`--${name}`) ? true : fallback);
}

const job = arg("job");
const sandbox = !!arg("sandbox", false);
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;
const WORKSPACE = `${HOME}/.openclaw/workspace`;

const logger = createLogger(`${DRAFTS}/logs/agent.jsonl`);
const quietQueue = createQuietQueue({ path: `${DRAFTS}/state/quiet-queue.jsonl` });

if (!job) {
  console.error("orchestrator: --job=<daily-loop|flush-quiet-queue|source-discovery-pull> required");
  process.exit(2);
}

async function loadSkillsAndRouter() {
  const { createRouter } = await import(`${WORKSPACE}/skills/provider-router/router.js`);
  const ollama = (await import(`${WORKSPACE}/skills/provider-router/providers/ollama.js`)).default;
  const anthropic = (await import(`${WORKSPACE}/skills/provider-router/providers/anthropic.js`)).default;
  const { createResearch } = await import(`${WORKSPACE}/skills/research/index.js`);
  const { createSlideshowDraft } = await import(`${WORKSPACE}/skills/slideshow-draft/index.js`);
  const { createPexelsClient } = await import(`${WORKSPACE}/skills/slideshow-draft/pexels.js`);
  const { createQuotecardDraft, createRenderCard } = await import(`${WORKSPACE}/skills/quotecard-draft/index.js`);
  const { createClipExtract } = await import(`${WORKSPACE}/skills/clip-extract/index.js`);
  const { createFfmpegRunner } = await import(`${WORKSPACE}/skills/clip-extract/ffmpeg.js`);
  const { createTelegramClient } = await import(`${WORKSPACE}/skills/shared/telegram-client.js`);
  const { createDraftStore } = await import(`${WORKSPACE}/skills/shared/draft-store.js`);
  const { sendForApproval } = await import(`${WORKSPACE}/skills/approval/approval.js`);

  const router = createRouter({
    configPath: `${WORKSPACE}/config/providers.yaml`,
    adapters: { ollama, anthropic },
    logPath: `${DRAFTS}/logs/router.jsonl`,
  });

  const draftStore = createDraftStore(DRAFTS);

  const tgConfig = yaml.load(readFileSync(`${WORKSPACE}/config/telegram.yaml`, "utf8"));
  const token = process.env[tgConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
  const chatId = tgConfig.paired_user_id;
  const telegramClient = createTelegramClient(token);

  const commonWriteDraft = (id, d) => {
    const dir = `${DRAFTS}/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  };
  const mkdirp = (p) => mkdirSync(p, { recursive: true });
  const now = () => new Date();
  const idFor = (mode) =>
    `${new Date().toISOString().slice(0, 10)}-${mode}-${Math.random().toString(36).slice(2, 6)}`;

  const research = createResearch({
    readFileSync,
    nichesPath: `${WORKSPACE}/config/niches.yaml`,
    browserSearch: async () => [],
    router,
  });

  const pexels = process.env.PEXELS_API_KEY
    ? createPexelsClient({ apiKey: process.env.PEXELS_API_KEY })
    : null;
  const slideshowDraft = pexels
    ? createSlideshowDraft({
        router,
        pexelsSearch: pexels.searchOne,
        writeDraft: commonWriteDraft,
        writeMedia: (p, c) => writeFileSync(p, c),
        mkdirp,
        now,
        draftsRoot: DRAFTS,
        idGenerator: () => idFor("slideshow"),
      })
    : { run: async () => { throw new Error("PEXELS_API_KEY not set"); } };

  const quotecardDraft = createQuotecardDraft({
    router,
    renderCard: createRenderCard({
      pythonBin: `${WORKSPACE}/.venv/bin/python3`,
      scriptPath: `${WORKSPACE}/skills/quotecard-draft/render.py`,
    }),
    writeDraft: commonWriteDraft,
    mkdirp,
    now,
    draftsRoot: DRAFTS,
    idGenerator: () => idFor("quotecard"),
  });

  const clipExtract = createClipExtract({
    router,
    runFfmpeg: createFfmpegRunner(),
    writeDraft: commonWriteDraft,
    writeFileSync,
    mkdirp,
    now,
    draftsRoot: DRAFTS,
    idGenerator: () => idFor("clip"),
  });

  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runSub = promisify(execFileCb);
  const sourceDiscovery = {
    async runPull(niche) {
      await runSub(process.execPath, [
        `${WORKSPACE}/skills/source-discovery/bin/discover.js`,
        `--niche=${niche}`,
      ]);
    },
  };

  return {
    router, draftStore, telegramClient, chatId,
    skills: { research, slideshowDraft, quotecardDraft, clipExtract },
    sourceDiscovery,
    approval: { sendForApproval: (id) => sendForApproval(id, { telegramClient, draftStore, chatId }) },
  };
}

function loadTranscripts() {
  const root = `${DRAFTS}/whitelist/transcript-cache`;
  if (!existsSync(root)) return [];
  const out = [];
  for (const source of readdirSync(root, { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    for (const f of readdirSync(join(root, source.name))) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(root, source.name, f), "utf8"))); } catch {}
    }
  }
  return out;
}

async function main() {
  try {
    if (job === "daily-loop") {
      const { runDailyLoop } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await runDailyLoop({
        clock: new Date(),
        providerRouter: d.router,
        skills: d.skills,
        approval: d.approval,
        quietQueue,
        logger,
        paths: { workspace: WORKSPACE, drafts: DRAFTS },
        transcripts: loadTranscripts(),
        telegramClient: d.telegramClient,
        chatId: d.chatId,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (job === "flush-quiet-queue") {
      const { flushQuietQueue } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await flushQuietQueue({
        queue: quietQueue,
        telegramClient: d.telegramClient,
        logger, chatId: d.chatId,
      });
      console.log(JSON.stringify(res));
    } else if (job === "source-discovery-pull") {
      const { runSourceDiscoveryPull } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await runSourceDiscoveryPull({
        sourceDiscovery: d.sourceDiscovery,
        logger,
        paths: { workspace: WORKSPACE, drafts: DRAFTS },
      });
      console.log(JSON.stringify(res));
    } else {
      console.error(`orchestrator: unknown --job=${job}`);
      process.exit(2);
    }
  } catch (err) {
    logger.errorjsonl(err, { phase: "cli", job });
    console.error(err);
    process.exit(1);
  }
}

main();
