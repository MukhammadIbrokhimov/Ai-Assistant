import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { CALLBACK_PREFIXES, STATUSES } from "shared/constants";
import {
  handleCallback,
  handleModifyReply,
  handleReasonReply,
  sweepExpiredReasonWaits,
  isFromPairedUser,
} from "../poller.js";

let tmp, store;
const PAIRED_USER_ID = 5349931800;
const CHAT_ID = 5349931800;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "poller-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, stateOverrides = {}) {
  const draft = {
    id,
    mode: "clip",
    topic: "AI agents",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: null,
    status: "pending",
    parent_id: null,
  };
  const state = {
    status: "pending",
    telegram_message_id: 42,
    telegram_chat_id: CHAT_ID,
    sent_at: "2026-04-16T09:00:00Z",
    resolved_at: null,
    reject_reason: null,
    ...stateOverrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    getUpdates: vi.fn().mockResolvedValue([]),
  };
}

function mockArchive() {
  return { archiveDraft: vi.fn().mockResolvedValue(undefined) };
}

describe("isFromPairedUser", () => {
  test("returns true for message from paired user", () => {
    const update = { message: { from: { id: PAIRED_USER_ID }, text: "hi" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(true);
  });

  test("returns true for callback_query from paired user", () => {
    const update = { callback_query: { from: { id: PAIRED_USER_ID }, data: "a:x" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(true);
  });

  test("returns false for message from other user", () => {
    const update = { message: { from: { id: 999 }, text: "hi" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(false);
  });
});

describe("handleCallback", () => {
  test("approve: updates state, edits message, calls archive", async () => {
    writeDraft("d-001");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-1",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.APPROVE}d-001`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", "Approved!");
    expect(client.editMessageText).toHaveBeenCalledTimes(1);
    const editText = client.editMessageText.mock.calls[0][2];
    expect(editText).toContain("✅ Approved");

    const { state } = store.readDraft("d-001");
    expect(state.status).toBe("approved");
    expect(state.resolved_at).toBeDefined();

    expect(archive.archiveDraft).toHaveBeenCalledWith("d-001", {
      draftStore: store,
      telegramClient: client,
    });
  });

  test("reject: prompts for reason via force_reply, moves to PENDING_REASON, does NOT archive yet", async () => {
    writeDraft("d-002");
    const client = mockTelegramClient();
    client.sendMessage = vi.fn().mockResolvedValue({ message_id: 555 });
    const archive = mockArchive();
    const cbq = {
      id: "cbq-2",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.REJECT}d-002`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-2", "Rejected");
    // Original message edited to show pending state
    const editText = client.editMessageText.mock.calls[0][2];
    expect(editText).toContain("awaiting reason");
    // New force_reply prompt sent
    const sendArgs = client.sendMessage.mock.calls[0];
    expect(sendArgs[0]).toBe(CHAT_ID);
    expect(sendArgs[1]).toMatch(/reason\?/i);
    expect(sendArgs[2]?.reply_markup?.force_reply).toBe(true);
    // Draft is in PENDING_REASON, not REJECTED
    const { state } = store.readDraft("d-002");
    expect(state.status).toBe(STATUSES.PENDING_REASON);
    expect(state.reason_prompt_message_id).toBe(555);
    expect(state.reason_asked_at).toBeDefined();
    // No archive yet — happens after reason capture
    expect(archive.archiveDraft).not.toHaveBeenCalled();
  });

  test("modify: updates state, edits message, does NOT call archive", async () => {
    writeDraft("d-003");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-3",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.MODIFY}d-003`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-3", "Send your changes");
    const editText = client.editMessageText.mock.calls[0][2];
    expect(editText).toContain("✏️ Awaiting changes");
    const { state } = store.readDraft("d-003");
    expect(state.status).toBe("modifying");
    expect(archive.archiveDraft).not.toHaveBeenCalled();
  });

  test("modify rejected when another draft is already modifying", async () => {
    writeDraft("d-004", { status: "modifying" });
    writeDraft("d-005");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-4",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.MODIFY}d-005`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq-4",
      expect.stringContaining("Another draft")
    );
    const { state } = store.readDraft("d-005");
    expect(state.status).toBe("pending");
  });
});

describe("handleReasonReply", () => {
  test("text reply while a draft is pending_reason logs reason, finalizes state, archives", async () => {
    writeDraft("d-100", { status: "pending_reason", reason_prompt_message_id: 555, reason_asked_at: "2026-05-14T09:00:00Z" });
    const client = mockTelegramClient();
    const archive = mockArchive();
    const message = {
      from: { id: PAIRED_USER_ID },
      chat: { id: CHAT_ID },
      text: "too clickbaity",
      reply_to_message: { message_id: 555 },
    };

    const handled = await handleReasonReply(message, {
      telegramClient: client,
      draftStore: store,
      archive,
      draftsRoot: tmp,
      now: () => new Date("2026-05-14T09:01:00Z"),
    });

    expect(handled).toBe(true);
    // Log line written
    const logPath = join(tmp, "logs", "rejections.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry).toEqual({
      ts: "2026-05-14T09:01:00.000Z",
      draft_id: "d-100",
      mode: "clip",
      topic: "AI agents",
      reason: "too clickbaity",
    });
    // State finalized
    const { state } = store.readDraft("d-100");
    expect(state.status).toBe(STATUSES.REJECTED);
    expect(state.reject_reason).toBe("too clickbaity");
    expect(state.resolved_at).toBe("2026-05-14T09:01:00.000Z");
    // Archive called
    expect(archive.archiveDraft).toHaveBeenCalledWith("d-100", expect.anything());
  });

  test("/skip records null reason and still archives", async () => {
    writeDraft("d-101", { status: "pending_reason", reason_prompt_message_id: 555, reason_asked_at: "2026-05-14T09:00:00Z" });
    const client = mockTelegramClient();
    const archive = mockArchive();

    const handled = await handleReasonReply(
      { chat: { id: CHAT_ID }, text: "/skip", reply_to_message: { message_id: 555 } },
      { telegramClient: client, draftStore: store, archive, draftsRoot: tmp, now: () => new Date("2026-05-14T09:01:00Z") }
    );

    expect(handled).toBe(true);
    const entry = JSON.parse(readFileSync(join(tmp, "logs", "rejections.jsonl"), "utf8").trim());
    expect(entry.reason).toBeNull();
    const { state } = store.readDraft("d-101");
    expect(state.reject_reason).toBeNull();
    expect(state.status).toBe(STATUSES.REJECTED);
    expect(archive.archiveDraft).toHaveBeenCalled();
  });

  test("returns false (no-op) when no draft is awaiting reason", async () => {
    writeDraft("d-102"); // status: pending, not pending_reason
    const client = mockTelegramClient();
    const archive = mockArchive();

    const handled = await handleReasonReply(
      { chat: { id: CHAT_ID }, text: "random reply" },
      { telegramClient: client, draftStore: store, archive, draftsRoot: tmp }
    );

    expect(handled).toBe(false);
    expect(archive.archiveDraft).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, "logs", "rejections.jsonl"))).toBe(false);
  });
});

