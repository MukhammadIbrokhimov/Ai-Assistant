const HELP_TEXT = [
  "Available commands:",
  "/mode [local|hybrid|premium] — View or change provider mode",
  "/status — Daemon health, pending drafts",
  "/queue — List pending drafts",
  "/spend [cap N] — View spend or set daily cap",
  "/cancel — Cancel current modify, restore draft to pending",
  "/whoami — Show paired user ID",
  "/help — This message",
].join("\n");

export async function helpCommand(chatId, args, client) {
  await client.sendMessage(chatId, HELP_TEXT);
}
