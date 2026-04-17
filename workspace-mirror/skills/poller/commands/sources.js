import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function createSourcesCommand(sourcesStore) {
  return async function sourcesCommand(chatId, args, client) {
    const parts = args.trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      const list = sourcesStore.list();
      const msg = list.length === 0
        ? "No sources configured. Use `/sources propose <youtube_url>` or run discovery."
        : list.map((s) => `• ${s.id} — ${s.creator} (${s.license})`).join("\n");
      await client.sendMessage(chatId, msg);
      return;
    }

    if (parts[0] === "propose" && parts[1]) {
      await client.sendMessage(chatId, `Evaluating ${parts[1]}...`);
      const discoverPath = join(homedir(), ".openclaw", "workspace", "skills", "source-discovery", "bin", "discover.js");
      spawn("node", [discoverPath, `--url=${parts[1]}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    }

    if (parts[0] === "remove" && parts[1]) {
      try {
        sourcesStore.remove(parts[1]);
        await client.sendMessage(chatId, `Removed: ${parts[1]}`);
      } catch (e) {
        await client.sendMessage(chatId, `Remove failed: ${e.message}`);
      }
      return;
    }

    await client.sendMessage(
      chatId,
      "Usage:\n/sources               — list\n/sources propose <url> — evaluate a candidate\n/sources remove <id>   — remove from whitelist"
    );
  };
}
