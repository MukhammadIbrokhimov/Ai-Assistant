import { formatTemplateA, CALLBACK_PREFIXES } from "shared/constants";

export async function sendForApproval(draftId, { telegramClient, draftStore, chatId }) {
  const { draft } = draftStore.readDraft(draftId);
  const text = formatTemplateA(draft);

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `${CALLBACK_PREFIXES.APPROVE}${draftId}` },
        { text: "✏️ Modify", callback_data: `${CALLBACK_PREFIXES.MODIFY}${draftId}` },
        { text: "❌ Reject", callback_data: `${CALLBACK_PREFIXES.REJECT}${draftId}` },
      ],
    ],
  };

  const result = await telegramClient.sendMessage(chatId, text, {
    reply_markup: keyboard,
  });

  draftStore.writeState(draftId, {
    status: "pending",
    telegram_message_id: result.message_id,
    telegram_chat_id: chatId,
    sent_at: new Date().toISOString(),
    resolved_at: null,
    reject_reason: null,
  });

  return { messageId: result.message_id };
}
