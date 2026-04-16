import { formatTemplateB } from "shared/constants";

export async function archiveDraft(draftId, { draftStore, telegramClient }) {
  const { draft, state } = draftStore.readDraft(draftId);

  if (state.status === "approved") {
    const dateStr = state.resolved_at.slice(0, 10);
    draftStore.updateDraftStatus(draftId, "approved");
    const dest = draftStore.moveToApproved(draftId, dateStr);
    const text = formatTemplateB(draft, dest);
    await telegramClient.sendMessage(state.telegram_chat_id, text);
  } else if (state.status === "rejected") {
    const dateStr = state.resolved_at.slice(0, 10);
    draftStore.updateDraftStatus(draftId, "rejected");
    draftStore.moveToRejected(draftId, dateStr);
  }
  // Other statuses (pending, modifying, superseded) — no-op
}
