import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";
import { computeCost, todaySpendUsd } from "../spend.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: hybrid
spend:
  daily_cap_usd: 0.001
  cost_per_million_tokens:
    "anthropic:claude-haiku-4-5":   { in: 0.25, out: 1.25 }
    "anthropic:claude-sonnet-4-6":  { in: 3.00, out: 15.00 }
    "ollama:*":                     { in: 0.00, out: 0.00 }
providers:
  ollama:
    adapter: ollama
    base_url: http://127.0.0.1:11434
    models: { fast: llama3.1:8b, quality: qwen2.5:14b }
  anthropic:
    adapter: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models: { cheap: claude-haiku-4-5, quality: claude-sonnet-4-6 }
modes:
  local:
    bulk-classify: ollama:fast
    extract:       ollama:quality
    reason:        ollama:quality
    write:         ollama:quality
  hybrid:
    bulk-classify: ollama:fast
    extract:       ollama:quality
    reason:        anthropic:cheap
    write:         anthropic:quality
`;

let tmp, configPath, logPath;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  tmp = mkdtempSync(join(tmpdir(), "spend-"));
  configPath = join(tmp, "providers.yaml");
  logPath = join(tmp, "router.jsonl");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("computeCost", () => {
  test("Sonnet: 1M in + 1M out = $3 + $15 = $18", () => {
    const cfg = { "anthropic:claude-sonnet-4-6": { in: 3, out: 15 } };
    expect(computeCost("anthropic:claude-sonnet-4-6", 1_000_000, 1_000_000, cfg))
      .toBeCloseTo(18, 6);
  });

  test("Ollama wildcard maps to $0", () => {
    const cfg = { "ollama:*": { in: 0, out: 0 } };
    expect(computeCost("ollama:qwen2.5:14b", 100_000, 100_000, cfg)).toBe(0);
  });
});

describe("router with spend cap", () => {
  test("calls log cost; cap enforcement reverts to local on cap-hit", async () => {
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "local", tokensIn: 1, tokensOut: 1, latencyMs: 1 }) };
    const anthropic = { name: "anthropic", complete: vi.fn().mockResolvedValue({
      text: "anthropic", tokensIn: 1_000_000, tokensOut: 1_000_000, latencyMs: 1 }) };

    const router = createRouter({
      configPath, adapters: { ollama, anthropic }, logPath,
    });

    // First call uses anthropic (hybrid + write) and immediately exceeds
    // the $0.001 cap (cost = $18).
    await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(1);

    // Second call: cap is exceeded, router should auto-revert to local.
    await router.complete({ taskClass: "write", prompt: "y" });
    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete).toHaveBeenCalledTimes(1); // unchanged

    // Mode in config file should now reflect the auto-revert.
    expect(router.getMode()).toBe("local");
  });

  test("todaySpendUsd reads router.jsonl and sums today's costs", async () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(logPath, [
      JSON.stringify({ ts: `${today}T01:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-sonnet-4-6", tokensIn: 100_000, tokensOut: 100_000 }),
      JSON.stringify({ ts: `${today}T02:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-haiku-4-5", tokensIn: 100_000, tokensOut: 100_000 }),
      JSON.stringify({ ts: `2020-01-01T00:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-sonnet-4-6", tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ].join("\n"));
    const costs = {
      "anthropic:claude-sonnet-4-6": { in: 3, out: 15 },
      "anthropic:claude-haiku-4-5":  { in: 0.25, out: 1.25 },
    };
    const total = todaySpendUsd(logPath, costs);
    // Sonnet: 0.1*3 + 0.1*15 = 0.3 + 1.5 = 1.80
    // Haiku:  0.1*0.25 + 0.1*1.25 = 0.025 + 0.125 = 0.15
    // Total: 1.95
    expect(total).toBeCloseTo(1.95, 4);
  });
});
