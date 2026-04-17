import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createLogger(path) {
  function ensureDir() {
    mkdirSync(dirname(path), { recursive: true });
  }

  function jsonl(obj) {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
    appendFileSync(path, line);
  }

  function errorjsonl(err, context = {}) {
    jsonl({
      level: "error",
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
      ...context,
    });
  }

  return { jsonl, errorjsonl };
}
