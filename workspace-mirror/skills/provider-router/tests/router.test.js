import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: local
spend:
  daily_cap_usd: 1.00
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

let tmp, configPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "router-"));
  configPath = join(tmp, "providers.yaml");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("router.complete", () => {
  test("local mode + write task → calls ollama with quality model", async () => {
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "hi", tokensIn: 4, tokensOut: 1, latencyMs: 12 }) };
    const anthropic = { name: "anthropic", complete: vi.fn() };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    const result = await router.complete({ taskClass: "write", prompt: "x" });

    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(ollama.complete.mock.calls[0][0]).toMatchObject({
      model: "qwen2.5:14b",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(result.text).toBe("hi");
    expect(result.providerUsed).toBe("ollama:qwen2.5:14b");
  });

  test("hybrid mode + write task → calls anthropic with quality model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const ollama = { name: "ollama", complete: vi.fn() };
    const anthropic = { name: "anthropic", complete: vi.fn().mockResolvedValue({
      text: "claude said hi", tokensIn: 5, tokensOut: 3, latencyMs: 800 }) };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    const result = await router.complete({ taskClass: "write", prompt: "x" });

    expect(anthropic.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete.mock.calls[0][0]).toMatchObject({
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(result.providerUsed).toBe("anthropic:claude-sonnet-4-6");
  });

  test("hybrid mode + bulk-classify task → calls ollama:fast (8b model)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "ok", tokensIn: 2, tokensOut: 1, latencyMs: 100 }) };
    const anthropic = { name: "anthropic", complete: vi.fn() };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    await router.complete({ taskClass: "bulk-classify", prompt: "x" });

    expect(ollama.complete.mock.calls[0][0].model).toBe("llama3.1:8b");
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  test("setMode persists current_mode to config file", async () => {
    const router = createRouter({
      configPath,
      adapters: { ollama: { name: "ollama", complete: vi.fn() }, anthropic: { name: "anthropic", complete: vi.fn() } },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    const fresh = createRouter({
      configPath,
      adapters: { ollama: { name: "ollama", complete: vi.fn() }, anthropic: { name: "anthropic", complete: vi.fn() } },
      logPath: join(tmp, "router.jsonl"),
    });
    expect(fresh.getMode()).toBe("hybrid");
  });

  test("unknown mode is rejected", async () => {
    const router = createRouter({
      configPath,
      adapters: { ollama: {complete:vi.fn()}, anthropic: {complete:vi.fn()} },
      logPath: join(tmp, "router.jsonl"),
    });
    await expect(router.setMode("nonsense")).rejects.toThrow(/unknown mode/i);
  });
});
