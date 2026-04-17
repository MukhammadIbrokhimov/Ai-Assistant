import { readdirSync, statSync, unlinkSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";
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

const PRUNABLE_SUBDIRS = [
  "whitelist/audio-cache",
  "whitelist/video-cache",
  "whitelist/transcript-cache",
  "pexels-cache",
];

export function pruneCache({ drafts, retainDays, now = new Date() }) {
  const cutoff = now.getTime() - retainDays * 86400 * 1000;
  let pruned = 0;

  function walkAndPrune(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndPrune(p);
        try {
          const remaining = readdirSync(p);
          if (remaining.length === 0) rmdirSync(p);
        } catch {}
      } else {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          pruned++;
        }
      }
    }
  }

  for (const sub of PRUNABLE_SUBDIRS) {
    walkAndPrune(join(drafts, sub));
  }

  return { pruned };
}
