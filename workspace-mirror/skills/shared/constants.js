export const STATUSES = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  MODIFYING: "modifying",
  SUPERSEDED: "superseded",
};

export const CALLBACK_PREFIXES = {
  APPROVE: "a:",
  MODIFY: "m:",
  REJECT: "r:",
};

export function formatTemplateA(draft) {
  const lines = [];
  lines.push(`🆕 Draft ${draft.id}  •  ${draft.mode.toUpperCase()} mode`);
  if (draft.source) {
    lines.push(`Source: ${draft.source.title} (${draft.source.license})`);
  }
  lines.push(`Topic: ${draft.topic}`);
  lines.push("");
  lines.push("📝 Caption preview:");
  lines.push(`"${draft.caption}"`);
  lines.push("");
  lines.push(draft.hashtags.join(" "));
  if (draft.media && draft.media.length > 0) {
    const m = draft.media[0];
    const parts = [m.type];
    if (m.duration_s) parts.push(`${m.duration_s}s`);
    lines.push("");
    lines.push(`🎬 Media: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatTemplateB(draft, destDir) {
  const lines = [];
  lines.push(`✅ READY TO POST  •  Draft ${draft.id}`);
  lines.push("");
  lines.push("═══ COPY THIS ═══");
  lines.push(draft.caption);
  lines.push("");
  lines.push(draft.hashtags.join(" "));
  lines.push("═════════════════");
  if (draft.media && draft.media.length > 0) {
    lines.push("");
    lines.push(`🎬 Media: ${destDir}/media/`);
  }
  lines.push("");
  lines.push(`Saved to: ${destDir}/`);
  return lines.join("\n");
}
