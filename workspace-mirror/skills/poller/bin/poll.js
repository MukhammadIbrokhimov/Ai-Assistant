#!/usr/bin/env node

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { createTelegramClient } from "shared/telegram-client";
import { createDraftStore } from "shared/draft-store";
import { createSourcesStore } from "shared/sources-store";
import { createPollLoop } from "../poller.js";
import { createSourceCallbackHandler } from "../source-callback.js";
import { archiveDraft } from "archive/archive.js";
import { sendForApproval } from "approval/approval.js";
import { createModeCommand } from "../commands/mode.js";
import { createStatusCommand } from "../commands/status.js";
import { createQueueCommand } from "../commands/queue.js";
import { createSpendCommand } from "../commands/spend.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { createSourcesCommand } from "../commands/sources.js";
import { helpCommand } from "../commands/help.js";
import { createCancelCommand } from "../commands/cancel.js";
import { createRouter } from "../../provider-router/router.js";
import ollamaAdapter from "../../provider-router/providers/ollama.js";
import anthropicAdapter from "../../provider-router/providers/anthropic.js";

// Paths
const workspacePath = join(homedir(), ".openclaw", "workspace");
const draftsPath = join(homedir(), "openclaw-drafts");
const configDir = join(workspacePath, "config");
const routerLogPath = join(workspacePath, "skills", "provider-router", "router.jsonl");
const providersPath = join(configDir, "providers.yaml");
const telegramPath = join(configDir, "telegram.yaml");

// Load .env
const envPath = join(workspacePath, ".env");
const envContent = readFileSync(envPath, "utf8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

// Load telegram config
const telegramConfig = yaml.load(readFileSync(telegramPath, "utf8"));
const token = process.env[telegramConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
if (!token) {
  console.error("TG_BOT_TOKEN not set. Check .env file.");
  process.exit(1);
}

const pairedUserId = telegramConfig.paired_user_id;
if (!pairedUserId) {
  console.error("paired_user_id not set in telegram.yaml.");
  process.exit(1);
}

// Initialize
const telegramClient = createTelegramClient(token);
const draftStore = createDraftStore(draftsPath);
const sourcesStore = createSourcesStore({ path: join(configDir, "sources.yaml") });

// Wire provider-router (M2) — modify flow now works end-to-end
const router = createRouter({
  configPath: providersPath,
  adapters: { ollama: ollamaAdapter, anthropic: anthropicAdapter },
  logPath: join(draftsPath, "logs", "router.jsonl"),
});

// Source-discovery callback handler (s: prefix)
const pendingSourceRoot = join(draftsPath, "pending-source");
const sourceCb = createSourceCallbackHandler({
  sourcesStore,
  readPendingSource: (id) => {
    const p = join(pendingSourceRoot, id, "state.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  },
  appendRejectedLog: (entry) => {
    const logsDir = join(draftsPath, "logs");
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "rejected-sources.jsonl"), JSON.stringify(entry) + "\n");
  },
  editMessage: ({ chatId, messageId, text }) =>
    telegramClient.editMessageText(chatId, messageId, text),
  movePendingToArchive: (id, bucket) => {
    const src = join(pendingSourceRoot, id);
    if (!existsSync(src)) return;
    const destBase = join(draftsPath, `${bucket}-source`);
    mkdirSync(destBase, { recursive: true });
    renameSync(src, join(destBase, id));
  },
});

// Build command map
const commands = {
  mode: createModeCommand(providersPath),
  status: createStatusCommand(draftStore),
  queue: createQueueCommand(draftStore),
  spend: createSpendCommand(routerLogPath, providersPath),
  cancel: createCancelCommand(draftStore),
  whoami: createWhoamiCommand(pairedUserId),
  sources: createSourcesCommand(sourcesStore),
  help: helpCommand,
};

const approval = { sendForApproval };
const archive = { archiveDraft };

const loop = createPollLoop({
  telegramClient,
  draftStore,
  archive,
  approval,
  router,
  pairedUserId,
  commands,
  sourceCb,
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  loop.stop();
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  loop.stop();
});

console.log(`Poller started. Listening for user ${pairedUserId}...`);
loop.run().then(() => {
  console.log("Poller stopped.");
  process.exit(0);
});
