import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import ollamaAdapter from "../providers/ollama.js";

describe("ollama adapter", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("complete() POSTs to /api/chat and returns text + token counts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "qwen2.5:14b",
        message: { role: "assistant", content: "Hello." },
        prompt_eval_count: 4,
        eval_count: 3,
      }),
    });

    const result = await ollamaAdapter.complete({
      taskClass: "write",
      prompt: "say hello",
      model: "qwen2.5:14b",
      baseUrl: "http://127.0.0.1:11434",
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("qwen2.5:14b");
    expect(body.messages[0].content).toBe("say hello");

    expect(result.text).toBe("Hello.");
    expect(result.tokensIn).toBe(4);
    expect(result.tokensOut).toBe(3);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("complete() throws on HTTP 5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    await expect(
      ollamaAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "qwen2.5:14b",
        baseUrl: "http://127.0.0.1:11434",
      })
    ).rejects.toThrow(/500|boom/i);
  });

  test("health() returns ok:true when /api/tags responds", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const h = await ollamaAdapter.health({ baseUrl: "http://127.0.0.1:11434" });
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
  });

  test("health() returns ok:false when unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const h = await ollamaAdapter.health({ baseUrl: "http://127.0.0.1:11434" });
    expect(h.ok).toBe(false);
  });
});
