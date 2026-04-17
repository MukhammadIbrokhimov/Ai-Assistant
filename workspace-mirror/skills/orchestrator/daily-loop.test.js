import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDailyLoop } from "./daily-loop.js";

let tmp;
let paths;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dl-"));
  paths = { workspace: join(tmp, "workspace"), drafts: join(tmp, "drafts") };
  mkdirSync(join(paths.workspace, "config"), { recursive: true });
  mkdirSync(join(paths.drafts, "pending"), { recursive: true });
  mkdirSync(join(paths.drafts, "approved"), { recursive: true });
  mkdirSync(join(paths.drafts, "rejected"), { recursive: true });
  mkdirSync(join(paths.drafts, "logs"), { recursive: true });
  writeFileSync(join(paths.workspace, "config/niches.yaml"),
    `niches:\n  ai:\n    rss: []\n    web_search_queries: []\n`);
  writeFileSync(join(paths.workspace, "config/telegram.yaml"),
    `quiet_hours:\n  start: "22:00"\n  end: "08:00"\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSkills(overrides = {}) {
  return {
    research: {
      run: vi.fn().mockResolvedValue([
        { topic: "AI agents replacing junior devs", source_url: "https://a.test/1", score: 0.9, niche: "ai" },
        { topic: "Open-source LLMs surge", source_url: "https://a.test/2", score: 0.8, niche: "ai" },
        { topic: "Crypto rally today", source_url: "https://a.test/3", score: 0.7, niche: "ai" },
      ]),
    },
    clipExtract: { run: vi.fn().mockResolvedValue({ draft: { id: "d-clip-1", mode: "clip" } }) },
    slideshowDraft: { run: vi.fn().mockResolvedValue({ draft: { id: "d-slide-1", mode: "slideshow" } }) },
    quotecardDraft: { run: vi.fn().mockResolvedValue({ draft: { id: "d-quote-1", mode: "quotecard" } }) },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
  return {
    clock: new Date(2026, 3, 17, 9, 5),  // local 09:05 — outside quiet hours
    providerRouter: { complete: vi.fn().mockRejectedValue(new Error("no llm")) },
    skills: makeSkills(),
    approval: { sendForApproval: vi.fn().mockResolvedValue({ messageId: 123 }) },
    quietQueue: { append: vi.fn() },
    logger,
    paths,
    transcripts: [],
    telegramClient: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    chatId: 42,
    ...overrides,
  };
}

describe("runDailyLoop — steps 1-3 + wiring", () => {
  it("early exit when all three modes already produced today", async () => {
    const today = new Date().toISOString();
    for (const m of ["clip", "slideshow", "quotecard"]) {
      const dir = join(paths.drafts, "pending", `today-${m}-seed`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "draft.json"), JSON.stringify({ id: `today-${m}-seed`, mode: m, created_at: today }));
    }
    const deps = makeDeps({ clock: new Date() });
    const res = await runDailyLoop(deps);
    expect(res.produced).toBe(0);
    expect(deps.skills.research.run).not.toHaveBeenCalled();
  });

  it("empty research → exits clean, no draft attempts", async () => {
    const deps = makeDeps({ skills: makeSkills({ research: { run: vi.fn().mockResolvedValue([]) } }) });
    const res = await runDailyLoop(deps);
    expect(res.produced).toBe(0);
    expect(deps.skills.slideshowDraft.run).not.toHaveBeenCalled();
  });

  it("no matching episode for clip → slideshow takes rank 1, quotecard takes rank 2", async () => {
    const deps = makeDeps();
    const res = await runDailyLoop(deps);
    expect(deps.skills.clipExtract.run).not.toHaveBeenCalled();
    expect(deps.skills.slideshowDraft.run).toHaveBeenCalledWith(expect.objectContaining({ topic: "AI agents replacing junior devs" }));
    expect(deps.skills.quotecardDraft.run).toHaveBeenCalledWith(expect.objectContaining({ topic: "Open-source LLMs surge" }));
    expect(res.produced).toBe(2);
    expect(res.skipped.find(s => s.mode === "clip").reason).toBe("not_selected");
  });

  it("dedupe across modes keyed on source_url", async () => {
    const deps = makeDeps();
    await runDailyLoop(deps);
    const slideTopic = deps.skills.slideshowDraft.run.mock.calls[0][0].topic;
    const quoteTopic = deps.skills.quotecardDraft.run.mock.calls[0][0].topic;
    expect(slideTopic).not.toBe(quoteTopic);
  });
});
