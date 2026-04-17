import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuietQueue } from "../quiet-queue.js";

let tmp;
let qq;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qq-"));
  qq = createQuietQueue({ path: join(tmp, "quiet-queue.jsonl") });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("append + peek", () => {
  it("append writes a JSONL line", () => {
    qq.append({ draft_id: "2026-04-17-clip-001", created_at: "2026-04-17T03:00:00Z", mode: "clip", topic: "AI agents" });
    const content = readFileSync(join(tmp, "quiet-queue.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(content.trim());
    expect(parsed.draft_id).toBe("2026-04-17-clip-001");
  });

  it("two appends produce two lines", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const lines = readFileSync(join(tmp, "quiet-queue.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).draft_id).toBe("a");
    expect(JSON.parse(lines[1]).draft_id).toBe("b");
  });

  it("peek returns all appended entries without lock", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const entries = qq.peek();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.draft_id)).toEqual(["a", "b"]);
  });

  it("peek on missing file returns empty array", () => {
    const entries = qq.peek();
    expect(entries).toEqual([]);
  });

  it("append requires draft_id", () => {
    expect(() => qq.append({ created_at: "t", mode: "clip", topic: "x" })).toThrow(/draft_id/);
  });
});
