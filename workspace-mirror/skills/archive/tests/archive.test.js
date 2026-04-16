import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { archiveDraft } from "../archive.js";

let tmp, store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "archive-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, draftOverrides = {}, stateOverrides = {}) {
  const draft = {
    id,
    mode: "clip",
    topic: "AI agents",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: null,
    status: "pending",
    ...draftOverrides,
  };
  const state = {
    status: "pending",
    telegram_message_id: 42,
    telegram_chat_id: 5349931800,
    sent_at: "2026-04-16T09:00:00Z",
    resolved_at: null,
    reject_reason: null,
    ...stateOverrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return { draft, state };
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

describe("archiveDraft", () => {
  test("moves approved draft to approved/YYYY-MM-DD/<id>/", async () => {
    writeDraft("test-001", {}, { status: "approved", resolved_at: "2026-04-16T10:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-001", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "approved", "2026-04-16", "test-001", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-001"))).toBe(false);
  });

  test("moves rejected draft to rejected/YYYY-MM-DD/<id>/", async () => {
    writeDraft("test-002", {}, { status: "rejected", resolved_at: "2026-04-16T11:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-002", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "rejected", "2026-04-16", "test-002", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-002"))).toBe(false);
  });

  test("sends Template B on approve", async () => {
    writeDraft("test-003", {}, { status: "approved", resolved_at: "2026-04-16T12:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-003", { draftStore: store, telegramClient: client });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = client.sendMessage.mock.calls[0];
    expect(chatId).toBe(5349931800);
    expect(text).toContain("✅ READY TO POST");
    expect(text).toContain("═══ COPY THIS ═══");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
  });

  test("does not send Template B on reject", async () => {
    writeDraft("test-004", {}, { status: "rejected", resolved_at: "2026-04-16T12:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-004", { draftStore: store, telegramClient: client });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test("updates draft.json status after move", async () => {
    writeDraft("test-005", {}, { status: "approved", resolved_at: "2026-04-16T13:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-005", { draftStore: store, telegramClient: client });
    const raw = JSON.parse(
      readFileSync(join(tmp, "approved", "2026-04-16", "test-005", "draft.json"), "utf8")
    );
    expect(raw.status).toBe("approved");
  });

  test("no-ops if draft is still pending", async () => {
    writeDraft("test-006");
    const client = mockTelegramClient();
    await archiveDraft("test-006", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "pending", "test-006"))).toBe(true);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
