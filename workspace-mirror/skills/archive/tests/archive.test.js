import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { archiveDraft, pruneCache } from "../archive.js";

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

describe("pruneCache", () => {
  let drafts;
  beforeEach(() => {
    drafts = mkdtempSync(join(tmpdir(), "pc-"));
    const dirs = [
      "whitelist/audio-cache/lex",
      "whitelist/video-cache/lex",
      "whitelist/transcript-cache/lex",
      "pexels-cache",
      "pending/live-draft",
      "approved/2026-04-17/ok",
    ];
    for (const p of dirs) mkdirSync(join(drafts, p), { recursive: true });
    writeFileSync(join(drafts, "whitelist/audio-cache/lex/old.m4a"), "x");
    writeFileSync(join(drafts, "whitelist/video-cache/lex/old.mp4"), "x");
    writeFileSync(join(drafts, "whitelist/transcript-cache/lex/old.json"), "{}");
    writeFileSync(join(drafts, "pexels-cache/old.json"), "{}");
    writeFileSync(join(drafts, "pending/live-draft/draft.json"), "{}");
    writeFileSync(join(drafts, "approved/2026-04-17/ok/draft.json"), "{}");
    const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
    for (const rel of [
      "whitelist/audio-cache/lex/old.m4a",
      "whitelist/video-cache/lex/old.mp4",
      "whitelist/transcript-cache/lex/old.json",
      "pexels-cache/old.json",
    ]) {
      utimesSync(join(drafts, rel), tenDaysAgo, tenDaysAgo);
    }
  });
  afterEach(() => rmSync(drafts, { recursive: true, force: true }));

  test("prunes files older than retain_days in allow-listed cache dirs", () => {
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "whitelist/audio-cache/lex/old.m4a"))).toBe(false);
    expect(existsSync(join(drafts, "whitelist/video-cache/lex/old.mp4"))).toBe(false);
    expect(existsSync(join(drafts, "whitelist/transcript-cache/lex/old.json"))).toBe(false);
    expect(existsSync(join(drafts, "pexels-cache/old.json"))).toBe(false);
  });

  test("never touches pending/ or approved/ (not in allow-list)", () => {
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "pending/live-draft/draft.json"))).toBe(true);
    expect(existsSync(join(drafts, "approved/2026-04-17/ok/draft.json"))).toBe(true);
  });

  test("keeps files newer than retain_days", () => {
    writeFileSync(join(drafts, "whitelist/audio-cache/lex/fresh.m4a"), "x");
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "whitelist/audio-cache/lex/fresh.m4a"))).toBe(true);
  });

  test("returns pruned count", () => {
    const res = pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(res.pruned).toBe(4);
  });
});
