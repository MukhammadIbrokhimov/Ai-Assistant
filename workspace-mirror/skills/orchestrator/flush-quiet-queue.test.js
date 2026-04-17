import { describe, it, expect, vi } from "vitest";
import { flushQuietQueue } from "./flush-quiet-queue.js";

function makeDeps(entries = []) {
  const queue = {
    drain: vi.fn().mockReturnValue(entries),
    commitDrain: vi.fn(),
    putBack: vi.fn(),
  };
  const telegramClient = { sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }) };
  const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
  return { queue, telegramClient, logger, chatId: 42 };
}

describe("flushQuietQueue", () => {
  it("empty queue → no DM, no commit", async () => {
    const deps = makeDeps([]);
    await flushQuietQueue(deps);
    expect(deps.telegramClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.commitDrain).not.toHaveBeenCalled();
  });

  it("two entries → one DM with both draft ids, commit called", async () => {
    const entries = [
      { draft_id: "d1", created_at: "2026-04-17T03:00:00Z", mode: "clip", topic: "AI" },
      { draft_id: "d2", created_at: "2026-04-17T05:00:00Z", mode: "slideshow", topic: "LLMs" },
    ];
    const deps = makeDeps(entries);
    await flushQuietQueue(deps);
    const [chatId, text, opts] = deps.telegramClient.sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain("Good morning");
    expect(text).toContain("2 drafts");
    expect(text).toContain("d1");
    expect(text).toContain("d2");
    expect(opts.reply_markup.inline_keyboard).toHaveLength(2);
    expect(deps.queue.commitDrain).toHaveBeenCalledOnce();
    expect(deps.queue.putBack).not.toHaveBeenCalled();
  });

  it("DM send fails → putBack called, commit not called", async () => {
    const deps = makeDeps([{ draft_id: "d1", created_at: "t", mode: "clip", topic: "x" }]);
    deps.telegramClient.sendMessage = vi.fn().mockRejectedValue(new Error("Telegram down"));
    await flushQuietQueue(deps);
    expect(deps.queue.putBack).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ draft_id: "d1" })])
    );
    expect(deps.queue.commitDrain).not.toHaveBeenCalled();
  });
});
