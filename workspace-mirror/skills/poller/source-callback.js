// Handles s:approve / s:reject callbacks from source-discovery candidates.
// Approve → append to sources.yaml via shared/sources-store; Reject → log.
// Both edit the original Telegram message and move the pending-source dir.

export function createSourceCallbackHandler(deps) {
  const { sourcesStore, readPendingSource, appendRejectedLog, editMessage, movePendingToArchive } = deps;

  async function handle({ data, messageId, chatId }) {
    const [, action, candidateId] = data.split(":");
    const pending = readPendingSource(candidateId);
    if (!pending) return { ok: false, reason: "not found" };
    const c = pending.candidate;

    if (action === "approve") {
      const id = (c.channel_handle || c.channel_id || c.candidate_id).replace(/^@/, "").toLowerCase();
      sourcesStore.append({
        id,
        creator: c.creator,
        type: "youtube_channel",
        url: c.url,
        license: c.license_type,
        license_evidence: c.license_evidence_url,
        attribution_required: true,
        attribution_template: c.attribution_template,
        poll_frequency_h: 24,
        niches: [c.niche],
        lastScanned: null,
      });
      if (movePendingToArchive) movePendingToArchive(candidateId, "approved");
      await editMessage({ chatId, messageId, text: `✅ Approved: ${c.creator} added to sources.yaml` });
      return { ok: true, action: "approved", id };
    }
    if (action === "reject") {
      appendRejectedLog({ candidate_id: candidateId, creator: c.creator, url: c.url, rejected_at: new Date().toISOString() });
      if (movePendingToArchive) movePendingToArchive(candidateId, "rejected");
      await editMessage({ chatId, messageId, text: `❌ Rejected: ${c.creator}` });
      return { ok: true, action: "rejected" };
    }
    return { ok: false, reason: `unknown action ${action}` };
  }

  return { handle };
}
