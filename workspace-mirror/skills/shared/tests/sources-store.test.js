import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { createSourcesStore } from "../sources-store.js";

let tmpDir;
let sourcesPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sources-store-"));
  sourcesPath = join(tmpDir, "sources.yaml");
  writeFileSync(sourcesPath, yaml.dump({ sources: [] }));
});

describe("sources-store", () => {
  it("reads empty sources.yaml", () => {
    const store = createSourcesStore({ path: sourcesPath });
    expect(store.list()).toEqual([]);
  });

  it("appends a source", () => {
    const store = createSourcesStore({ path: sourcesPath });
    const entry = {
      id: "lex-fridman",
      creator: "Lex Fridman",
      url: "https://www.youtube.com/@lexfridman",
      license: "permission-granted",
      license_evidence: "https://lexfridman.com/clip-policy",
      attribution_template: "🎙️ From Lex Fridman {episode_title}",
      poll_frequency_h: 24,
      niches: ["ai"],
    };
    store.append(entry);
    const loaded = yaml.load(readFileSync(sourcesPath, "utf8"));
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].id).toBe("lex-fridman");
  });

  it("refuses to append duplicate id", () => {
    const store = createSourcesStore({ path: sourcesPath });
    const entry = { id: "dup", creator: "X", url: "u", license: "permission-granted" };
    store.append(entry);
    expect(() => store.append(entry)).toThrow(/already exists/);
  });

  it("removes a source by id", () => {
    const store = createSourcesStore({ path: sourcesPath });
    store.append({ id: "a", creator: "A", url: "u1", license: "permission-granted" });
    store.append({ id: "b", creator: "B", url: "u2", license: "permission-granted" });
    store.remove("a");
    expect(store.list().map(s => s.id)).toEqual(["b"]);
  });

  it("updates lastScanned", () => {
    const store = createSourcesStore({ path: sourcesPath });
    store.append({ id: "lex", creator: "Lex", url: "u", license: "permission-granted" });
    store.updateLastScanned("lex", "2026-04-16T13:00:00Z");
    expect(store.get("lex").lastScanned).toBe("2026-04-16T13:00:00Z");
  });

  it("writes atomically via temp file + rename", () => {
    const store = createSourcesStore({ path: sourcesPath });
    store.append({ id: "x", creator: "X", url: "u", license: "permission-granted" });
    expect(existsSync(sourcesPath + ".tmp")).toBe(false);
  });
});
