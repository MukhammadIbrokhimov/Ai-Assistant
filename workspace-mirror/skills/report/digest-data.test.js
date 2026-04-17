import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatherDigestData } from "./digest-data.js";

let tmp, drafts;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dd-"));
  drafts = join(tmp, "drafts");
  mkdirSync(join(drafts, "pending"), { recursive: true });
  mkdirSync(join(drafts, "approved"), { recursive: true });
  mkdirSync(join(drafts, "rejected"), { recursive: true });
  mkdirSync(join(drafts, "logs"), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seedDraft(bucket, id, draft) {
  const dir = bucket === "pending"
    ? join(drafts, "pending", id)
    : join(drafts, bucket, "2026-04-17", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
}

describe("gatherDigestData", () => {
  const now = new Date("2026-04-17T22:30:00Z");

  it("reports zeros on empty workspace", async () => {
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(0);
    expect(data.byMode).toEqual({ clip: 0, slideshow: 0, quotecard: 0 });
  });

  it("counts drafts by bucket + mode in last 24h", async () => {
    seedDraft("pending", "p1", { id: "p1", mode: "clip", created_at: "2026-04-17T09:00:00Z", provider_used: "ollama:qwen2.5:14b" });
    seedDraft("approved", "a1", { id: "a1", mode: "slideshow", created_at: "2026-04-17T10:00:00Z", provider_used: "ollama:qwen2.5:14b" });
    seedDraft("rejected", "r1", { id: "r1", mode: "quotecard", created_at: "2026-04-17T11:00:00Z", provider_used: "anthropic:claude-sonnet-4-6" });
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(3);
    expect(data.approved).toBe(1);
    expect(data.rejected).toBe(1);
    expect(data.pending).toBe(1);
    expect(data.byMode).toEqual({ clip: 1, slideshow: 1, quotecard: 1 });
  });

  it("ignores drafts outside 24h window", async () => {
    seedDraft("pending", "old", { id: "old", mode: "clip", created_at: "2026-04-10T09:00:00Z" });
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(0);
  });

  it("reads top rejection reason from rejections.jsonl", async () => {
    writeFileSync(join(drafts, "logs/rejections.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T10:00:00Z", draft_id: "r1", reason: "too clickbait" }),
      JSON.stringify({ ts: "2026-04-17T11:00:00Z", draft_id: "r2", reason: "too clickbait" }),
      JSON.stringify({ ts: "2026-04-17T12:00:00Z", draft_id: "r3", reason: "off brand" }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.topRejectionReason).toBe("too clickbait");
  });

  it("computes spend + provider mix from router.jsonl", async () => {
    writeFileSync(join(drafts, "logs/router.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T10:00:00Z", provider: "ollama:qwen2.5:14b", cost_usd: 0 }),
      JSON.stringify({ ts: "2026-04-17T11:00:00Z", provider: "ollama:qwen2.5:14b", cost_usd: 0 }),
      JSON.stringify({ ts: "2026-04-17T12:00:00Z", provider: "anthropic:claude-sonnet-4-6", cost_usd: 0.05 }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.spendUsd).toBeCloseTo(0.05, 4);
    expect(data.providerMix.find(p => p.provider === "ollama:qwen2.5:14b").pct).toBeCloseTo(66.6, 0);
  });

  it("surfaces spend_cap_hit event", async () => {
    writeFileSync(join(drafts, "logs/router.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T14:32:00Z", event: "spend_cap_hit", spent_usd: 1.02 }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.spendCapHit).toEqual({ at: "14:32", spentUsd: 1.02 });
  });
});
