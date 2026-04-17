#!/usr/bin/env node
import { createLogger } from "shared/jsonl-logger";
import { sendNightlyReport } from "../index.js";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
const sandbox = args.includes("--sandbox");
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;
const WORKSPACE = `${HOME}/.openclaw/workspace`;
const logger = createLogger(`${DRAFTS}/logs/agent.jsonl`);

async function main() {
  const { createTelegramClient } = await import(`${WORKSPACE}/skills/shared/telegram-client.js`);
  const yaml = (await import("js-yaml")).default;
  const { readFileSync } = await import("node:fs");
  const tgConfig = yaml.load(readFileSync(`${WORKSPACE}/config/telegram.yaml`, "utf8"));
  const token = process.env[tgConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
  const chatId = tgConfig.paired_user_id;
  const telegramClient = createTelegramClient(token);
  try {
    const res = await sendNightlyReport({
      drafts: DRAFTS, telegramClient, chatId, logger, now: new Date(),
    });
    console.log(JSON.stringify({ ok: res.ok }));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
