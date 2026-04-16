import { existsSync, readFileSync } from "node:fs";

export function computeCost(providerModel, tokensIn, tokensOut, costCfg) {
  // Try exact match first, then wildcard "<provider>:*".
  const provider = providerModel.split(":")[0];
  const exact = costCfg?.[providerModel];
  const wild = costCfg?.[`${provider}:*`];
  const rate = exact ?? wild;
  if (!rate) return 0;
  return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
}

export function todaySpendUsd(logPath, costCfg) {
  if (!existsSync(logPath)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let total = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.kind !== "call" || !entry.ok) continue;
    if (!entry.ts?.startsWith(today)) continue;
    const pm = `${entry.providerName}:${entry.modelName}`;
    total += computeCost(pm, entry.tokensIn ?? 0, entry.tokensOut ?? 0, costCfg);
  }
  return total;
}
