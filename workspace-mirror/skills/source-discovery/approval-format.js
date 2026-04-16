export function formatCandidateMessage(c) {
  const lines = [];
  lines.push(`🔍 Candidate: ${c.creator}  •  ${c.channel_handle || c.channel_id} (${formatNum(c.subs)} subs)`);
  lines.push(`Niche: ${c.niche}  •  Velocity: ${c.velocity_score?.toFixed(2) || "?"}`);
  lines.push(`License: ${c.license_type}`);
  lines.push(``);
  lines.push(`Evidence:`);
  lines.push(`"${c.license_evidence_snippet}"`);
  lines.push(``);
  lines.push(`Attribution: ${c.attribution_template}`);
  return lines.join("\n");
}

export function candidateInlineKeyboard(c) {
  return {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `s:approve:${c.candidate_id}` },
      { text: "❌ Reject", callback_data: `s:reject:${c.candidate_id}` },
      { text: "🔗 Evidence", url: c.license_evidence_url },
    ]],
  };
}

function formatNum(n) {
  if (!n) return "?";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
