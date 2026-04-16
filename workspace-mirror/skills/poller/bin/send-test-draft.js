#!/usr/bin/env node

/**
 * Helper script: creates a test draft on disk and sends it for approval via Telegram.
 *
 * Usage:
 *   node bin/send-test-draft.js [draft-id]
 *
 * If no draft-id is given, generates one like "test-YYYYMMDD-HHMMSS".
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { createTelegramClient } from "shared/telegram-client";
import { createDraftStore } from "shared/draft-store";
import { sendForApproval } from "approval/approval.js";

// Paths
const workspacePath = join(homedir(), ".openclaw", "workspace");
const draftsPath = join(homedir(), "openclaw-drafts");
const telegramPath = join(workspacePath, "config", "telegram.yaml");
const envPath = join(workspacePath, ".env");

// Load .env
const envContent = readFileSync(envPath, "utf8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

// Load telegram config
const telegramConfig = yaml.load(readFileSync(telegramPath, "utf8"));
const token = process.env[telegramConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
const pairedUserId = telegramConfig.paired_user_id;

if (!token) { console.error("TG_BOT_TOKEN not set"); process.exit(1); }
if (!pairedUserId) { console.error("paired_user_id not set"); process.exit(1); }

// Generate draft ID
const now = new Date();
const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const draftId = process.argv[2] || `test-${ts}`;

// Create draft on disk
const draftData = {
  id: draftId,
  created_at: now.toISOString(),
  mode: "quotecard",
  topic: "Productivity tips",
  niche: "make-money-with-ai",
  caption: "Focus is a superpower. The ability to say no to everything except the one thing that matters is what separates the top 1% from everyone else.",
  hashtags: ["#productivity", "#focus", "#success", "#mindset", "#growth"],
  media: [],
  source: null,
  provider_used: "manual",
  tokens_in: 0,
  tokens_out: 0,
  status: "pending",
  parent_id: null,
};

const draftDir = join(draftsPath, "pending", draftId);
mkdirSync(draftDir, { recursive: true });
writeFileSync(join(draftDir, "draft.json"), JSON.stringify(draftData, null, 2));
console.log(`Draft created: ${draftDir}/draft.json`);

// Send for approval
const client = createTelegramClient(token);
const store = createDraftStore(draftsPath);

try {
  const result = await sendForApproval(draftId, {
    telegramClient: client,
    draftStore: store,
    chatId: pairedUserId,
  });
  console.log(`Sent to Telegram! Message ID: ${result.messageId}`);
  console.log(`Draft ID: ${draftId}`);
  console.log("\nNow open Telegram and tap a button.");
} catch (err) {
  console.error("Failed to send:", err.message);
  process.exit(1);
}