describe("sweepExpiredReasonWaits", () => {
  test("finalizes draft as rejected with null reason when ask was >5min ago", async () => {
    writeDraft("d-200", { status: "pending_reason", reason_asked_at: "2026-05-14T09:00:00Z", reason_prompt_message_id: 555 });
    const client = mockTelegramClient();
    const archive = mockArchive();

    const swept = await sweepExpiredReasonWaits({
      draftStore: store,
      archive,
      telegramClient: client,
      draftsRoot: tmp,
      now: () => new Date("2026-05-14T09:06:00Z"),
    });

    expect(swept).toBe(true);
    const entry = JSON.parse(readFileSync(join(tmp, "logs", "rejections.jsonl"), "utf8").trim());
    expect(entry.draft_id).toBe("d-200");
    expect(entry.reason).toBeNull();
    const { state } = store.readDraft("d-200");
    expect(state.status).toBe(STATUSES.REJECTED);
    expect(state.reject_reason).toBeNull();
    expect(archive.archiveDraft).toHaveBeenCalled();
  });

  test("no-ops when wait is <5min", async () => {
    writeDraft("d-201", { status: "pending_reason", reason_asked_at: "2026-05-14T09:00:00Z", reason_prompt_message_id: 555 });
    const archive = mockArchive();

    const swept = await sweepExpiredReasonWaits({
      draftStore: store,
      archive,
      telegramClient: mockTelegramClient(),
      draftsRoot: tmp,
      now: () => new Date("2026-05-14T09:04:00Z"),
    });

    expect(swept).toBe(false);
    expect(archive.archiveDraft).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, "logs", "rejections.jsonl"))).toBe(false);
  });

  test("no-ops when no pending_reason draft exists", async () => {
    writeDraft("d-202"); // pending only
    const archive = mockArchive();

    const swept = await sweepExpiredReasonWaits({
      draftStore: store,
      archive,
      telegramClient: mockTelegramClient(),
      draftsRoot: tmp,
      now: () => new Date(),
    });

    expect(swept).toBe(false);
    expect(archive.archiveDraft).not.toHaveBeenCalled();
  });
});

describe("handleModifyReply", () => {
  test("routes text to modifying draft when one exists", async () => {
    writeDraft("d-010", { status: "modifying" });
    const client = mockTelegramClient();
    const mockRouter = {
      complete: vi.fn().mockResolvedValue({
        text: "Revised caption here",
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 100,
        providerUsed: "ollama:qwen2.5:14b",
      }),
    };
    const mockApproval = {
      sendForApproval: vi.fn().mockResolvedValue({ messageId: 200 }),
    };
    const message = {
      from: { id: PAIRED_USER_ID },
      chat: { id: CHAT_ID },
      text: "Make it shorter",
    };
    await handleModifyReply(message, {
      telegramClient: client,
      draftStore: store,
      router: mockRouter,
      approval: mockApproval,
    });

    // Old draft should be superseded
    const { state: oldState } = store.readDraft("d-010");
    expect(oldState.status).toBe("superseded");

    // Router should have been called with the write task class
    expect(mockRouter.complete).toHaveBeenCalledTimes(1);
    const routerArgs = mockRouter.complete.mock.calls[0][0];
    expect(routerArgs.taskClass).toBe("write");
    expect(routerArgs.prompt).toContain("Make it shorter");
    expect(routerArgs.prompt).toContain("Sam Altman explains why...");

    // New draft should have been sent for approval
    expect(mockApproval.sendForApproval).toHaveBeenCalledTimes(1);
  });

  test("ignores text when no draft is modifying", async () => {
    writeDraft("d-020");
    const client = mockTelegramClient();
    const mockRouter = { complete: vi.fn() };
    const mockApproval = { sendForApproval: vi.fn() };
    const message = {
      from: { id: PAIRED_USER_ID },
      chat: { id: CHAT_ID },
      text: "random text",
    };
    await handleModifyReply(message, {
      telegramClient: client,
      draftStore: store,
      router: mockRouter,
      approval: mockApproval,
    });
    expect(mockRouter.complete).not.toHaveBeenCalled();
    expect(mockApproval.sendForApproval).not.toHaveBeenCalled();
  });
});
