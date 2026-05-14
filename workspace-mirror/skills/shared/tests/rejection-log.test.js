import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRejection, readRejectionsSince } from "../rejection-log.js";

describe("rejection-log", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rejlog-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("appendRejection creates logs/rejections.jsonl and writes one line per call", () => {
    appendRejection(dir, { ts: "2026-05-14T09:00:00Z", draft_id: "d1", mode: "text", topic: "t1", reason: "off-tone" });
    appendRejection(dir, { ts: "2026-05-14T10:00:00Z", draft_id: "d2", mode: "clip", topic: "t2", reason: null });
    const lines = readFileSync(join(dir, "logs", "rejections.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: "2026-05-14T09:00:00Z", draft_id: "d1", mode: "text", topic: "t1", reason: "off-tone" });
    expect(JSON.parse(lines[1]).reason).toBeNull();
  });

  it("readRejectionsSince returns entries newer than cutoff", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(
      join(dir, "logs", "rejections.jsonl"),
      [
        JSON.stringify({ ts: "2026-04-01T00:00:00Z", draft_id: "old", mode: "text", topic: "old", reason: "stale" }),
        JSON.stringify({ ts: "2026-05-10T00:00:00Z", draft_id: "recent", mode: "text", topic: "recent", reason: "boring" }),
        "",
      ].join("\n")
    );
    const out = readRejectionsSince(dir, new Date("2026-04-14T00:00:00Z"));
    expect(out.map((r) => r.draft_id)).toEqual(["recent"]);
  });

  it("readRejectionsSince returns [] when file does not exist", () => {
    expect(readRejectionsSince(dir, new Date(0))).toEqual([]);
  });

  it("readRejectionsSince skips malformed lines without throwing", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(
      join(dir, "logs", "rejections.jsonl"),
      ["{ not json", JSON.stringify({ ts: "2026-05-12T00:00:00Z", draft_id: "ok", mode: "text", topic: "t", reason: "r" })].join("\n")
    );
    const out = readRejectionsSince(dir, new Date("2026-01-01T00:00:00Z"));
    expect(out.map((r) => r.draft_id)).toEqual(["ok"]);
  });
});
