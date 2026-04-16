import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "../draft-store.js";

let tmp, store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "drafts-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, draft, state) {
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  if (state) {
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  }
}

describe("draft-store", () => {
  test("readDraft returns parsed draft.json and state.json", () => {
    const draft = { id: "test-001", caption: "hello" };
    const state = { status: "pending", telegram_message_id: 42 };
    writeDraft("test-001", draft, state);
    const result = store.readDraft("test-001");
    expect(result.draft.id).toBe("test-001");
    expect(result.state.status).toBe("pending");
  });

  test("readDraft returns null state when state.json missing", () => {
    const draft = { id: "test-002", caption: "hello" };
    writeDraft("test-002", draft);
    const result = store.readDraft("test-002");
    expect(result.draft.id).toBe("test-002");
    expect(result.state).toBeNull();
  });

  test("writeState creates state.json in pending dir", () => {
    const draft = { id: "test-003" };
    writeDraft("test-003", draft);
    const state = {
      status: "pending",
      telegram_message_id: 99,
      telegram_chat_id: 555,
      sent_at: "2026-04-16T09:00:00Z",
      resolved_at: null,
      reject_reason: null,
    };
    store.writeState("test-003", state);
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "test-003", "state.json"), "utf8")
    );
    expect(raw.telegram_message_id).toBe(99);
  });

  test("updateState merges partial updates into state.json", () => {
    const draft = { id: "test-004" };
    const state = { status: "pending", telegram_message_id: 1, resolved_at: null };
    writeDraft("test-004", draft, state);
    store.updateState("test-004", {
      status: "approved",
      resolved_at: "2026-04-16T10:00:00Z",
    });
    const updated = store.readDraft("test-004").state;
    expect(updated.status).toBe("approved");
    expect(updated.resolved_at).toBe("2026-04-16T10:00:00Z");
    expect(updated.telegram_message_id).toBe(1);
  });

  test("moveToApproved moves folder to approved/YYYY-MM-DD/<id>/", () => {
    const draft = { id: "test-005", status: "pending" };
    const state = { status: "approved" };
    writeDraft("test-005", draft, state);
    const dest = store.moveToApproved("test-005", "2026-04-16");
    expect(existsSync(join(tmp, "approved", "2026-04-16", "test-005", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-005"))).toBe(false);
    expect(dest).toContain("approved/2026-04-16/test-005");
  });

  test("moveToRejected moves folder to rejected/YYYY-MM-DD/<id>/", () => {
    const draft = { id: "test-006", status: "pending" };
    const state = { status: "rejected" };
    writeDraft("test-006", draft, state);
    const dest = store.moveToRejected("test-006", "2026-04-16");
    expect(existsSync(join(tmp, "rejected", "2026-04-16", "test-006", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-006"))).toBe(false);
  });

  test("moveToApproved creates date subdirectory if missing", () => {
    const draft = { id: "test-007" };
    const state = { status: "approved" };
    writeDraft("test-007", draft, state);
    store.moveToApproved("test-007", "2026-05-01");
    expect(existsSync(join(tmp, "approved", "2026-05-01", "test-007"))).toBe(true);
  });

  test("listPending returns all draft IDs in pending/ (excludes superseded)", () => {
    writeDraft("d-001", { id: "d-001" }, { status: "pending" });
    writeDraft("d-002", { id: "d-002" }, { status: "modifying" });
    writeDraft("d-003", { id: "d-003" }, { status: "superseded" });
    const ids = store.listPending();
    expect(ids).toContain("d-001");
    expect(ids).toContain("d-002");
    expect(ids).not.toContain("d-003");
  });

  test("findModifying returns the one draft in modifying state", () => {
    writeDraft("d-010", { id: "d-010" }, { status: "pending" });
    writeDraft("d-011", { id: "d-011" }, { status: "modifying" });
    expect(store.findModifying()).toBe("d-011");
  });

  test("findModifying returns null when no draft is modifying", () => {
    writeDraft("d-020", { id: "d-020" }, { status: "pending" });
    expect(store.findModifying()).toBeNull();
  });

  test("updateDraftStatus updates the status field in draft.json", () => {
    writeDraft("test-008", { id: "test-008", status: "pending" });
    store.updateDraftStatus("test-008", "approved");
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "test-008", "draft.json"), "utf8")
    );
    expect(raw.status).toBe("approved");
  });

  test("writeDraft creates draft.json in pending/<id>/", () => {
    const draftData = { id: "new-001", caption: "new draft" };
    store.writeDraft("new-001", draftData);
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "new-001", "draft.json"), "utf8")
    );
    expect(raw.id).toBe("new-001");
    expect(raw.caption).toBe("new draft");
  });
});
