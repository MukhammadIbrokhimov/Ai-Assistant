export function createCancelCommand(draftStore) {
  return async function cancelCommand(chatId, args, client) {
    const modifyingId = draftStore.findModifying();
    if (!modifyingId) {
      await client.sendMessage(chatId, "Nothing to cancel — no draft is being modified.");
      return;
    }
    draftStore.updateState(modifyingId, { status: "pending" });
    await client.sendMessage(chatId, `Modify cancelled for ${modifyingId}. Draft restored to pending.`);
  };
}
