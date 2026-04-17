export async function flushQuietQueue({ queue, telegramClient, logger, chatId }) {
  const entries = queue.drain();
  if (entries.length === 0) {
    logger.jsonl({ event: "flush_quiet_queue_noop" });
    return { flushed: 0 };
  }

  const header = `🌅 Good morning — ${entries.length} draft${entries.length === 1 ? "" : "s"} from last night`;
  const lines = [header, ""];
  for (const e of entries) {
    lines.push(`[Draft ${e.draft_id}] ${e.mode}: ${e.topic}`);
  }
  const buttons = entries.map(e => [
    { text: `Review ${e.draft_id.slice(-8)} →`, callback_data: `draft:${e.draft_id}` },
  ]);

  try {
    await telegramClient.sendMessage(chatId, lines.join("\n"), {
      reply_markup: { inline_keyboard: buttons },
    });
    queue.commitDrain();
    logger.jsonl({ event: "flush_quiet_queue_ok", flushed: entries.length });
    return { flushed: entries.length };
  } catch (err) {
    logger.errorjsonl(err, { phase: "flush_quiet_queue" });
    queue.putBack(entries);
    return { flushed: 0, putBack: entries.length };
  }
}
