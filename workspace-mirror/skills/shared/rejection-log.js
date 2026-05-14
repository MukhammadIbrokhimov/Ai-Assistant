import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function logsPath(draftsRoot) {
  return join(draftsRoot, "logs", "rejections.jsonl");
}

export function appendRejection(draftsRoot, entry) {
  mkdirSync(join(draftsRoot, "logs"), { recursive: true });
  appendFileSync(logsPath(draftsRoot), JSON.stringify(entry) + "\n");
}

export function readRejectionsSince(draftsRoot, cutoff) {
  const p = logsPath(draftsRoot);
  if (!existsSync(p)) return [];
  const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : new Date(cutoff).getTime();
  const out = [];
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry?.ts) continue;
    if (new Date(entry.ts).getTime() < cutoffMs) continue;
    out.push(entry);
  }
  return out;
}
