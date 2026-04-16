import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { CALLBACK_PREFIXES, STATUSES } from "shared/constants";
import {
  handleCallback,
  handleModifyReply,
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

  test("reject: updates state, edits message, calls archive", async () => {
    writeDraft("d-002");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-2",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.REJECT}d-002`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-2", "Rejected");
    const { state } = store.readDraft("d-002");
    expect(state.status).toBe("rejected");
    expect(archive.archiveDraft).toHaveBeenCalledWith("d-002", {
      draftStore: store,
      telegramClient: client,
    });
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
