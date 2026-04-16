import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import anthropicAdapter from "../providers/anthropic.js";

describe("anthropic adapter", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("complete() POSTs to /v1/messages and returns text + token counts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_test",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello there." }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    });

    const result = await anthropicAdapter.complete({
      taskClass: "write",
      prompt: "say hello",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.headers["x-api-key"]).toBe("sk-ant-test-key");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.messages[0].content).toBe("say hello");

    expect(result.text).toBe("Hello there.");
    expect(result.tokensIn).toBe(5);
    expect(result.tokensOut).toBe(3);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("complete() throws clearly on missing API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      anthropicAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test("complete() throws on HTTP 401 with auth-fail message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    });

    await expect(
      anthropicAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      })
    ).rejects.toThrow(/401|auth/i);
  });

  test("health() returns ok:true on a tiny test call (mocked 200)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_h",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    const h = await anthropicAdapter.health({
      apiKeyEnv: "ANTHROPIC_API_KEY",
      probeModel: "claude-haiku-4-5",
    });
    expect(h.ok).toBe(true);
  });
});
