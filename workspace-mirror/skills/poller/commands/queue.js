export function createQueueCommand(draftStore) {
  return async function queueCommand(chatId, args, client) {
    const ids = draftStore.listPending();
    if (ids.length === 0) {
      await client.sendMessage(chatId, "No pending drafts.");
      return;
    }
    const lines = ids.map((id) => {
      const { draft, state } = draftStore.readDraft(id);
      return `• ${id} [${state?.status || "unknown"}] — ${draft?.mode || "?"}: ${draft?.topic || ""}`;
    });
    await client.sendMessage(chatId, `Pending drafts (${ids.length}):\n${lines.join("\n")}`);
  };
}
