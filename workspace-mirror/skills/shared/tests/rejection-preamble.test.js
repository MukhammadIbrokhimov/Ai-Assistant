import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRejection } from "../rejection-log.js";
import { buildRejectionPreamble, withRejectionPreamble } from "../rejection-preamble.js";

describe("buildRejectionPreamble", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rejpre-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns empty string when no recent rejections", () => {
    expect(buildRejectionPreamble({ draftsRoot: dir, now: new Date("2026-05-14T00:00:00Z") })).toBe("");
  });

  it("includes topic and reason for each rejection in last 30 days", () => {
    appendRejection(dir, { ts: "2026-05-10T00:00:00Z", draft_id: "d1", mode: "text", topic: "AI hype", reason: "too clickbaity" });
    appendRejection(dir, { ts: "2026-05-12T00:00:00Z", draft_id: "d2", mode: "clip", topic: "react drama", reason: null });
    const out = buildRejectionPreamble({ draftsRoot: dir, now: new Date("2026-05-14T00:00:00Z") });
    expect(out).toContain("Recently rejected");
    expect(out).toContain("AI hype");
    expect(out).toContain("too clickbaity");
    expect(out).toContain("react drama");
  });

  it("excludes entries older than 30 days", () => {
    appendRejection(dir, { ts: "2026-03-01T00:00:00Z", draft_id: "old", mode: "text", topic: "ancient", reason: "x" });
    const out = buildRejectionPreamble({ draftsRoot: dir, now: new Date("2026-05-14T00:00:00Z") });
    expect(out).not.toContain("ancient");
  });
});

describe("withRejectionPreamble", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rejdec-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("prepends preamble for write task class when rejections exist", async () => {
    appendRejection(dir, { ts: "2026-05-12T00:00:00Z", draft_id: "d1", mode: "text", topic: "stale takes", reason: "boring" });
    const inner = { complete: vi.fn().mockResolvedValue({ text: "ok" }) };
    const wrapped = withRejectionPreamble({ router: inner, draftsRoot: dir, now: () => new Date("2026-05-14T00:00:00Z") });
    await wrapped.complete({ taskClass: "write", prompt: "Write about AI" });
    const passed = inner.complete.mock.calls[0][0];
    expect(passed.taskClass).toBe("write");
    expect(passed.prompt).toMatch(/Recently rejected/);
    expect(passed.prompt).toContain("stale takes");
    expect(passed.prompt).toContain("Write about AI");
    expect(passed.prompt.indexOf("stale takes")).toBeLessThan(passed.prompt.indexOf("Write about AI"));
  });

  it("does NOT prepend for extract task class", async () => {
    appendRejection(dir, { ts: "2026-05-12T00:00:00Z", draft_id: "d1", mode: "text", topic: "x", reason: "y" });
    const inner = { complete: vi.fn().mockResolvedValue({ text: "ok" }) };
    const wrapped = withRejectionPreamble({ router: inner, draftsRoot: dir, now: () => new Date("2026-05-14T00:00:00Z") });
    await wrapped.complete({ taskClass: "extract", prompt: "Pull a quote" });
    expect(inner.complete.mock.calls[0][0].prompt).toBe("Pull a quote");
  });

  it("does not prepend when no recent rejections", async () => {
    const inner = { complete: vi.fn().mockResolvedValue({ text: "ok" }) };
    const wrapped = withRejectionPreamble({ router: inner, draftsRoot: dir, now: () => new Date("2026-05-14T00:00:00Z") });
    await wrapped.complete({ taskClass: "write", prompt: "Write X" });
    expect(inner.complete.mock.calls[0][0].prompt).toBe("Write X");
  });

  it("forwards other router properties unchanged", () => {
    const otherFn = () => "other";
    const inner = { complete: () => {}, someOther: otherFn, providers: ["a", "b"] };
    const wrapped = withRejectionPreamble({ router: inner, draftsRoot: dir, now: () => new Date() });
    expect(wrapped.someOther).toBe(otherFn);
    expect(wrapped.providers).toEqual(["a", "b"]);
  });
});
