import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: hybrid
spend:
  daily_cap_usd: 100
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
  tmp = mkdtempSync(join(tmpdir(), "fb-"));
  configPath = join(tmp, "providers.yaml");
  logPath = join(tmp, "router.jsonl");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("router fallback", () => {
  test("transient error → retry once → succeed: anthropic called twice, no fallback", async () => {
    let n = 0;
    const anthropic = {
      name: "anthropic",
      complete: vi.fn(async () => {
        if (++n === 1) throw new Error("anthropic HTTP 503: transient");
        return { text: "second-try", tokensIn: 1, tokensOut: 1, latencyMs: 5 };
      }),
    };
    const ollama = { name: "ollama", complete: vi.fn() };

    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(2);
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(r.text).toBe("second-try");
    expect(r.providerUsed).toBe("anthropic:claude-sonnet-4-6");
  });

  test("hard fail after retry → falls back DOWN tier (anthropic→ollama)", async () => {
    const anthropic = {
      name: "anthropic",
      complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 500: dead")),
    };
    const ollama = {
      name: "ollama",
      complete: vi.fn().mockResolvedValue({ text: "local-fallback", tokensIn: 1, tokensOut: 1, latencyMs: 10 }),
    };

    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(2);  // primary + 1 retry
    expect(ollama.complete).toHaveBeenCalledTimes(1);     // fallback
    expect(r.text).toBe("local-fallback");
    expect(r.providerUsed).toBe("ollama:qwen2.5:14b");
  });

  test("if local tier also fails, error propagates", async () => {
    const anthropic = { name: "anthropic", complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 500")) };
    const ollama = { name: "ollama", complete: vi.fn().mockRejectedValue(new Error("ollama HTTP 500")) };
    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    await expect(router.complete({ taskClass: "write", prompt: "x" })).rejects.toThrow();
  });

  test("auth error (401) → no retry → falls back immediately", async () => {
    const anthropic = {
      name: "anthropic",
      complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 401: invalid x-api-key")),
    };
    const ollama = {
      name: "ollama",
      complete: vi.fn().mockResolvedValue({ text: "local", tokensIn: 1, tokensOut: 1, latencyMs: 1 }),
    };
    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(1);  // no retry on 401
    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("local");
  });
});
