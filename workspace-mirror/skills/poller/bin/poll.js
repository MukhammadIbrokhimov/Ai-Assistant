#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { createTelegramClient } from "shared/telegram-client";
import { createDraftStore } from "shared/draft-store";
import { createPollLoop } from "../poller.js";
import { archiveDraft } from "archive/archive.js";
import { sendForApproval } from "approval/approval.js";
import { createModeCommand } from "../commands/mode.js";
import { createStatusCommand } from "../commands/status.js";
import { createQueueCommand } from "../commands/queue.js";
import { createSpendCommand } from "../commands/spend.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { helpCommand } from "../commands/help.js";
import { createCancelCommand } from "../commands/cancel.js";

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

// Build command map
const commands = {
  mode: createModeCommand(providersPath),
  status: createStatusCommand(draftStore),
  queue: createQueueCommand(draftStore),
  spend: createSpendCommand(routerLogPath, providersPath),
  cancel: createCancelCommand(draftStore),
  whoami: createWhoamiCommand(pairedUserId),
  help: helpCommand,
};

// Router not wired for M1 — modify flow will error if triggered without it
// Will be connected when provider-router is integrated
const router = null;

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
