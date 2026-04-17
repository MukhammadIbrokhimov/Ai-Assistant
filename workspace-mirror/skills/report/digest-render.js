export function renderDigest(d) {
  const lines = [];
  lines.push(`🌙 Daily report · ${d.date}`);
  if (d.produced === 0) {
    lines.push("Quiet day — no drafts produced.");
    return lines.join("\n");
  }
  const modeBreakdown = Object.entries(d.byMode)
    .filter(([, n]) => n > 0)
    .map(([mode, n]) => `${n} ${mode}`).join(", ");
  lines.push(`Produced: ${d.produced} drafts${modeBreakdown ? ` (${modeBreakdown})` : ""}`);
  lines.push(`Approved: ${d.approved} · Modified: ${d.modified} · Rejected: ${d.rejected} · Pending: ${d.pending}`);
  if (d.topRejectionReason) lines.push(`Top rejection reason: "${d.topRejectionReason}"`);
  if (d.providerMix?.length) {
    const mix = d.providerMix.map(p => `${p.provider} (${Math.round(p.pct)}%)`).join(", ");
    lines.push(`Provider mix: ${mix}`);
  }
  lines.push(`Spend: $${d.spendUsd.toFixed(2)}`);
  if (d.spendCapHit) lines.push(`Spend cap hit at ${d.spendCapHit.at} — downgraded to local`);
  return lines.join("\n");
}
