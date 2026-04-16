import { describe, it, expect, vi } from "vitest";
import { createSourceCallbackHandler } from "../source-callback.js";

function makeDeps(overrides = {}) {
  return {
    sourcesStore: { append: vi.fn(), list: vi.fn(() => []) },
    readPendingSource: vi.fn((id) => ({
      status: "pending",
      candidate: {
        candidate_id: id,
        creator: "Lex Fridman",
        channel_id: "UCSHZK",
        channel_handle: "@lexfridman",
        url: "https://www.youtube.com/@lexfridman",
        license_type: "permission-granted",
        license_evidence_url: "https://lexfridman.com/clip-policy",
        attribution_template: "🎙️ From Lex Fridman {episode_title}",
        niche: "ai",
      },
    })),
    appendRejectedLog: vi.fn(),
    editMessage: vi.fn(async () => true),
    movePendingToArchive: vi.fn(),
    ...overrides,
  };
}

describe("source callback handler", () => {
  it("s:approve appends to sources.yaml and edits the TG message", async () => {
    const deps = makeDeps();
    const h = createSourceCallbackHandler(deps);
    const result = await h.handle({ data: "s:approve:cand-001", messageId: 42, chatId: 123 });
    expect(deps.sourcesStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "lexfridman",
        url: "https://www.youtube.com/@lexfridman",
        license: "permission-granted",
      })
    );
    expect(deps.editMessage).toHaveBeenCalled();
    expect(result.action).toBe("approved");
  });

  it("s:reject logs to rejected-sources.jsonl and does NOT touch sources.yaml", async () => {
    const deps = makeDeps();
    const h = createSourceCallbackHandler(deps);
    const result = await h.handle({ data: "s:reject:cand-001", messageId: 42, chatId: 123 });
    expect(deps.sourcesStore.append).not.toHaveBeenCalled();
    expect(deps.appendRejectedLog).toHaveBeenCalledWith(
      expect.objectContaining({ candidate_id: "cand-001", creator: "Lex Fridman" })
    );
    expect(result.action).toBe("rejected");
  });

  it("returns ok:false when the pending-source state is missing", async () => {
    const deps = makeDeps({ readPendingSource: vi.fn(() => null) });
    const h = createSourceCallbackHandler(deps);
    const result = await h.handle({ data: "s:approve:missing", messageId: 1, chatId: 1 });
    expect(result.ok).toBe(false);
    expect(deps.sourcesStore.append).not.toHaveBeenCalled();
  });

  it("derives sources.yaml id from channel_handle (stripped @, lowercased)", async () => {
    const deps = makeDeps();
    const h = createSourceCallbackHandler(deps);
    await h.handle({ data: "s:approve:cand-001", messageId: 1, chatId: 1 });
    expect(deps.sourcesStore.append).toHaveBeenCalledWith(expect.objectContaining({ id: "lexfridman" }));
  });
});
