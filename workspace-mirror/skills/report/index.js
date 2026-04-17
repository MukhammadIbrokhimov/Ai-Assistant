import { gatherDigestData } from "./digest-data.js";
import { renderDigest } from "./digest-render.js";

export { gatherDigestData, renderDigest };

export async function sendNightlyReport({ drafts, telegramClient, chatId, logger, now }) {
  const data = await gatherDigestData({ drafts, now });
  const text = renderDigest(data);
  try {
    await telegramClient.sendMessage(chatId, text);
    logger.jsonl({ event: "report_sent", produced: data.produced, spend_usd: data.spendUsd });
    return { ok: true, text };
  } catch (err) {
    logger.errorjsonl(err, { phase: "nightly_report" });
    throw err;
  }
}
