export function createStatusCommand(draftStore) {
  return async function statusCommand(chatId, args, client) {
    let gatewayOk = false;
    let ollamaOk = false;

    try {
      const res = await fetch("http://127.0.0.1:18789/health");
      gatewayOk = res.ok;
    } catch { /* unreachable */ }

    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags");
      ollamaOk = res.ok;
    } catch { /* unreachable */ }

    const pending = draftStore.listPending();
    const lines = [
      `Gateway: ${gatewayOk ? "✅ up" : "❌ down"}`,
      `Ollama: ${ollamaOk ? "✅ up" : "❌ down"}`,
      `Pending drafts: ${pending.length}`,
    ];
    await client.sendMessage(chatId, lines.join("\n"));
  };
}
