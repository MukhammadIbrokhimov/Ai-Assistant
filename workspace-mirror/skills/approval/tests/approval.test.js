import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { CALLBACK_PREFIXES } from "shared/constants";
import { sendForApproval } from "../approval.js";

let tmp, store;
const CHAT_ID = 5349931800;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "approval-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, overrides = {}) {
  const draft = {
    id,
    created_at: "2026-04-16T09:00:00Z",
    mode: "clip",
    topic: "AI agents",
    niche: "ai",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: {
      url: "https://youtu.be/...",
      title: "Lex Fridman #999",
      creator: "Lex Fridman",
      license: "permission-granted",
      attribution_required: true,
      clip_range: [1830, 1877],
    },
    provider_used: "ollama:qwen2.5:14b",
    tokens_in: 0,
    tokens_out: 0,
    status: "pending",
    parent_id: null,
    ...overrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  return draft;
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

describe("sendForApproval", () => {
  test("sends Template A with inline keyboard and creates state.json", async () => {
    writeDraft("test-001");
    const client = mockTelegramClient();
    await sendForApproval("test-001", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = client.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("🆕 Draft test-001");
    expect(text).toContain("Source: Lex Fridman #999");
    expect(text).toContain("🎬 Media: video, 47s");

    const keyboard = opts.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toHaveLength(3);
    expect(keyboard[0][0].callback_data).toBe("a:test-001");
    expect(keyboard[0][1].callback_data).toBe("m:test-001");
    expect(keyboard[0][2].callback_data).toBe("r:test-001");

    const state = store.readDraft("test-001").state;
    expect(state.status).toBe("pending");
    expect(state.telegram_message_id).toBe(42);
    expect(state.telegram_chat_id).toBe(CHAT_ID);
  });

  test("handles draft with no source and no media", async () => {
    writeDraft("test-002", { source: null, media: [] });
    const client = mockTelegramClient();
    await sendForApproval("test-002", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const [, text] = client.sendMessage.mock.calls[0];
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("🎬 Media:");
  });

  test("handles draft with all fields populated", async () => {
    writeDraft("test-003");
    const client = mockTelegramClient();
    await sendForApproval("test-003", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const state = store.readDraft("test-003").state;
    expect(state.status).toBe("pending");
    expect(state.sent_at).toBeDefined();
  });

  test("throws on missing draft", async () => {
    const client = mockTelegramClient();
    await expect(
      sendForApproval("nonexistent", {
        telegramClient: client,
        draftStore: store,
        chatId: CHAT_ID,
      })
    ).rejects.toThrow();
  });

  test("callback_data for each button stays under 64 bytes", async () => {
    const longId = "2026-04-16-clip-lex-fridman-sam-altman-interview-001";
    writeDraft(longId);
    const client = mockTelegramClient();
    await sendForApproval(longId, {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const keyboard = client.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    for (const btn of keyboard[0]) {
      expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  test("returns the telegram message_id for tracking", async () => {
    writeDraft("test-004");
    const client = mockTelegramClient();
    const result = await sendForApproval("test-004", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    expect(result.messageId).toBe(42);
  });
});
