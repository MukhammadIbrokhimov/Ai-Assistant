import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MS_24H = 24 * 60 * 60 * 1000;

function readJsonlIfExists(p) {
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function walkDrafts(dir, onDraft) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    const draftPath = join(p, "draft.json");
    if (existsSync(draftPath)) {
      try { onDraft(JSON.parse(readFileSync(draftPath, "utf8"))); } catch {}
    } else {
      walkDrafts(p, onDraft);
    }
  }
}

function inLast24h(ts, now) {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  return now.getTime() - t <= MS_24H;
}

export async function gatherDigestData({ drafts, now = new Date() }) {
  const byBucket = { pending: 0, approved: 0, rejected: 0 };
  const byMode = { clip: 0, slideshow: 0, quotecard: 0 };

  for (const bucket of ["pending", "approved", "rejected"]) {
    walkDrafts(join(drafts, bucket), (d) => {
      if (!inLast24h(d.created_at, now)) return;
      byBucket[bucket]++;
      if (byMode[d.mode] !== undefined) byMode[d.mode]++;
    });
  }

  const rejectionsLines = readJsonlIfExists(join(drafts, "logs/rejections.jsonl"))
    .filter(l => inLast24h(l.ts, now));
  const rejectionCounts = new Map();
  for (const r of rejectionsLines) {
    rejectionCounts.set(r.reason, (rejectionCounts.get(r.reason) || 0) + 1);
  }
  const topRejection = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const routerLines = readJsonlIfExists(join(drafts, "logs/router.jsonl"))
    .filter(l => inLast24h(l.ts, now));
  const calls = routerLines.filter(l => !l.event);
  let spendUsd = 0;
  const providerCounts = new Map();
  for (const l of calls) {
    spendUsd += Number(l.cost_usd || 0);
    if (l.provider) providerCounts.set(l.provider, (providerCounts.get(l.provider) || 0) + 1);
  }
  const totalCalls = calls.length || 1;
  const providerMix = [...providerCounts.entries()]
    .map(([provider, n]) => ({ provider, pct: (n / totalCalls) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const capHit = routerLines.find(l => l.event === "spend_cap_hit");
  const spendCapHit = capHit ? {
    at: new Date(capHit.ts).toISOString().slice(11, 16),
    spentUsd: Number(capHit.spent_usd || 0),
  } : null;

  return {
    produced: byBucket.pending + byBucket.approved + byBucket.rejected,
    pending: byBucket.pending,
    approved: byBucket.approved,
    rejected: byBucket.rejected,
    modified: 0,
    byMode,
    topRejectionReason: topRejection ? topRejection[0] : null,
    spendUsd,
    providerMix,
    spendCapHit,
    date: now.toISOString().slice(0, 10),
  };
}
