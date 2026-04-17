import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../jsonl-logger.js";

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "jsonl-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("createLogger", () => {
  it("appends one JSON line per jsonl() call", () => {
    const log = createLogger(join(tmp, "a.jsonl"));
    log.jsonl({ event: "x", n: 1 });
    log.jsonl({ event: "y", n: 2 });
    const lines = readFileSync(join(tmp, "a.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "x", n: 1 });
    expect(JSON.parse(lines[1])).toMatchObject({ event: "y", n: 2 });
  });

  it("creates parent directory if missing", () => {
    const p = join(tmp, "nested/deep/log.jsonl");
    const log = createLogger(p);
    log.jsonl({ ok: true });
    expect(existsSync(p)).toBe(true);
  });

  it("errorjsonl serializes message + stack + context", () => {
    const log = createLogger(join(tmp, "e.jsonl"));
    const err = new Error("boom");
    log.errorjsonl(err, { skill: "test", phase: "init" });
    const line = JSON.parse(readFileSync(join(tmp, "e.jsonl"), "utf8").trim());
    expect(line.message).toBe("boom");
    expect(line.stack).toMatch(/Error: boom/);
    expect(line.skill).toBe("test");
    expect(line.phase).toBe("init");
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
