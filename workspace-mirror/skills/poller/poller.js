import { CALLBACK_PREFIXES, STATUSES } from "shared/constants";

export function isFromPairedUser(update, pairedUserId) {
  const from = update.callback_query?.from || update.message?.from;
  return from?.id === pairedUserId;
}

function parseCallbackData(data) {
  if (data.startsWith(CALLBACK_PREFIXES.APPROVE)) {
    return { action: "approve", draftId: data.slice(2) };
  }
  if (data.startsWith(CALLBACK_PREFIXES.MODIFY)) {
    return { action: "modify", draftId: data.slice(2) };
  }
  if (data.startsWith(CALLBACK_PREFIXES.REJECT)) {
    return { action: "reject", draftId: data.slice(2) };
  }
  return null;
}

export async function handleCallback(cbq, { telegramClient, draftStore, archive, sourceCb }) {
  // s: prefix is source-discovery callbacks (separate handler).
  if (sourceCb && cbq.data.startsWith("s:")) {
    await telegramClient.answerCallbackQuery(cbq.id, "");
    await sourceCb.handle({
      data: cbq.data,
      messageId: cbq.message.message_id,
      chatId: cbq.message.chat.id,
    });
    return;
  }

  const parsed = parseCallbackData(cbq.data);
  if (!parsed) return;

  const { action, draftId } = parsed;
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  const { draft } = draftStore.readDraft(draftId);
  const now = new Date().toISOString();

  if (action === "approve") {
    await telegramClient.answerCallbackQuery(cbq.id, "Approved!");
    draftStore.updateState(draftId, { status: STATUSES.APPROVED, resolved_at: now });
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n✅ Approved → posting queue`
    ).catch((err) => console.error(`editMessageText failed for ${draftId}:`, err));
    await archive.archiveDraft(draftId, { draftStore, telegramClient });
  } else if (action === "reject") {
    await telegramClient.answerCallbackQuery(cbq.id, "Rejected");
    draftStore.updateState(draftId, { status: STATUSES.REJECTED, resolved_at: now });
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n❌ Rejected`
    ).catch((err) => console.error(`editMessageText failed for ${draftId}:`, err));
    await archive.archiveDraft(draftId, { draftStore, telegramClient });
  } else if (action === "modify") {
    const existing = draftStore.findModifying();
    if (existing) {
      await telegramClient.answerCallbackQuery(
        cbq.id,
        "Another draft is being modified. Finish or /cancel that first."
      );
      return;
    }
    await telegramClient.answerCallbackQuery(cbq.id, "Send your changes");
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n✏️ Awaiting changes...`
    );
    draftStore.updateState(draftId, { status: STATUSES.MODIFYING });
  }
}

export async function handleModifyReply(message, { telegramClient, draftStore, router, approval }) {
  const modifyingId = draftStore.findModifying();
  if (!modifyingId) return;

  const { draft: oldDraft } = draftStore.readDraft(modifyingId);
  const chatId = message.chat.id;
  const feedback = message.text;

  const prompt = [
    `Original caption: "${oldDraft.caption}"`,
    `Topic: ${oldDraft.topic}`,
    `Hashtags: ${oldDraft.hashtags.join(" ")}`,
    "",
    `User feedback: ${feedback}`,
    "",
    "Rewrite the caption incorporating the feedback.",
  ].join("\n");

  const result = await router.complete({ taskClass: "write", prompt });

  // Supersede old draft
  draftStore.updateState(modifyingId, { status: STATUSES.SUPERSEDED });

  // Create new draft
  const newId = `${modifyingId}-mod-${Date.now()}`;
  const newDraft = {
    ...oldDraft,
    id: newId,
    caption: result.text,
    created_at: new Date().toISOString(),
    provider_used: result.providerUsed,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    status: "pending",
    parent_id: modifyingId,
  };
  draftStore.writeDraft(newId, newDraft);

  // Send new draft for approval
  await approval.sendForApproval(newId, { telegramClient, draftStore, chatId });
}

export function createPollLoop({ telegramClient, draftStore, archive, approval, router, pairedUserId, commands, sourceCb }) {
  let running = true;
  let offset = 0;
  let backoff = 1000;

  function stop() {
    running = false;
  }

  async function run() {
    while (running) {
      try {
        const updates = await telegramClient.getUpdates(offset, 30);
        backoff = 1000;
        for (const update of updates) {
          offset = update.update_id + 1;
          if (!isFromPairedUser(update, pairedUserId)) continue;

          try {
            if (update.callback_query) {
              await handleCallback(update.callback_query, {
                telegramClient,
                draftStore,
                archive,
                sourceCb,
              });
            } else if (update.message?.text?.startsWith("/")) {
              const text = update.message.text;
              const chatId = update.message.chat.id;
              const spaceIdx = text.indexOf(" ");
              const name = (spaceIdx === -1 ? text : text.slice(0, spaceIdx))
                .slice(1)
                .toLowerCase();
              const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
              const handler = commands[name];
              if (handler) {
                await handler(chatId, args, telegramClient);
              } else {
                await telegramClient.sendMessage(
                  chatId,
                  "Unknown command. Try /help"
                );
              }
            } else if (update.message?.text) {
              await handleModifyReply(update.message, {
                telegramClient,
                draftStore,
                router,
                approval,
              });
            }
          } catch (err) {
            console.error(`Error handling update ${update.update_id}:`, err);
          }
        }
      } catch (err) {
        console.error(`getUpdates failed, retrying in ${backoff}ms:`, err);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  return { run, stop };
}
