import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createTelegramClient } from "../telegram-client.js";

describe("telegram-client", () => {
  let originalFetch;
  const TOKEN = "123:ABC";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchOk(result) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result }),
    });
  }

  function mockFetchError(description) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, description }),
    });
  }

  test("sendMessage posts correct URL and body", async () => {
    mockFetchOk({ message_id: 42 });
    const client = createTelegramClient(TOKEN);
    const result = await client.sendMessage(123, "hello", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(123);
    expect(body.text).toBe("hello");
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(result.message_id).toBe(42);
  });

  test("editMessageText posts correct URL and body", async () => {
    mockFetchOk(true);
    const client = createTelegramClient(TOKEN);
    await client.editMessageText(123, 42, "edited");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/editMessageText");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(123);
    expect(body.message_id).toBe(42);
    expect(body.text).toBe("edited");
  });

  test("answerCallbackQuery posts correct URL and body", async () => {
    mockFetchOk(true);
    const client = createTelegramClient(TOKEN);
    await client.answerCallbackQuery("cbq-1", "Done!");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/answerCallbackQuery");
    const body = JSON.parse(opts.body);
    expect(body.callback_query_id).toBe("cbq-1");
    expect(body.text).toBe("Done!");
  });

  test("getUpdates posts correct URL with offset and timeout", async () => {
    mockFetchOk([]);
    const client = createTelegramClient(TOKEN);
    await client.getUpdates(5, 30);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/getUpdates");
    const body = JSON.parse(opts.body);
    expect(body.offset).toBe(5);
    expect(body.timeout).toBe(30);
    expect(body.allowed_updates).toEqual(["message", "callback_query"]);
  });

  test("throws on Telegram API error response", async () => {
    mockFetchError("Bad Request: chat not found");
    const client = createTelegramClient(TOKEN);
    await expect(client.sendMessage(999, "hi")).rejects.toThrow(
      /Bad Request: chat not found/
    );
  });
});
