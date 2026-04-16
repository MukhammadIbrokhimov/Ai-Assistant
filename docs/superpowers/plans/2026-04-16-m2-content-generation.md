# M2 Content Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 7 content-production skills + shared schemas + a dry-run smoke script that feed the M1 approval pipeline — delivering real drafts (clip, slideshow, quotecard) into `pending/` and a HITL Telegram workflow for adding new whitelisted sources.

**Architecture:** Node 22 / ESM skills with Vitest TDD. Factory-function pattern + dependency injection (same as M1 `shared/`, `approval/`, `archive/`, `poller/`). Pre-existing `provider-router` (Plan A) handles LLM routing. `quotecard-draft` spawns Python/Pillow subprocess for image render. `source-discovery` reuses M1 Telegram plumbing with a new `s:` callback prefix. Every skill has a CLI entry point under `bin/` for manual smoke testing.

**Tech Stack:** Node 22, Vitest, yt-dlp, whisper-cpp (GGML large-v3), ffmpeg, Python 3.12 + Pillow, YouTube Data API v3, Pexels API, OpenClaw browser tool, `js-yaml`, `rss-parser`.

**Spec:** `docs/superpowers/specs/2026-04-16-m2-content-generation-design.md`

---

## Workspace Convention (all tasks)

- **Authoritative code location:** `/Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/<name>/`
- **Live runtime location:** `~/.openclaw/workspace/skills/<name>/` (synced from mirror)
- Subagents write only inside `/Users/vividadmin/Desktop/openclaw/`. The primary agent rsyncs mirror → live when integration testing is needed:
  ```bash
  rsync -a --delete --exclude='node_modules' \
    /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/<name>/ \
    ~/.openclaw/workspace/skills/<name>/
  ```
- All skill package.json files use `"type": "module"` and `"shared": "file:../shared"` for the shared dep.
- Run tests with: `cd workspace-mirror/skills/<name> && npm test`
- Never commit `node_modules/` — every skill has `node_modules/` gitignored.

---

## File Structure

```
workspace-mirror/
├── bin/
│   └── smoke-run.js                               ← Task 11 (dry-run)
├── skills/
│   ├── shared/                                    ← existing; extended in Tasks 1-2
│   │   ├── schemas.js                             ← Task 1 NEW
│   │   ├── sources-store.js                       ← Task 2 NEW
│   │   ├── constants.js                           ← existing
│   │   ├── telegram-client.js                     ← existing
│   │   └── draft-store.js                         ← existing
│   ├── research/                                  ← Task 3 NEW
│   │   ├── package.json + index.js + bin/research.js + tests/
│   │   └── rss.js  (RSS fetching + parsing)
│   ├── whitelist-scan/                            ← Task 4 NEW
│   │   ├── package.json + index.js + bin/scan.js + tests/
│   │   └── ytdlp.js  (yt-dlp subprocess wrapper)
│   ├── transcribe/                                ← Task 5 NEW
│   │   ├── package.json + index.js + bin/transcribe.js + tests/
│   │   ├── whisper.js  (whisper-cli subprocess wrapper)
│   │   └── ollama-unload.js  (evict Ollama models before whisper)
│   ├── slideshow-draft/                           ← Task 6 NEW
│   │   ├── package.json + index.js + bin/slideshow.js + tests/
│   │   └── pexels.js  (Pexels API client)
│   ├── quotecard-draft/                           ← Task 7 NEW
│   │   ├── package.json + index.js + bin/quotecard.js + tests/
│   │   └── render.py  (Pillow renderer — invoked as subprocess)
│   ├── source-discovery/                          ← Task 8 NEW
│   │   ├── package.json + index.js + bin/discover.js + tests/
│   │   ├── youtube-api.js  (YouTube Data API v3 client)
│   │   ├── policy-check.js  (regex precheck + snippet validation)
│   │   └── approval-format.js  (Telegram message layout for candidates)
│   ├── clip-extract/                              ← Task 9 NEW
│   │   ├── package.json + index.js + bin/extract.js + tests/
│   │   ├── ffmpeg.js  (ffmpeg subprocess wrapper)
│   │   └── srt.js  (time-shifted SRT emitter)
│   └── poller/                                    ← existing; extended in Task 10
│       └── bin/poll.js  (add provider-router wiring + s: callback + /sources)
└── docs/superpowers/specs/...                     ← existing
```

---

## Prerequisites (Phase 1 — handled by primary agent, not a subagent task)

Before the subagent-driven execution begins, the primary agent performs these installs interactively with the user:

```bash
# 1. Homebrew packages
export PATH="/opt/homebrew/bin:$PATH"
brew install ffmpeg whisper-cpp yt-dlp

# 2. Download Whisper large-v3 GGML model
mkdir -p ~/.whisper-models
curl -L -o ~/.whisper-models/ggml-large-v3.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin

# 3. Python venv + Pillow for quotecard
python3 -m venv ~/.openclaw/workspace/.venv
~/.openclaw/workspace/.venv/bin/pip install --upgrade pip Pillow

# 4. YouTube Data API v3 key → add to ~/.openclaw/workspace/.env
# User does: console.cloud.google.com → enable YouTube Data API v3 → create key
#   echo "YOUTUBE_API_KEY=..." >> ~/.openclaw/workspace/.env

# 5. Seed sources.yaml with Lex Fridman fixture
cat > ~/.openclaw/workspace/config/sources.yaml <<'EOF'
sources:
  - id: lex-fridman
    creator: "Lex Fridman"
    type: youtube_channel
    url: https://www.youtube.com/@lexfridman
    license: permission-granted
    license_evidence: https://lexfridman.com/clip-policy
    attribution_required: true
    attribution_template: "🎙️ From Lex Fridman {episode_title}"
    poll_frequency_h: 24
    niches: [ai]
    lastScanned: null
EOF

# 6. Sanity checks
ffmpeg -version                       | head -1
whisper-cli --help                    | head -5
yt-dlp --version
~/.openclaw/workspace/.venv/bin/python -c "from PIL import Image; print('PIL', Image.__version__)"
```

---

## Task 1: `shared/schemas.js` — Transcript, Storyboard, Candidate validators

**Files:**
- Create: `workspace-mirror/skills/shared/schemas.js`
- Create: `workspace-mirror/skills/shared/tests/schemas.test.js`
- Modify: `workspace-mirror/skills/shared/package.json` (add `./schemas` export)

- [ ] **Step 1.1: Write failing tests for Transcript schema**

Create `workspace-mirror/skills/shared/tests/schemas.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  validateTranscript,
  validateStoryboard,
  validateCandidate,
} from "../schemas.js";

describe("validateTranscript", () => {
  const valid = {
    source_id: "lex-fridman",
    episode_id: "abc123",
    title: "Lex Fridman #999",
    language: "en",
    duration_s: 7234,
    transcribed_at: "2026-04-16T13:14:00Z",
    model: "whisper-large-v3",
    segments: [
      { t_start: 0.0, t_end: 3.2, text: "Welcome." },
      { t_start: 3.2, t_end: 7.8, text: "This is the conversation." },
    ],
  };

  it("accepts a valid transcript", () => {
    expect(validateTranscript(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing source_id", () => {
    const invalid = { ...valid, source_id: undefined };
    const result = validateTranscript(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/source_id/);
  });

  it("rejects non-array segments", () => {
    const invalid = { ...valid, segments: "not an array" };
    expect(validateTranscript(invalid).valid).toBe(false);
  });

  it("rejects segment with negative t_start", () => {
    const invalid = { ...valid, segments: [{ t_start: -1, t_end: 1, text: "x" }] };
    expect(validateTranscript(invalid).valid).toBe(false);
  });
});

describe("validateStoryboard", () => {
  const valid = {
    script: "Full 60-second script...",
    duration_s: 60,
    beats: [
      {
        text: "Beat 1 text",
        duration_s: 10,
        keywords: ["ai", "office"],
        pexels_photo_id: 123,
        image_url: "https://images.pexels.com/photos/123/example.jpg",
        pexels_attribution: "Photo by Jane on Pexels",
      },
    ],
  };

  it("accepts a valid storyboard", () => {
    expect(validateStoryboard(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects empty beats array", () => {
    expect(validateStoryboard({ ...valid, beats: [] }).valid).toBe(false);
  });

  it("rejects beat without image_url", () => {
    const bad = { ...valid, beats: [{ ...valid.beats[0], image_url: undefined }] };
    expect(validateStoryboard(bad).valid).toBe(false);
  });
});

describe("validateCandidate", () => {
  const valid = {
    candidate_id: "2026-04-16-cand-lex-001",
    discovered_at: "2026-04-16T10:03:00Z",
    discovery_mode: "push",
    creator: "Lex Fridman",
    channel_id: "UCSHZKyawb77ixDdsGog4iWA",
    channel_handle: "@lexfridman",
    url: "https://www.youtube.com/@lexfridman",
    subs: 5300000,
    recent_30d_views: 12400000,
    velocity_score: 2.34,
    niche: "ai",
    niche_fit_confidence: 0.92,
    license_type: "permission-granted",
    license_evidence_url: "https://lexfridman.com/clip-policy",
    license_evidence_snippet: "Feel free to clip and repost highlights",
    attribution_template: "🎙️ From Lex Fridman {episode_title}",
    recommendation_confidence: 0.88,
  };

  it("accepts a valid candidate", () => {
    expect(validateCandidate(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects attribution_template without a known placeholder", () => {
    const bad = { ...valid, attribution_template: "From Lex Fridman" };
    const result = validateCandidate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/attribution_template/);
  });

  it("accepts attribution_template with {episode_num}", () => {
    const ok = { ...valid, attribution_template: "Ep {episode_num}" };
    expect(validateCandidate(ok).valid).toBe(true);
  });

  it("rejects discovery_mode other than push/pull", () => {
    const bad = { ...valid, discovery_mode: "random" };
    expect(validateCandidate(bad).valid).toBe(false);
  });

  it("rejects recommendation_confidence outside [0, 1]", () => {
    const bad = { ...valid, recommendation_confidence: 1.5 };
    expect(validateCandidate(bad).valid).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run test to verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared
npm test -- tests/schemas.test.js
```

Expected: FAIL with "Cannot find module '../schemas.js'" or similar.

- [ ] **Step 1.3: Implement `schemas.js`**

Create `workspace-mirror/skills/shared/schemas.js`:

```js
function errs() {
  return [];
}

function req(errors, obj, key, kind) {
  if (obj[key] === undefined || obj[key] === null) {
    errors.push(`${key} required`);
    return false;
  }
  if (kind && typeof obj[key] !== kind && !(kind === "array" && Array.isArray(obj[key]))) {
    errors.push(`${key} must be ${kind}`);
    return false;
  }
  return true;
}

export function validateTranscript(t) {
  const errors = errs();
  req(errors, t, "source_id", "string");
  req(errors, t, "episode_id", "string");
  req(errors, t, "title", "string");
  req(errors, t, "language", "string");
  req(errors, t, "duration_s", "number");
  req(errors, t, "transcribed_at", "string");
  req(errors, t, "model", "string");
  if (!Array.isArray(t?.segments)) {
    errors.push("segments must be array");
  } else {
    t.segments.forEach((s, i) => {
      if (typeof s?.t_start !== "number" || s.t_start < 0) errors.push(`segments[${i}].t_start invalid`);
      if (typeof s?.t_end !== "number" || s.t_end <= s.t_start) errors.push(`segments[${i}].t_end invalid`);
      if (typeof s?.text !== "string") errors.push(`segments[${i}].text must be string`);
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateStoryboard(s) {
  const errors = errs();
  req(errors, s, "script", "string");
  req(errors, s, "duration_s", "number");
  if (!Array.isArray(s?.beats) || s.beats.length === 0) {
    errors.push("beats must be non-empty array");
  } else {
    s.beats.forEach((b, i) => {
      if (typeof b?.text !== "string") errors.push(`beats[${i}].text required`);
      if (typeof b?.duration_s !== "number") errors.push(`beats[${i}].duration_s required`);
      if (typeof b?.image_url !== "string") errors.push(`beats[${i}].image_url required`);
    });
  }
  return { valid: errors.length === 0, errors };
}

const ATTRIBUTION_PLACEHOLDERS = ["{episode_title}", "{episode_num}", "{creator}"];
const VALID_DISCOVERY_MODES = new Set(["push", "pull"]);

export function validateCandidate(c) {
  const errors = errs();
  req(errors, c, "candidate_id", "string");
  req(errors, c, "discovered_at", "string");
  if (!VALID_DISCOVERY_MODES.has(c?.discovery_mode)) {
    errors.push("discovery_mode must be push|pull");
  }
  req(errors, c, "creator", "string");
  req(errors, c, "channel_id", "string");
  req(errors, c, "url", "string");
  req(errors, c, "niche", "string");
  if (typeof c?.niche_fit_confidence !== "number" || c.niche_fit_confidence < 0 || c.niche_fit_confidence > 1) {
    errors.push("niche_fit_confidence must be in [0,1]");
  }
  if (typeof c?.recommendation_confidence !== "number" || c.recommendation_confidence < 0 || c.recommendation_confidence > 1) {
    errors.push("recommendation_confidence must be in [0,1]");
  }
  req(errors, c, "license_type", "string");
  req(errors, c, "license_evidence_url", "string");
  req(errors, c, "license_evidence_snippet", "string");
  if (typeof c?.attribution_template !== "string" || c.attribution_template.length === 0) {
    errors.push("attribution_template required");
  } else if (!ATTRIBUTION_PLACEHOLDERS.some(p => c.attribution_template.includes(p))) {
    errors.push(`attribution_template must contain one of ${ATTRIBUTION_PLACEHOLDERS.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 1.4: Add `./schemas` to shared package exports**

Edit `workspace-mirror/skills/shared/package.json`:

```json
{
  "name": "shared",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": {
    "./constants": "./constants.js",
    "./telegram-client": "./telegram-client.js",
    "./draft-store": "./draft-store.js",
    "./schemas": "./schemas.js",
    "./sources-store": "./sources-store.js"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

(Adding `./sources-store` now even though Task 2 creates the file — it's declared for task 2's convenience.)

- [ ] **Step 1.5: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared
npm test -- tests/schemas.test.js
```

Expected: all ~13 tests PASS.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/shared/schemas.js \
        workspace-mirror/skills/shared/tests/schemas.test.js \
        workspace-mirror/skills/shared/package.json
git commit -m "feat(shared): add Transcript/Storyboard/Candidate schema validators"
```

---

## Task 2: `shared/sources-store.js` — atomic single-writer for sources.yaml

**Files:**
- Create: `workspace-mirror/skills/shared/sources-store.js`
- Create: `workspace-mirror/skills/shared/tests/sources-store.test.js`
- Modify: `workspace-mirror/skills/shared/package.json` (already added in Task 1)
- Modify: `workspace-mirror/skills/shared/package.json` — add `js-yaml` dependency

- [ ] **Step 2.1: Add `js-yaml` dep to shared**

Edit `workspace-mirror/skills/shared/package.json`:

```json
{
  "dependencies": {
    "js-yaml": "^4.1.0"
  }
}
```

Then:

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared
npm install
```

- [ ] **Step 2.2: Write failing tests**

Create `workspace-mirror/skills/shared/tests/sources-store.test.js`:

```js
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
    // After write, the temp file should not exist
    expect(existsSync(sourcesPath + ".tmp")).toBe(false);
  });
});
```

- [ ] **Step 2.3: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared
npm test -- tests/sources-store.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 2.4: Implement `sources-store.js`**

Create `workspace-mirror/skills/shared/sources-store.js`:

```js
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import yaml from "js-yaml";

export function createSourcesStore({ path }) {
  function readAll() {
    const doc = yaml.load(readFileSync(path, "utf8")) || { sources: [] };
    if (!Array.isArray(doc.sources)) doc.sources = [];
    return doc;
  }

  function writeAtomic(doc) {
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, yaml.dump(doc));
    renameSync(tmpPath, path);
  }

  function withLock(fn) {
    // Advisory lock via exclusive-create lockfile; retry briefly if contended.
    const lockPath = path + ".lock";
    let fd = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        fd = openSync(lockPath, "wx");
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // Busy; wait 20ms and retry (busy-loop is OK for short wait)
        const end = Date.now() + 20;
        while (Date.now() < end) {}
      }
    }
    if (fd === null) throw new Error(`sources-store: lock timeout on ${lockPath}`);
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch {}
    }
  }

  function list() {
    return readAll().sources;
  }

  function get(id) {
    return readAll().sources.find((s) => s.id === id) || null;
  }

  function append(entry) {
    if (!entry?.id) throw new Error("sources-store.append: entry.id required");
    return withLock(() => {
      const doc = readAll();
      if (doc.sources.find((s) => s.id === entry.id)) {
        throw new Error(`sources-store.append: id "${entry.id}" already exists`);
      }
      doc.sources.push(entry);
      writeAtomic(doc);
    });
  }

  function remove(id) {
    return withLock(() => {
      const doc = readAll();
      const idx = doc.sources.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`sources-store.remove: id "${id}" not found`);
      doc.sources.splice(idx, 1);
      writeAtomic(doc);
    });
  }

  function updateLastScanned(id, isoTimestamp) {
    return withLock(() => {
      const doc = readAll();
      const s = doc.sources.find((x) => x.id === id);
      if (!s) throw new Error(`sources-store.updateLastScanned: id "${id}" not found`);
      s.lastScanned = isoTimestamp;
      writeAtomic(doc);
    });
  }

  return { list, get, append, remove, updateLastScanned };
}
```

- [ ] **Step 2.5: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared
npm test
```

Expected: all shared tests pass (schemas + sources-store + previous M1 tests).

- [ ] **Step 2.6: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/shared/sources-store.js \
        workspace-mirror/skills/shared/tests/sources-store.test.js \
        workspace-mirror/skills/shared/package.json \
        workspace-mirror/skills/shared/package-lock.json
git commit -m "feat(shared): add sources-store with atomic write + advisory lock"
```

---

## Task 3: `research` skill — RSS + web-search topic ranker

**Files:**
- Create: `workspace-mirror/skills/research/package.json`
- Create: `workspace-mirror/skills/research/index.js`
- Create: `workspace-mirror/skills/research/rss.js`
- Create: `workspace-mirror/skills/research/bin/research.js`
- Create: `workspace-mirror/skills/research/tests/index.test.js`
- Create: `workspace-mirror/skills/research/tests/rss.test.js`

- [ ] **Step 3.1: Create `package.json`**

```json
{
  "name": "research",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "shared": "file:../shared",
    "rss-parser": "^3.13.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3.2: Write failing tests**

Create `workspace-mirror/skills/research/tests/index.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { createResearch } from "../index.js";

const nichesYaml = `
niches:
  ai:
    rss:
      - https://example.com/ai.xml
    web_search_queries:
      - "AI agent {today}"
    keywords_must_include: [ai]
    keywords_must_exclude: [crypto]
`;

function makeDeps(overrides = {}) {
  return {
    readFileSync: vi.fn(() => nichesYaml),
    fetchRss: vi.fn(async () => [
      { title: "New AI Agent Released", link: "https://x.com/1", pubDate: "2026-04-16" },
      { title: "Crypto Web3 News", link: "https://x.com/2", pubDate: "2026-04-16" },
    ]),
    browserSearch: vi.fn(async () => [
      { title: "OpenAI launches new model", url: "https://y.com/1" },
    ]),
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "bulk-classify") {
          // dedupe → return indices to keep as JSON
          return { text: JSON.stringify({ keep: [0, 2] }), tokens_in: 100, tokens_out: 10 };
        }
        if (taskClass === "reason") {
          // rank → return array with scores
          return {
            text: JSON.stringify([
              { topic: "New AI Agent Released", source_url: "https://x.com/1", score: 0.9 },
              { topic: "OpenAI launches new model", source_url: "https://y.com/1", score: 0.7 },
            ]),
            tokens_in: 200,
            tokens_out: 50,
          };
        }
        throw new Error(`unexpected taskClass ${taskClass}`);
      }),
    },
    nichesPath: "/fake/niches.yaml",
    ...overrides,
  };
}

describe("research", () => {
  it("returns ranked topics for a niche", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0]).toHaveProperty("topic");
    expect(topics[0]).toHaveProperty("source_url");
    expect(topics[0]).toHaveProperty("score");
    expect(topics[0]).toHaveProperty("niche", "ai");
  });

  it("filters out must_exclude keywords", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(topics.map(t => t.topic).some(t => /crypto/i.test(t))).toBe(false);
  });

  it("throws when niche not in config", async () => {
    const deps = makeDeps();
    const r = createResearch(deps);
    await expect(r.run("unknown-niche")).rejects.toThrow(/unknown-niche/);
  });

  it("falls back to RSS-only when browser fails 3× consecutively", async () => {
    const deps = makeDeps({
      browserSearch: vi.fn(async () => { throw new Error("browser flake"); }),
    });
    const r = createResearch(deps);
    const topics = await r.run("ai");
    expect(topics.length).toBeGreaterThan(0); // didn't abort
    expect(deps.browserSearch).toHaveBeenCalledTimes(1); // queries array length 1
  });
});
```

- [ ] **Step 3.3: Write RSS unit test**

Create `workspace-mirror/skills/research/tests/rss.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { parseRssFeed } from "../rss.js";

describe("parseRssFeed", () => {
  it("extracts title + link + pubDate from parsed feed", async () => {
    const fakeParse = vi.fn(async () => ({
      items: [
        { title: "One", link: "https://x/1", pubDate: "2026-04-16T10:00:00Z", contentSnippet: "..." },
        { title: "Two", link: "https://x/2", pubDate: "2026-04-15T10:00:00Z" },
      ],
    }));
    const items = await parseRssFeed("https://feed.example.com", { parseUrl: fakeParse });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "One", link: "https://x/1", pubDate: "2026-04-16T10:00:00Z" });
  });

  it("returns empty array on parser failure", async () => {
    const fakeParse = vi.fn(async () => { throw new Error("bad feed"); });
    const items = await parseRssFeed("https://bad.example.com", { parseUrl: fakeParse });
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 3.4: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/research
npm install
npm test
```

Expected: FAIL — modules not found.

- [ ] **Step 3.5: Implement `rss.js`**

Create `workspace-mirror/skills/research/rss.js`:

```js
import Parser from "rss-parser";

const defaultParser = new Parser({ timeout: 10000 });

export async function parseRssFeed(url, { parseUrl } = {}) {
  const fn = parseUrl || ((u) => defaultParser.parseURL(u));
  try {
    const feed = await fn(url);
    return (feed.items || []).map((i) => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate || i.isoDate || null,
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 3.6: Implement `index.js`**

Create `workspace-mirror/skills/research/index.js`:

```js
import yaml from "js-yaml";
import { parseRssFeed } from "./rss.js";

export function createResearch({ readFileSync, nichesPath, fetchRss, browserSearch, router }) {
  const rssFetcher = fetchRss || parseRssFeed;

  async function run(niche) {
    const doc = yaml.load(readFileSync(nichesPath, "utf8"));
    const cfg = doc?.niches?.[niche];
    if (!cfg) throw new Error(`unknown niche "${niche}"`);

    // 1. RSS
    const rssItems = [];
    for (const feedUrl of cfg.rss || []) {
      const items = await rssFetcher(feedUrl);
      rssItems.push(...items.map((i) => ({ title: i.title, source_url: i.link })));
    }

    // 2. Web search (with flake tolerance)
    const today = new Date().toISOString().slice(0, 10);
    const webItems = [];
    for (const qTemplate of cfg.web_search_queries || []) {
      const q = qTemplate.replaceAll("{today}", today);
      try {
        const hits = await browserSearch(q);
        webItems.push(...hits.map((h) => ({ title: h.title, source_url: h.url })));
      } catch {
        // browser flake: skip this query, continue
      }
    }

    const allItems = [...rssItems, ...webItems];

    // 3. Keyword filter
    const inc = (cfg.keywords_must_include || []).map(s => s.toLowerCase());
    const exc = (cfg.keywords_must_exclude || []).map(s => s.toLowerCase());
    const filtered = allItems.filter((it) => {
      const t = it.title.toLowerCase();
      if (inc.length && !inc.some(k => t.includes(k))) return false;
      if (exc.some(k => t.includes(k))) return false;
      return true;
    });

    if (filtered.length === 0) return [];

    // 4. LLM dedupe → indices to keep
    const dedupePrompt = `You will receive an array of headlines. Identify which ones are near-duplicates of each other (same story, different sources). Return a JSON object: {"keep":[indices]} listing indices (0-based) of items to KEEP (one per unique story). Headlines:\n${filtered.map((it, i) => `[${i}] ${it.title}`).join("\n")}\n\nReturn ONLY the JSON.`;
    const dedupeResp = await router.complete({
      taskClass: "bulk-classify",
      prompt: dedupePrompt,
      maxTokens: 500,
    });
    let keepIndices;
    try {
      keepIndices = JSON.parse(dedupeResp.text).keep;
    } catch {
      keepIndices = filtered.map((_, i) => i);
    }
    const deduped = keepIndices.map(i => filtered[i]).filter(Boolean);

    // 5. LLM rank
    const rankPrompt = `You are ranking headlines for potential short-form social media engagement. Return a JSON array ordered by engagement potential (highest first), each item: {"topic":"<headline>","source_url":"<url>","score":<0.0-1.0>}. Return max 5 items.\n\nHeadlines:\n${deduped.map((it, i) => `[${i}] ${it.title} (${it.source_url})`).join("\n")}\n\nReturn ONLY the JSON array.`;
    const rankResp = await router.complete({
      taskClass: "reason",
      prompt: rankPrompt,
      maxTokens: 1000,
    });
    let ranked;
    try {
      ranked = JSON.parse(rankResp.text);
    } catch {
      ranked = deduped.slice(0, 5).map((it, i) => ({
        topic: it.title, source_url: it.source_url, score: 1 - i * 0.1,
      }));
    }
    return ranked.slice(0, 5).map(r => ({ ...r, niche }));
  }

  return { run };
}
```

- [ ] **Step 3.7: Implement CLI entry `bin/research.js`**

Create `workspace-mirror/skills/research/bin/research.js`:

```js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollamaAdapter from "../../provider-router/providers/ollama.js";
import anthropicAdapter from "../../provider-router/providers/anthropic.js";
import { createResearch } from "../index.js";

const niche = process.argv[2];
if (!niche) {
  console.error("Usage: bin/research.js <niche>");
  process.exit(1);
}

const router = createRouter({
  configPath: process.env.OPENCLAW_PROVIDERS_YAML || `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama: ollamaAdapter, anthropic: anthropicAdapter },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

// Minimal browser stub: uses fetch against a search endpoint IF configured,
// else throws (which research handles gracefully).
const browserSearch = async (query) => {
  if (!process.env.OPENCLAW_BROWSER_URL) throw new Error("no browser tool configured");
  const r = await fetch(`${process.env.OPENCLAW_BROWSER_URL}/search?q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`browser HTTP ${r.status}`);
  const body = await r.json();
  return body.results || [];
};

const research = createResearch({
  readFileSync,
  nichesPath: `${process.env.HOME}/.openclaw/workspace/config/niches.yaml`,
  browserSearch,
  router,
});

const topics = await research.run(niche);
console.log(JSON.stringify(topics, null, 2));
```

Mark executable:
```bash
chmod +x workspace-mirror/skills/research/bin/research.js
```

- [ ] **Step 3.8: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/research
npm test
```

Expected: all research tests pass.

- [ ] **Step 3.9: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/research/
git commit -m "feat(research): RSS + web-search topic ranker with LLM dedupe+rank"
```

---

## Task 4: `whitelist-scan` skill — yt-dlp audio + video cache

**Files:**
- Create: `workspace-mirror/skills/whitelist-scan/package.json`
- Create: `workspace-mirror/skills/whitelist-scan/index.js`
- Create: `workspace-mirror/skills/whitelist-scan/ytdlp.js`
- Create: `workspace-mirror/skills/whitelist-scan/bin/scan.js`
- Create: `workspace-mirror/skills/whitelist-scan/tests/index.test.js`

- [ ] **Step 4.1: Create `package.json`**

```json
{
  "name": "whitelist-scan",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 4.2: Write failing tests**

Create `workspace-mirror/skills/whitelist-scan/tests/index.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { createWhitelistScan } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    sourcesStore: {
      list: vi.fn(() => [{
        id: "lex-fridman",
        url: "https://www.youtube.com/@lexfridman",
        poll_frequency_h: 24,
        lastScanned: null,
      }]),
      updateLastScanned: vi.fn(),
    },
    listNewVideos: vi.fn(async () => [
      { id: "vid1", title: "Episode 999", duration_s: 7200, published_at: "2026-04-15T10:00:00Z" },
    ]),
    downloadAudio: vi.fn(async (videoId, dest) => dest),
    downloadVideo: vi.fn(async (videoId, dest) => dest),
    readManifest: vi.fn(() => ({ episodes: [] })),
    writeManifest: vi.fn(),
    mkdirp: vi.fn(),
    freeSpaceBytes: vi.fn(async () => 10 * 1024 * 1024 * 1024), // 10 GB
    now: () => new Date("2026-04-16T13:00:00Z"),
    cacheRoot: "/tmp/whitelist-cache",
    minFreeGb: 5,
    ...overrides,
  };
}

describe("whitelist-scan", () => {
  it("downloads new episodes audio+video and updates manifest", async () => {
    const deps = makeDeps();
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.downloadAudio).toHaveBeenCalledTimes(1);
    expect(deps.downloadVideo).toHaveBeenCalledTimes(1);
    expect(deps.sourcesStore.updateLastScanned).toHaveBeenCalledWith("lex-fridman", expect.any(String));
    expect(result.downloaded).toBe(1);
  });

  it("skips source whose poll_frequency_h hasn't elapsed", async () => {
    const deps = makeDeps({
      sourcesStore: {
        list: vi.fn(() => [{
          id: "lex-fridman",
          url: "https://www.youtube.com/@lexfridman",
          poll_frequency_h: 24,
          lastScanned: "2026-04-16T10:00:00Z", // 3h ago, < 24h
        }]),
        updateLastScanned: vi.fn(),
      },
    });
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.listNewVideos).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("aborts with error when free space < 5 GB", async () => {
    const deps = makeDeps({
      freeSpaceBytes: vi.fn(async () => 2 * 1024 * 1024 * 1024), // 2 GB
    });
    const scan = createWhitelistScan(deps);
    await expect(scan.run()).rejects.toThrow(/free space/i);
  });

  it("deduplicates by episode_id in manifest", async () => {
    const deps = makeDeps({
      readManifest: vi.fn(() => ({ episodes: [{ episode_id: "vid1", audio_path: "/cached/vid1.m4a" }] })),
    });
    const scan = createWhitelistScan(deps);
    const result = await scan.run();
    expect(deps.downloadAudio).not.toHaveBeenCalled(); // already cached
    expect(result.downloaded).toBe(0);
  });
});
```

- [ ] **Step 4.3: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/whitelist-scan
npm install && npm test
```

Expected: FAIL (modules not found).

- [ ] **Step 4.4: Implement `ytdlp.js`**

Create `workspace-mirror/skills/whitelist-scan/ytdlp.js`:

```js
import { spawn } from "node:child_process";

export function createYtdlp({ binary = "yt-dlp" } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args);
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`yt-dlp exit ${code}: ${err}`));
      });
      proc.on("error", reject);
    });
  }

  async function listNewVideos(channelUrl, sinceIso) {
    const args = ["--flat-playlist", "--print-json"];
    if (sinceIso) {
      const d = sinceIso.slice(0, 10).replaceAll("-", "");
      args.push("--dateafter", d);
    }
    args.push(channelUrl);
    const raw = await run(args);
    return raw.split("\n").filter(Boolean).map((line) => {
      const j = JSON.parse(line);
      return {
        id: j.id,
        title: j.title,
        duration_s: j.duration || 0,
        published_at: j.upload_date ? `${j.upload_date.slice(0,4)}-${j.upload_date.slice(4,6)}-${j.upload_date.slice(6,8)}T00:00:00Z` : null,
      };
    });
  }

  async function downloadAudio(videoId, destPath) {
    await run(["-f", "m4a", "-o", destPath, `https://www.youtube.com/watch?v=${videoId}`]);
    return destPath;
  }

  async function downloadVideo(videoId, destPath) {
    await run([
      "-f", "bestvideo[height<=1080]+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", destPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    return destPath;
  }

  return { listNewVideos, downloadAudio, downloadVideo };
}
```

- [ ] **Step 4.5: Implement `index.js`**

Create `workspace-mirror/skills/whitelist-scan/index.js`:

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { statfs } from "node:fs/promises";

export function createWhitelistScan(deps) {
  const {
    sourcesStore, listNewVideos, downloadAudio, downloadVideo,
    readManifest, writeManifest, mkdirp,
    freeSpaceBytes, now, cacheRoot, minFreeGb = 5,
  } = deps;

  function shouldScan(source, nowDate) {
    if (!source.lastScanned) return true;
    const last = new Date(source.lastScanned);
    const h = (nowDate - last) / 1000 / 3600;
    return h >= (source.poll_frequency_h || 24);
  }

  async function run() {
    // disk-space precheck
    const free = await freeSpaceBytes();
    if (free < minFreeGb * 1024 * 1024 * 1024) {
      throw new Error(`free space ${(free / 1024 / 1024 / 1024).toFixed(1)}GB below ${minFreeGb}GB`);
    }

    const nowDate = now();
    const sources = sourcesStore.list();
    let downloaded = 0, skipped = 0, failed = 0;

    for (const s of sources) {
      if (!shouldScan(s, nowDate)) { skipped++; continue; }
      try {
        const audioDir = join(cacheRoot, "audio-cache", s.id);
        const videoDir = join(cacheRoot, "video-cache", s.id);
        mkdirp(audioDir);
        mkdirp(videoDir);

        const manifestPath = join(audioDir, "manifest.json");
        const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : { episodes: [] };
        const seen = new Set(manifest.episodes.map(e => e.episode_id));

        const newEps = await listNewVideos(s.url, s.lastScanned);
        for (const ep of newEps) {
          if (seen.has(ep.id)) continue;
          const audioPath = join(audioDir, `${ep.id}.m4a`);
          const videoPath = join(videoDir, `${ep.id}.mp4`);
          await downloadAudio(ep.id, audioPath);
          await downloadVideo(ep.id, videoPath);
          manifest.episodes.push({
            episode_id: ep.id,
            title: ep.title,
            duration_s: ep.duration_s,
            published_at: ep.published_at,
            audio_path: audioPath,
            video_path: videoPath,
            video_pruned_at: null,
          });
          downloaded++;
        }

        writeManifest(manifestPath, manifest);
        sourcesStore.updateLastScanned(s.id, nowDate.toISOString());
      } catch (e) {
        failed++;
        console.error(`scan failed for ${s.id}: ${e.message}`);
      }
    }
    return { downloaded, skipped, failed };
  }

  return { run };
}
```

- [ ] **Step 4.6: Implement CLI `bin/scan.js`**

Create `workspace-mirror/skills/whitelist-scan/bin/scan.js`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createSourcesStore } from "../../shared/sources-store.js";
import { createYtdlp } from "../ytdlp.js";
import { createWhitelistScan } from "../index.js";

const sourcesPath = `${process.env.HOME}/.openclaw/workspace/config/sources.yaml`;
const cacheRoot = `${process.env.HOME}/openclaw-drafts/whitelist`;

const sourcesStore = createSourcesStore({ path: sourcesPath });
const ytdlp = createYtdlp();

async function freeSpaceBytes() {
  const s = await statfs(cacheRoot);
  return Number(s.bavail) * Number(s.bsize);
}

const scan = createWhitelistScan({
  sourcesStore,
  listNewVideos: ytdlp.listNewVideos,
  downloadAudio: ytdlp.downloadAudio,
  downloadVideo: ytdlp.downloadVideo,
  readManifest: (p) => JSON.parse(readFileSync(p, "utf8")),
  writeManifest: (p, m) => writeFileSync(p, JSON.stringify(m, null, 2)),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  freeSpaceBytes,
  now: () => new Date(),
  cacheRoot,
});

mkdirSync(cacheRoot, { recursive: true });
const result = await scan.run();
console.log(JSON.stringify(result));
```

`chmod +x workspace-mirror/skills/whitelist-scan/bin/scan.js`

- [ ] **Step 4.7: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/whitelist-scan
npm test
```

- [ ] **Step 4.8: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/whitelist-scan/
git commit -m "feat(whitelist-scan): yt-dlp audio+video cache with disk precheck"
```

---

## Task 5: `transcribe` skill — whisper large-v3 with Ollama eviction

**Files:**
- Create: `workspace-mirror/skills/transcribe/package.json`
- Create: `workspace-mirror/skills/transcribe/index.js`
- Create: `workspace-mirror/skills/transcribe/whisper.js`
- Create: `workspace-mirror/skills/transcribe/ollama-unload.js`
- Create: `workspace-mirror/skills/transcribe/bin/transcribe.js`
- Create: `workspace-mirror/skills/transcribe/tests/index.test.js`
- Create: `workspace-mirror/skills/transcribe/tests/whisper.test.js`

- [ ] **Step 5.1: Create `package.json`**

```json
{
  "name": "transcribe",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 5.2: Write failing tests**

Create `workspace-mirror/skills/transcribe/tests/index.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { createTranscribe } from "../index.js";

const FAKE_SRT = `1
00:00:00,000 --> 00:00:03,200
Welcome to the podcast.

2
00:00:03,200 --> 00:00:07,800
Today's guest is Sam Altman.
`;

function makeDeps(overrides = {}) {
  return {
    unloadOllama: vi.fn(async () => true),
    runWhisper: vi.fn(async () => FAKE_SRT),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T13:14:00Z"),
    transcriptRoot: "/tmp/transcripts",
    modelPath: "/fake/model.bin",
    ...overrides,
  };
}

describe("transcribe", () => {
  it("unloads Ollama before calling whisper", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(deps.unloadOllama).toHaveBeenCalled();
    const unloadOrder = deps.unloadOllama.mock.invocationCallOrder[0];
    const whisperOrder = deps.runWhisper.mock.invocationCallOrder[0];
    expect(unloadOrder).toBeLessThan(whisperOrder);
  });

  it("parses SRT into segments with correct timestamps", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    const result = await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(result.transcript.segments).toEqual([
      { t_start: 0.0, t_end: 3.2, text: "Welcome to the podcast." },
      { t_start: 3.2, t_end: 7.8, text: "Today's guest is Sam Altman." },
    ]);
  });

  it("writes Transcript JSON to expected path", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      "/tmp/transcripts/lex/ep1.json",
      expect.stringContaining('"episode_id": "ep1"')
    );
  });

  it("emits language field and whisper-large-v3 as model", async () => {
    const deps = makeDeps();
    const t = createTranscribe(deps);
    const r = await t.run({ audioPath: "/a/b.m4a", sourceId: "lex", episodeId: "ep1", title: "Ep 1", durationS: 120 });
    expect(r.transcript.language).toBe("en");
    expect(r.transcript.model).toBe("whisper-large-v3");
  });
});
```

Create `workspace-mirror/skills/transcribe/tests/whisper.test.js`:

```js
import { describe, it, expect } from "vitest";
import { parseSrt } from "../whisper.js";

describe("parseSrt", () => {
  it("handles comma and period decimal separators", () => {
    const srt = `1\n00:00:01,500 --> 00:00:04,000\nHello.\n`;
    const segs = parseSrt(srt);
    expect(segs).toEqual([{ t_start: 1.5, t_end: 4.0, text: "Hello." }]);
  });

  it("joins multi-line segment text with a space", () => {
    const srt = `1\n00:00:00,000 --> 00:00:02,000\nLine one.\nLine two.\n`;
    expect(parseSrt(srt)[0].text).toBe("Line one. Line two.");
  });

  it("ignores empty blocks", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("\n\n\n")).toEqual([]);
  });
});
```

- [ ] **Step 5.3: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/transcribe
npm install && npm test
```

Expected: FAIL.

- [ ] **Step 5.4: Implement `ollama-unload.js`**

```js
export function createOllamaUnloader({ baseUrl = "http://127.0.0.1:11434", fetch: f = fetch, models = ["qwen2.5:14b", "llama3.1:8b"] } = {}) {
  async function unload() {
    // POST /api/generate with keep_alive: 0 → Ollama evicts the model from RAM
    const results = await Promise.allSettled(models.map(async (m) => {
      const r = await f(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: "", keep_alive: 0 }),
      });
      return { model: m, ok: r.ok };
    }));
    // Don't fail if Ollama is down — just try
    return results.every(r => r.status === "fulfilled");
  }
  return { unload };
}
```

- [ ] **Step 5.5: Implement `whisper.js`**

```js
import { spawn } from "node:child_process";

export function parseSrt(srt) {
  const segments = [];
  const blocks = srt.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find(l => l.includes("-->"));
    if (!timeLine) continue;
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    const [startStr, endStr] = timeLine.split("-->").map(s => s.trim());
    const toSec = (t) => {
      const clean = t.replace(",", ".");
      const [h, m, s] = clean.split(":");
      return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
    };
    segments.push({
      t_start: toSec(startStr),
      t_end: toSec(endStr),
      text: textLines.join(" ").trim(),
    });
  }
  return segments;
}

export function createWhisperRunner({ binary = "whisper-cli", modelPath }) {
  async function runWhisper(audioPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-m", modelPath, "-l", "en", "-osrt", "-of", audioPath, audioPath]);
      let err = "";
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", async (code) => {
        if (code !== 0) return reject(new Error(`whisper exit ${code}: ${err}`));
        try {
          const { readFileSync } = await import("node:fs");
          const srt = readFileSync(`${audioPath}.srt`, "utf8");
          resolve(srt);
        } catch (e) {
          reject(e);
        }
      });
      proc.on("error", reject);
    });
  }
  return { runWhisper };
}
```

- [ ] **Step 5.6: Implement `index.js`**

```js
import { parseSrt } from "./whisper.js";
import { validateTranscript } from "shared/schemas";
import { join, dirname } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

export function createTranscribe(deps) {
  const { unloadOllama, runWhisper, writeFileSync, mkdirp, now, transcriptRoot } = deps;

  async function run({ audioPath, sourceId, episodeId, title, durationS }) {
    await unloadOllama();
    const srt = await runWhisper(audioPath);
    const segments = parseSrt(srt);
    const outDir = join(transcriptRoot, sourceId);
    mkdirp(outDir);
    const transcript = {
      source_id: sourceId,
      episode_id: episodeId,
      title,
      language: "en",
      duration_s: durationS,
      transcribed_at: now().toISOString(),
      model: "whisper-large-v3",
      segments,
    };
    const v = validateTranscript(transcript);
    if (!v.valid) throw new Error(`Transcript invalid: ${v.errors.join(", ")}`);
    const outPath = join(outDir, `${episodeId}.json`);
    writeFileSync(outPath, JSON.stringify(transcript, null, 2));
    // clean up intermediate SRT
    try { if (existsSync(`${audioPath}.srt`)) unlinkSync(`${audioPath}.srt`); } catch {}
    return { transcript, path: outPath };
  }

  return { run };
}
```

- [ ] **Step 5.7: Implement CLI `bin/transcribe.js`**

```js
#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createOllamaUnloader } from "../ollama-unload.js";
import { createWhisperRunner } from "../whisper.js";
import { createTranscribe } from "../index.js";

const [audioPath, sourceId, episodeId, title, durationS] = process.argv.slice(2);
if (!audioPath || !sourceId || !episodeId) {
  console.error("Usage: bin/transcribe.js <audio-path> <source-id> <episode-id> [title] [duration-s]");
  process.exit(1);
}

const unloader = createOllamaUnloader();
const whisper = createWhisperRunner({
  modelPath: process.env.WHISPER_MODEL_PATH || `${process.env.HOME}/.whisper-models/ggml-large-v3.bin`,
});

const transcribe = createTranscribe({
  unloadOllama: unloader.unload,
  runWhisper: whisper.runWhisper,
  writeFileSync,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  transcriptRoot: `${process.env.HOME}/openclaw-drafts/whitelist/transcript-cache`,
});

const { path } = await transcribe.run({
  audioPath, sourceId, episodeId,
  title: title || "Untitled", durationS: Number(durationS) || 0,
});
console.log(path);
```

`chmod +x workspace-mirror/skills/transcribe/bin/transcribe.js`

- [ ] **Step 5.8: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/transcribe
npm test
```

- [ ] **Step 5.9: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/transcribe/
git commit -m "feat(transcribe): whisper large-v3 wrapper with Ollama model eviction"
```

---

## Task 6: `slideshow-draft` skill — 6-beat script + Pexels storyboard

**Files:**
- Create: `workspace-mirror/skills/slideshow-draft/package.json`
- Create: `workspace-mirror/skills/slideshow-draft/index.js`
- Create: `workspace-mirror/skills/slideshow-draft/pexels.js`
- Create: `workspace-mirror/skills/slideshow-draft/bin/slideshow.js`
- Create: `workspace-mirror/skills/slideshow-draft/tests/index.test.js`

- [ ] **Step 6.1: Create `package.json`**

```json
{
  "name": "slideshow-draft",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 6.2: Write failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import { createSlideshowDraft } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass }) => {
        if (taskClass === "write") {
          // First call: script. Second call: beat split. Third call: caption.
          const n = deps.router.complete.mock.calls.length;
          if (n === 1) return { text: "A 60-second script about AI agents replacing junior devs...", tokens_in: 50, tokens_out: 200 };
          if (n === 2) return {
            text: JSON.stringify([
              { text: "AI agents are transforming software teams" },
              { text: "Junior devs spent years learning loops" },
              { text: "Now agents write entire functions" },
              { text: "But agents need senior engineers" },
              { text: "The skill shift is already happening" },
              { text: "Adapt or be left behind" },
            ]),
            tokens_in: 100, tokens_out: 150,
          };
          if (n === 3) return { text: "AI agents aren't replacing devs—they're reshaping the role.", tokens_in: 80, tokens_out: 40 };
          if (n === 4) return { text: "#ai #coding #dev #future #agents #tech #career", tokens_in: 50, tokens_out: 20 };
        }
        if (taskClass === "extract") {
          return { text: JSON.stringify(["office", "coding", "team"]), tokens_in: 30, tokens_out: 15 };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    pexelsSearch: vi.fn(async () => ({
      id: 123456,
      url: "https://images.pexels.com/photos/123456/example.jpg",
      photographer: "Jane Doe",
    })),
    writeDraft: vi.fn(),
    writeMedia: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T09:00:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-slideshow-001",
    ...overrides,
  };
}

let deps;
describe("slideshow-draft", () => {
  it("produces a Draft with 6 beats totaling 60s", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    const result = await ss.run({ topic: "AI agents replacing junior devs", niche: "ai" });
    expect(result.draft.mode).toBe("slideshow");
    expect(result.draft.topic).toBe("AI agents replacing junior devs");
    const storyboard = result.storyboard;
    expect(storyboard.beats).toHaveLength(6);
    const total = storyboard.beats.reduce((a, b) => a + b.duration_s, 0);
    expect(total).toBe(60);
  });

  it("writes draft.json + storyboard.json to draftsRoot/pending/<id>/", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    await ss.run({ topic: "test", niche: "ai" });
    expect(deps.writeDraft).toHaveBeenCalledWith(
      expect.stringContaining("2026-04-16-slideshow-001"),
      expect.objectContaining({ mode: "slideshow" }),
    );
    expect(deps.writeMedia).toHaveBeenCalledWith(
      expect.stringContaining("storyboard.json"),
      expect.any(String),
    );
  });

  it("calls Pexels once per beat", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    await ss.run({ topic: "test", niche: "ai" });
    expect(deps.pexelsSearch).toHaveBeenCalledTimes(6);
  });

  it("stores caption + hashtags on the draft", async () => {
    deps = makeDeps();
    const ss = createSlideshowDraft(deps);
    const { draft } = await ss.run({ topic: "test", niche: "ai" });
    expect(draft.caption).toBeTruthy();
    expect(Array.isArray(draft.hashtags)).toBe(true);
    expect(draft.hashtags.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6.3: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/slideshow-draft
npm install && npm test
```

- [ ] **Step 6.4: Implement `pexels.js`**

```js
export function createPexelsClient({ apiKey, fetch: f = fetch }) {
  async function searchOne(query) {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`;
    const resp = await f(url, { headers: { Authorization: apiKey } });
    if (!resp.ok) throw new Error(`Pexels HTTP ${resp.status}`);
    const body = await resp.json();
    const photo = body.photos?.[0];
    if (!photo) throw new Error(`no Pexels result for "${query}"`);
    return {
      id: photo.id,
      url: photo.src?.large || photo.src?.medium,
      photographer: photo.photographer,
    };
  }
  return { searchOne };
}
```

- [ ] **Step 6.5: Implement `index.js`**

```js
export function createSlideshowDraft(deps) {
  const { router, pexelsSearch, writeDraft, writeMedia, mkdirp, now, draftsRoot, idGenerator } = deps;

  async function run({ topic, niche, sourceContext = null }) {
    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);

    // Step 1: script
    const scriptResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 60-second spoken-word script (target ~150-180 words) for a short-form social video about: "${topic}". Niche: ${niche}. Tone: direct, curious, non-clickbait. Return just the script, no stage directions.`,
      maxTokens: 500,
    });
    const script = scriptResp.text.trim();

    // Step 2: split into 6 beats
    const splitResp = await router.complete({
      taskClass: "write",
      prompt: `Split this 60-second script into exactly 6 beats of ~10 seconds each. Return a JSON array [{"text":"..."}]. Script:\n\n${script}`,
      maxTokens: 800,
    });
    let beatTexts;
    try {
      beatTexts = JSON.parse(splitResp.text);
    } catch {
      throw new Error(`slideshow-draft: beat split JSON parse failed`);
    }
    if (!Array.isArray(beatTexts) || beatTexts.length !== 6) {
      throw new Error(`slideshow-draft: expected 6 beats, got ${beatTexts?.length}`);
    }

    // Step 3: per-beat keywords + Pexels search
    const beats = [];
    for (const b of beatTexts) {
      const kwResp = await router.complete({
        taskClass: "extract",
        prompt: `Return a JSON array of 2-3 concrete visual search keywords (nouns, not adjectives) that match this sentence. Sentence: "${b.text}"`,
        maxTokens: 100,
      });
      let keywords;
      try { keywords = JSON.parse(kwResp.text); } catch { keywords = [b.text.split(" ").slice(0, 3).join(" ")]; }
      const photo = await pexelsSearch(keywords.join(" "));
      beats.push({
        text: b.text,
        duration_s: 10,
        keywords,
        pexels_photo_id: photo.id,
        image_url: photo.url,
        pexels_attribution: `Photo by ${photo.photographer} on Pexels`,
      });
    }

    const storyboard = { script, duration_s: 60, beats };

    // Step 4: caption + hashtags
    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a punchy single-paragraph caption (max 220 chars) for a short video about: "${topic}". Niche: ${niche}. No hashtags. No emojis unless they genuinely land.`,
      maxTokens: 200,
    });
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for a post in niche "${niche}" about: "${topic}". No explanation.`,
      maxTokens: 100,
    });
    const caption = capResp.text.trim();
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "slideshow",
      topic,
      niche,
      caption,
      hashtags,
      media: [{ path: "media/storyboard.json", type: "storyboard", duration_s: 60 }],
      source: null,
      provider_used: scriptResp.provider || null,
      tokens_in: (scriptResp.tokens_in || 0) + (splitResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (scriptResp.tokens_out || 0) + (splitResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };

    writeDraft(id, draft);
    writeMedia(`${draftDir}/media/storyboard.json`, JSON.stringify(storyboard, null, 2));
    return { draft, storyboard, dir: draftDir };
  }

  return { run };
}
```

- [ ] **Step 6.6: Implement CLI `bin/slideshow.js`**

```js
#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createPexelsClient } from "../pexels.js";
import { createSlideshowDraft } from "../index.js";

const topic = process.argv[2];
const niche = process.argv[3];
if (!topic || !niche) {
  console.error("Usage: bin/slideshow.js \"<topic>\" <niche>");
  process.exit(1);
}

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const pexels = createPexelsClient({ apiKey: process.env.PEXELS_API_KEY });

const ss = createSlideshowDraft({
  router,
  pexelsSearch: pexels.searchOne,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeMedia: (path, content) => writeFileSync(path, content),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-slideshow-${rand}`;
  },
});

const result = await ss.run({ topic, niche });
console.log(result.dir);
```

`chmod +x workspace-mirror/skills/slideshow-draft/bin/slideshow.js`

- [ ] **Step 6.7: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/slideshow-draft
npm test
```

- [ ] **Step 6.8: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/slideshow-draft/
git commit -m "feat(slideshow-draft): 6-beat script + Pexels storyboard generator"
```

---

## Task 7: `quotecard-draft` skill — Node + Python/Pillow render

**Files:**
- Create: `workspace-mirror/skills/quotecard-draft/package.json`
- Create: `workspace-mirror/skills/quotecard-draft/index.js`
- Create: `workspace-mirror/skills/quotecard-draft/render.py`
- Create: `workspace-mirror/skills/quotecard-draft/bin/quotecard.js`
- Create: `workspace-mirror/skills/quotecard-draft/tests/index.test.js`

- [ ] **Step 7.1: Create `package.json`**

```json
{
  "name": "quotecard-draft",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 7.2: Write failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import { createQuotecardDraft } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "extract" || taskClass === "write") {
          if (/quote/i.test(prompt) && !/caption/i.test(prompt) && !/hashtag/i.test(prompt)) {
            return { text: "AI agents won't replace junior devs — they'll create them.", tokens_in: 100, tokens_out: 20 };
          }
          if (/caption/i.test(prompt)) return { text: "The future of junior devs.", tokens_in: 50, tokens_out: 15 };
          if (/hashtag/i.test(prompt)) return { text: "#ai #agents #dev #coding #future #tech #career #software #growth #learning", tokens_in: 50, tokens_out: 20 };
        }
        throw new Error(`unexpected ${taskClass} / ${prompt.slice(0, 40)}`);
      }),
    },
    renderCard: vi.fn(async (spec, outPath) => outPath),
    writeDraft: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T09:00:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-quotecard-001",
    ...overrides,
  };
}

describe("quotecard-draft", () => {
  it("produces a Draft with quotecard mode and card.png media", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    const { draft, cardPath } = await q.run({ topic: "AI agents replacing junior devs", niche: "ai" });
    expect(draft.mode).toBe("quotecard");
    expect(draft.media[0].type).toBe("image");
    expect(cardPath).toContain("card.png");
  });

  it("invokes render subprocess with spec including quote + attribution", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    await q.run({ topic: "test topic", niche: "ai" });
    expect(deps.renderCard).toHaveBeenCalled();
    const [spec, outPath] = deps.renderCard.mock.calls[0];
    expect(spec.quote).toBeTruthy();
    expect(spec.niche).toBe("ai");
    expect(outPath).toContain("card.png");
  });

  it("uses `extract` task class when sourceContext provided, else `write`", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    await q.run({ topic: "test", niche: "ai", sourceContext: "Some long article text..." });
    const calls = deps.router.complete.mock.calls;
    expect(calls.some(c => c[0].taskClass === "extract")).toBe(true);
  });

  it("caption + hashtags populated on draft", async () => {
    const deps = makeDeps();
    const q = createQuotecardDraft(deps);
    const { draft } = await q.run({ topic: "test", niche: "ai" });
    expect(draft.caption).toBeTruthy();
    expect(draft.hashtags.length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 7.3: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/quotecard-draft
npm install && npm test
```

- [ ] **Step 7.4: Implement `render.py`**

```python
#!/usr/bin/env python3
"""Renders a quotecard PNG from a JSON spec on stdin.

Input JSON:
  {
    "quote": "text",
    "attribution": "optional source",
    "niche": "ai" | "finance" | "make-money-with-ai",
    "template": "default",
    "out_path": "/path/to/card.png"
  }
"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1080
BG = (15, 23, 42)         # #0F172A
FG = (245, 245, 250)      # near-white
MUTED = (148, 163, 184)   # slate-400
PAD = 100
MAX_W = W - 2 * PAD

def wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], []
    for w in words:
        cur.append(w)
        bbox = draw.textbbox((0, 0), " ".join(cur), font=font)
        if bbox[2] - bbox[0] > max_w:
            cur.pop()
            if cur: lines.append(" ".join(cur))
            cur = [w]
    if cur: lines.append(" ".join(cur))
    return lines

def pick_font(size):
    candidates = [
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/Library/Fonts/Georgia.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def render(spec):
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    quote = spec["quote"].strip()
    if not quote.startswith('"'): quote = f'"{quote}"'

    size = 56
    font = pick_font(size)
    lines = wrap(draw, quote, font, MAX_W)
    while len(lines) > 9 and size > 28:
        size -= 4
        font = pick_font(size)
        lines = wrap(draw, quote, font, MAX_W)

    line_h = int(size * 1.35)
    total_h = line_h * len(lines)
    y = (H - total_h) // 2 - 20
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        w = bbox[2] - bbox[0]
        draw.text(((W - w) // 2, y), line, font=font, fill=FG)
        y += line_h

    attribution = spec.get("attribution", "").strip()
    if attribution:
        small = pick_font(24)
        draw.text((PAD, H - PAD - 28), attribution, font=small, fill=MUTED)

    niche = spec.get("niche", "")
    if niche:
        small = pick_font(22)
        bbox = draw.textbbox((0, 0), niche, font=small)
        w = bbox[2] - bbox[0]
        draw.text((W - PAD - w, H - PAD - 28), niche, font=small, fill=MUTED)

    out_path = spec["out_path"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, "PNG")
    return out_path

if __name__ == "__main__":
    spec = json.load(sys.stdin)
    path = render(spec)
    print(path)
```

- [ ] **Step 7.5: Implement `index.js`**

```js
import { spawn } from "node:child_process";

export function createRenderCard({ pythonBin = "python3", scriptPath }) {
  return async function renderCard(spec, outPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(pythonBin, [scriptPath]);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`render.py exit ${code}: ${stderr}`));
        resolve(stdout.trim() || outPath);
      });
      proc.on("error", reject);
      proc.stdin.write(JSON.stringify({ ...spec, out_path: outPath }));
      proc.stdin.end();
    });
  };
}

export function createQuotecardDraft(deps) {
  const { router, renderCard, writeDraft, mkdirp, now, draftsRoot, idGenerator } = deps;

  async function run({ topic, niche, sourceContext = null }) {
    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);

    // Pull the quote
    let quoteResp;
    if (sourceContext) {
      quoteResp = await router.complete({
        taskClass: "extract",
        prompt: `From the passage below, extract a single punchy quote (1-2 sentences) that stands alone and would work as a quote card. Return only the quote text, no quotation marks.\n\nPassage:\n${sourceContext}`,
        maxTokens: 200,
      });
    } else {
      quoteResp = await router.complete({
        taskClass: "write",
        prompt: `Write a single punchy quote (1-2 sentences) about: "${topic}". It should feel like something a thoughtful practitioner would say — not a marketing tagline. Niche: ${niche}. Return only the quote.`,
        maxTokens: 200,
      });
    }
    const quote = quoteResp.text.trim().replace(/^["'"]+|["'"]+$/g, "");

    const spec = {
      quote,
      attribution: sourceContext ? "source" : "",
      niche,
      template: "default",
    };
    const cardPath = `${draftDir}/media/card.png`;
    await renderCard(spec, cardPath);

    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 1-2 sentence caption (max 200 chars) for an Instagram post of a quote card about: "${topic}". Tone: thoughtful. No hashtags.`,
      maxTokens: 150,
    });
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for the niche "${niche}" about "${topic}". No explanation.`,
      maxTokens: 100,
    });
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "quotecard",
      topic,
      niche,
      caption: capResp.text.trim(),
      hashtags,
      media: [{ path: "media/card.png", type: "image" }],
      source: null,
      provider_used: quoteResp.provider || null,
      tokens_in: (quoteResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (quoteResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };
    writeDraft(id, draft);
    return { draft, cardPath, dir: draftDir };
  }

  return { run };
}
```

- [ ] **Step 7.6: Implement CLI `bin/quotecard.js`**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createRenderCard, createQuotecardDraft } from "../index.js";

const [topic, contextPath] = process.argv.slice(2);
if (!topic) { console.error("Usage: bin/quotecard.js \"<topic>\" [<context-path>]"); process.exit(1); }

const sourceContext = contextPath ? readFileSync(contextPath, "utf8") : null;

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const here = dirname(fileURLToPath(import.meta.url));
const renderCard = createRenderCard({
  pythonBin: `${process.env.HOME}/.openclaw/workspace/.venv/bin/python3`,
  scriptPath: resolve(here, "..", "render.py"),
});

const q = createQuotecardDraft({
  router,
  renderCard,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => {
    const d = new Date();
    const stamp = d.toISOString().slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-quotecard-${rand}`;
  },
});

const { dir } = await q.run({ topic, niche: "ai", sourceContext });
console.log(dir);
```

`chmod +x workspace-mirror/skills/quotecard-draft/bin/quotecard.js workspace-mirror/skills/quotecard-draft/render.py`

- [ ] **Step 7.7: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/quotecard-draft
npm test
```

- [ ] **Step 7.8: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/quotecard-draft/
git commit -m "feat(quotecard-draft): LLM quote + Python/Pillow 1080x1080 card render"
```

---

## Task 8: `source-discovery` skill — HITL Telegram approval

**Files:**
- Create: `workspace-mirror/skills/source-discovery/package.json`
- Create: `workspace-mirror/skills/source-discovery/index.js`
- Create: `workspace-mirror/skills/source-discovery/youtube-api.js`
- Create: `workspace-mirror/skills/source-discovery/policy-check.js`
- Create: `workspace-mirror/skills/source-discovery/approval-format.js`
- Create: `workspace-mirror/skills/source-discovery/bin/discover.js`
- Create: `workspace-mirror/skills/source-discovery/tests/index.test.js`
- Create: `workspace-mirror/skills/source-discovery/tests/policy-check.test.js`

- [ ] **Step 8.1: Create `package.json`**

```json
{
  "name": "source-discovery",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 8.2: Write failing tests for `policy-check.js`**

Create `workspace-mirror/skills/source-discovery/tests/policy-check.test.js`:

```js
import { describe, it, expect } from "vitest";
import { regexPrecheck, validateEvidenceSnippet } from "../policy-check.js";

describe("regexPrecheck", () => {
  it("accepts 'clipping is allowed'", () => {
    expect(regexPrecheck("Clipping is allowed, please credit.")).toBe(true);
  });
  it("accepts 'feel free to clip'", () => {
    expect(regexPrecheck("Feel free to clip highlights.")).toBe(true);
  });
  it("accepts CC-BY", () => {
    expect(regexPrecheck("Licensed under Creative Commons Attribution 4.0.")).toBe(true);
  });
  it("rejects CC-BY-NC (non-commercial)", () => {
    expect(regexPrecheck("Creative Commons Attribution-NonCommercial")).toBe(false);
  });
  it("rejects plain prose with no permission language", () => {
    expect(regexPrecheck("All rights reserved. © 2026.")).toBe(false);
  });
  it("rejects 'we clip music under license' (not clip-permission)", () => {
    expect(regexPrecheck("We clip music under license.")).toBe(false);
  });
});

describe("validateEvidenceSnippet", () => {
  it("passes when snippet is substring of page text", () => {
    const page = "Long page text including 'Feel free to clip highlights' as policy.";
    expect(validateEvidenceSnippet("Feel free to clip highlights", page)).toBe(true);
  });
  it("fails when snippet is paraphrased/not found", () => {
    const page = "Long page text.";
    expect(validateEvidenceSnippet("Please feel free to clip", page)).toBe(false);
  });
});
```

- [ ] **Step 8.3: Write failing tests for `index.js`**

```js
import { describe, it, expect, vi } from "vitest";
import { createSourceDiscovery } from "../index.js";

function makeDeps(overrides = {}) {
  return {
    youtube: {
      getChannelById: vi.fn(async () => ({
        id: "UCSHZK",
        title: "Lex Fridman",
        handle: "@lexfridman",
        subs: 5300000,
        description: "See clip policy at lexfridman.com/clip-policy",
      })),
      searchChannelsInNiche: vi.fn(async () => [{ id: "UCSHZK", title: "Lex" }]),
      getRecentVideoStats: vi.fn(async () => ({ recent_30d_views: 12400000 })),
    },
    browser: {
      fetchPage: vi.fn(async () => ({
        text: "Feel free to clip highlights from the podcast. Credit with 🎙️ From Lex Fridman {episode_title}.",
        url: "https://lexfridman.com/clip-policy",
      })),
    },
    router: {
      complete: vi.fn(async ({ taskClass, prompt }) => {
        if (taskClass === "bulk-classify") {
          return {
            text: JSON.stringify({
              license_type: "permission-granted",
              confidence: 0.92,
              evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
              attribution_template: "🎙️ From Lex Fridman {episode_title}",
              niche_fit: "ai",
              niche_fit_confidence: 0.9,
            }),
            tokens_in: 200, tokens_out: 100,
          };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    telegramSendCandidate: vi.fn(async () => ({ message_id: 42 })),
    pendingSourceStore: {
      create: vi.fn(),
    },
    now: () => new Date("2026-04-16T10:00:00Z"),
    idGenerator: () => "2026-04-16-cand-lex-001",
    ...overrides,
  };
}

describe("source-discovery", () => {
  it("push mode: creates candidate from URL and DMs user", async () => {
    const deps = makeDeps();
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@lexfridman", "ai");
    expect(deps.telegramSendCandidate).toHaveBeenCalled();
    expect(result.candidate).toMatchObject({
      discovery_mode: "push",
      creator: "Lex Fridman",
      license_type: "permission-granted",
    });
    expect(deps.pendingSourceStore.create).toHaveBeenCalled();
  });

  it("push mode: drops candidate when regex precheck fails", async () => {
    const deps = makeDeps({
      browser: {
        fetchPage: vi.fn(async () => ({ text: "All rights reserved. © 2026.", url: "https://x.com" })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
    expect(deps.telegramSendCandidate).not.toHaveBeenCalled();
  });

  it("drops candidate when LLM evidence snippet is not substring of fetched page", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.95,
            evidence_snippet_verbatim: "PARAPHRASED — not in page",
            attribution_template: "🎙️ From X {episode_title}",
            niche_fit: "ai",
            niche_fit_confidence: 0.9,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
    expect(deps.telegramSendCandidate).not.toHaveBeenCalled();
  });

  it("drops candidate when recommendation_confidence < 0.7", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.5,
            evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
            attribution_template: "🎙️ From X {episode_title}",
            niche_fit: "ai",
            niche_fit_confidence: 0.3,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
  });

  it("drops candidate with invalid attribution_template (no placeholder)", async () => {
    const deps = makeDeps({
      router: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            license_type: "permission-granted",
            confidence: 0.95,
            evidence_snippet_verbatim: "Feel free to clip highlights from the podcast.",
            attribution_template: "From Lex Fridman",  // no {episode_title}
            niche_fit: "ai",
            niche_fit_confidence: 0.9,
          }),
          tokens_in: 100, tokens_out: 50,
        })),
      },
    });
    const sd = createSourceDiscovery(deps);
    const result = await sd.runPush("https://www.youtube.com/@x", "ai");
    expect(result.candidate).toBeNull();
  });
});
```

- [ ] **Step 8.4: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/source-discovery
npm install && npm test
```

- [ ] **Step 8.5: Implement `policy-check.js`**

```js
const PERMISSION_REGEX = /\b(clip|clipping|highlight|repost|excerpt|short)s?\b.{0,60}\b(allow|grant|permit|free|welcome|ok|fine|encouraged)/i;
const CC_OK = /creative commons\s*(attribution|BY)(?!\s*[-–—]?\s*(NC|ND|NonCommercial|NoDerivatives))/i;
const CC_RESTRICTED = /creative commons\s*[-–—]?\s*(NC|ND|NonCommercial|NoDerivatives)/i;

export function regexPrecheck(pageText) {
  if (CC_RESTRICTED.test(pageText)) return false;
  if (CC_OK.test(pageText)) return true;
  return PERMISSION_REGEX.test(pageText);
}

export function validateEvidenceSnippet(snippet, pageText) {
  if (!snippet || !pageText) return false;
  // Compare in a whitespace-normalized form to survive HTML-to-text quirks
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(pageText).includes(norm(snippet));
}
```

- [ ] **Step 8.6: Implement `youtube-api.js`**

```js
const API = "https://www.googleapis.com/youtube/v3";

export function createYouTubeClient({ apiKey, fetch: f = fetch }) {
  async function getChannelById(channelId) {
    const url = `${API}/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`;
    const r = await f(url);
    if (!r.ok) throw new Error(`YouTube HTTP ${r.status}`);
    const body = await r.json();
    const item = body.items?.[0];
    if (!item) return null;
    return {
      id: item.id,
      title: item.snippet?.title,
      handle: item.snippet?.customUrl || null,
      subs: Number(item.statistics?.subscriberCount || 0),
      description: item.snippet?.description || "",
    };
  }

  async function searchChannelsInNiche(niche, { publishedAfterDays = 30, maxResults = 25 } = {}) {
    const since = new Date(Date.now() - publishedAfterDays * 24 * 3600 * 1000).toISOString();
    const url = `${API}/search?part=snippet&type=channel&q=${encodeURIComponent(niche)}&publishedAfter=${since}&maxResults=${maxResults}&key=${apiKey}`;
    const r = await f(url);
    if (!r.ok) throw new Error(`YouTube search HTTP ${r.status}`);
    const body = await r.json();
    return (body.items || []).map(i => ({ id: i.id?.channelId, title: i.snippet?.title }));
  }

  async function getRecentVideoStats(channelId) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const searchUrl = `${API}/search?part=id&channelId=${channelId}&publishedAfter=${since}&type=video&order=date&maxResults=10&key=${apiKey}`;
    const sr = await f(searchUrl);
    if (!sr.ok) return { recent_30d_views: 0 };
    const sb = await sr.json();
    const ids = (sb.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length === 0) return { recent_30d_views: 0 };
    const videosUrl = `${API}/videos?part=statistics&id=${ids.join(",")}&key=${apiKey}`;
    const vr = await f(videosUrl);
    if (!vr.ok) return { recent_30d_views: 0 };
    const vb = await vr.json();
    const total = (vb.items || []).reduce((sum, v) => sum + Number(v.statistics?.viewCount || 0), 0);
    return { recent_30d_views: total };
  }

  return { getChannelById, searchChannelsInNiche, getRecentVideoStats };
}
```

- [ ] **Step 8.7: Implement `approval-format.js`**

```js
export function formatCandidateMessage(c) {
  const lines = [];
  lines.push(`🔍 Candidate: ${c.creator}  •  ${c.channel_handle || c.channel_id} (${formatNum(c.subs)} subs)`);
  lines.push(`Niche: ${c.niche}  •  Velocity: ${c.velocity_score?.toFixed(2) || "?"}`);
  lines.push(`License: ${c.license_type}`);
  lines.push(``);
  lines.push(`Evidence:`);
  lines.push(`"${c.license_evidence_snippet}"`);
  lines.push(``);
  lines.push(`Attribution: ${c.attribution_template}`);
  return lines.join("\n");
}

export function candidateInlineKeyboard(c) {
  return {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `s:approve:${c.candidate_id}` },
      { text: "❌ Reject", callback_data: `s:reject:${c.candidate_id}` },
      { text: "🔗 Evidence", url: c.license_evidence_url },
    ]],
  };
}

function formatNum(n) {
  if (!n) return "?";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 8.8: Implement `index.js`**

```js
import { validateCandidate } from "shared/schemas";
import { regexPrecheck, validateEvidenceSnippet } from "./policy-check.js";

const CONFIDENCE_THRESHOLD = 0.7;

function extractChannelIdFromUrl(url) {
  const handleMatch = url.match(/\/@([^/?]+)/);
  if (handleMatch) return { handle: handleMatch[1] };
  const idMatch = url.match(/\/channel\/([^/?]+)/);
  if (idMatch) return { id: idMatch[1] };
  return null;
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

export function createSourceDiscovery(deps) {
  const { youtube, browser, router, telegramSendCandidate, pendingSourceStore, now, idGenerator } = deps;

  async function evaluateCandidate({ channel, discovery_mode, niche }) {
    // 1. Find policy page: if channel.policy_url given use it; else try to extract
    //    a URL from channel.description. If no URL found, use the description itself
    //    as the page text (covers the case where the description IS the policy).
    let pageResult;
    try {
      if (channel.policy_url) {
        pageResult = await browser.fetchPage(channel.policy_url);
      } else {
        const url = extractFirstUrl(channel.description || "");
        pageResult = url
          ? await browser.fetchPage(url)
          : { text: channel.description || "", url: channel.url || "" };
      }
    } catch {
      return null;
    }
    if (!pageResult?.text) return null;

    // 2. Regex precheck
    if (!regexPrecheck(pageResult.text)) return null;

    // 3. LLM extract policy
    const llmResp = await router.complete({
      taskClass: "bulk-classify",
      prompt: `From the page text below, return a JSON object:
{
  "license_type": "permission-granted" | "restricted" | "unclear",
  "confidence": 0.0-1.0,
  "evidence_snippet_verbatim": "EXACT substring copied from page text — no paraphrasing, must be findable via Ctrl-F",
  "attribution_template": "template using {episode_title} or {episode_num} or {creator}",
  "niche_fit": "ai" | "finance" | "make-money-with-ai" | "other",
  "niche_fit_confidence": 0.0-1.0
}

Page URL: ${pageResult.url}
Page text (first 4000 chars):
${pageResult.text.slice(0, 4000)}

Return ONLY the JSON object.`,
      maxTokens: 400,
    });
    let parsed;
    try { parsed = JSON.parse(llmResp.text); } catch { return null; }

    // 4. Verbatim snippet validation
    if (!validateEvidenceSnippet(parsed.evidence_snippet_verbatim, pageResult.text)) return null;

    // 5. License type + confidence
    if (parsed.license_type !== "permission-granted") return null;
    const recommendation_confidence = Math.min(parsed.confidence || 0, parsed.niche_fit_confidence || 0);
    if (recommendation_confidence < CONFIDENCE_THRESHOLD) return null;

    // 6. Velocity
    const { recent_30d_views } = await youtube.getRecentVideoStats(channel.id);
    const velocity_score = channel.subs > 0 ? recent_30d_views / channel.subs : 0;

    // 7. Build candidate
    const candidate = {
      candidate_id: idGenerator(),
      discovered_at: now().toISOString(),
      discovery_mode,
      creator: channel.title,
      channel_id: channel.id,
      channel_handle: channel.handle || null,
      url: `https://www.youtube.com/channel/${channel.id}`,
      subs: channel.subs,
      recent_30d_views,
      velocity_score,
      niche,
      niche_fit_confidence: parsed.niche_fit_confidence,
      license_type: parsed.license_type,
      license_evidence_url: pageResult.url,
      license_evidence_snippet: parsed.evidence_snippet_verbatim,
      attribution_template: parsed.attribution_template,
      recommendation_confidence,
    };

    const v = validateCandidate(candidate);
    if (!v.valid) return null; // attribution_template placeholder check lives in validator

    return candidate;
  }

  async function runPush(url, niche = "ai") {
    const locate = extractChannelIdFromUrl(url);
    if (!locate) return { candidate: null, reason: "unparseable url" };
    const channel = locate.id
      ? await youtube.getChannelById(locate.id)
      : await youtube.getChannelById(`@${locate.handle}`); // simplification
    if (!channel) return { candidate: null, reason: "channel not found" };

    const candidate = await evaluateCandidate({ channel, discovery_mode: "push", niche });
    if (!candidate) return { candidate: null, reason: "filtered" };

    pendingSourceStore.create(candidate);
    await telegramSendCandidate(candidate);
    return { candidate };
  }

  async function runPull(niche = "ai", { maxCandidates = 3 } = {}) {
    const channels = await youtube.searchChannelsInNiche(niche);
    const candidates = [];
    for (const { id } of channels) {
      if (candidates.length >= maxCandidates) break;
      const ch = await youtube.getChannelById(id);
      if (!ch) continue;
      const candidate = await evaluateCandidate({ channel: ch, discovery_mode: "pull", niche });
      if (candidate) {
        pendingSourceStore.create(candidate);
        await telegramSendCandidate(candidate);
        candidates.push(candidate);
      }
    }
    return { candidates };
  }

  return { runPush, runPull, evaluateCandidate };
}
```

- [ ] **Step 8.9: Implement CLI `bin/discover.js`**

```js
#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createTelegramClient } from "../../shared/telegram-client.js";
import { createYouTubeClient } from "../youtube-api.js";
import { createSourceDiscovery } from "../index.js";
import { formatCandidateMessage, candidateInlineKeyboard } from "../approval-format.js";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split("=").map(s => s.replace(/^--/, ""))));
if (!args.url && !args.niche) { console.error("Usage: bin/discover.js --url=<url> [--niche=ai]  OR  --niche=ai"); process.exit(1); }

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});

const youtube = createYouTubeClient({ apiKey: process.env.YOUTUBE_API_KEY });

const browser = {
  async fetchPage(url) {
    const r = await fetch(url, { headers: { "user-agent": "openclaw-sourcedisco/0.1" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ")
                     .replace(/<style[\s\S]*?<\/style>/g, " ")
                     .replace(/<[^>]+>/g, " ")
                     .replace(/&nbsp;/g, " ")
                     .replace(/\s+/g, " ").trim();
    return { text, url };
  },
};

const tg = createTelegramClient({ botToken: process.env.TG_BOT_TOKEN, chatId: Number(process.env.TG_PAIRED_USER_ID) });

const pendingRoot = `${process.env.HOME}/openclaw-drafts/pending-source`;
const pendingSourceStore = {
  create(c) {
    const dir = `${pendingRoot}/${c.candidate_id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "pending", candidate: c }, null, 2));
  },
};

const telegramSendCandidate = async (c) => {
  const text = formatCandidateMessage(c);
  return tg.sendMessage({ text, reply_markup: candidateInlineKeyboard(c) });
};

const sd = createSourceDiscovery({
  youtube, browser, router, telegramSendCandidate, pendingSourceStore,
  now: () => new Date(),
  idGenerator: () => `${new Date().toISOString().slice(0,10)}-cand-${Math.random().toString(36).slice(2, 8)}`,
});

const result = args.url ? await sd.runPush(args.url, args.niche || "ai") : await sd.runPull(args.niche);
console.log(JSON.stringify(result, null, 2));
```

`chmod +x workspace-mirror/skills/source-discovery/bin/discover.js`

- [ ] **Step 8.10: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/source-discovery
npm test
```

- [ ] **Step 8.11: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/source-discovery/
git commit -m "feat(source-discovery): YouTube Data API + multi-step compliance gate + Telegram HITL"
```

---

## Task 9: `clip-extract` skill — LLM moment detection + FFmpeg vertical cut

**Files:**
- Create: `workspace-mirror/skills/clip-extract/package.json`
- Create: `workspace-mirror/skills/clip-extract/index.js`
- Create: `workspace-mirror/skills/clip-extract/ffmpeg.js`
- Create: `workspace-mirror/skills/clip-extract/srt.js`
- Create: `workspace-mirror/skills/clip-extract/bin/extract.js`
- Create: `workspace-mirror/skills/clip-extract/tests/index.test.js`
- Create: `workspace-mirror/skills/clip-extract/tests/srt.test.js`

- [ ] **Step 9.1: Create `package.json`**

```json
{
  "name": "clip-extract",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "shared": "file:../shared" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 9.2: Write failing tests for `srt.js`**

```js
import { describe, it, expect } from "vitest";
import { buildClipSrt, formatSrtTime } from "../srt.js";

describe("formatSrtTime", () => {
  it("0.0 → 00:00:00,000", () => {
    expect(formatSrtTime(0.0)).toBe("00:00:00,000");
  });
  it("3.5 → 00:00:03,500", () => {
    expect(formatSrtTime(3.5)).toBe("00:00:03,500");
  });
  it("65.25 → 00:01:05,250", () => {
    expect(formatSrtTime(65.25)).toBe("00:01:05,250");
  });
});

describe("buildClipSrt", () => {
  const segments = [
    { t_start: 100.0, t_end: 103.0, text: "Before the clip." },
    { t_start: 1830.0, t_end: 1832.5, text: "Viral moment starts." },
    { t_start: 1832.5, t_end: 1837.0, text: "Followed by a hook." },
    { t_start: 1840.0, t_end: 1842.0, text: "After clip ends." },
  ];
  it("filters segments inside [start, end] and shifts timestamps to clip-local", () => {
    const srt = buildClipSrt(segments, 1830.0, 1839.0);
    expect(srt).toContain("00:00:00,000 --> 00:00:02,500");
    expect(srt).toContain("Viral moment starts.");
    expect(srt).toContain("00:00:02,500 --> 00:00:07,000");
    expect(srt).toContain("Followed by a hook.");
    expect(srt).not.toContain("Before the clip.");
    expect(srt).not.toContain("After clip ends.");
  });
});
```

- [ ] **Step 9.3: Write failing tests for `index.js`**

```js
import { describe, it, expect, vi } from "vitest";
import { createClipExtract } from "../index.js";

const TRANSCRIPT = {
  source_id: "lex-fridman",
  episode_id: "ep999",
  title: "Lex Fridman #999",
  language: "en",
  duration_s: 7200,
  transcribed_at: "2026-04-16T13:14:00Z",
  model: "whisper-large-v3",
  segments: [
    { t_start: 1830.0, t_end: 1832.5, text: "AI agents won't replace junior devs." },
    { t_start: 1832.5, t_end: 1837.0, text: "They'll create them." },
  ],
};

function makeDeps(overrides = {}) {
  return {
    router: {
      complete: vi.fn(async ({ taskClass }) => {
        if (taskClass === "reason") {
          return {
            text: JSON.stringify([
              { start_s: 1830.0, end_s: 1877.0, reasoning: "hook quote", hook_quote: "AI agents won't replace junior devs" },
            ]),
            tokens_in: 5000, tokens_out: 200,
          };
        }
        if (taskClass === "write") {
          const calls = deps.router.complete.mock.calls.length;
          if (calls === 2) return { text: "Sam Altman on why agents won't replace devs.", tokens_in: 100, tokens_out: 30 };
          if (calls === 3) return { text: "#ai #agents #dev #coding #future #software #tech #growth #career #podcast", tokens_in: 50, tokens_out: 20 };
        }
        throw new Error(`unexpected ${taskClass}`);
      }),
    },
    runFfmpeg: vi.fn(async () => true),
    writeDraft: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirp: vi.fn(),
    now: () => new Date("2026-04-16T13:20:00Z"),
    draftsRoot: "/tmp/drafts",
    idGenerator: () => "2026-04-16-clip-001",
    ...overrides,
  };
}

let deps;
describe("clip-extract", () => {
  it("produces a clip Draft with mode=clip and media/0.mp4", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    const result = await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    expect(result.draft.mode).toBe("clip");
    expect(result.draft.media[0].path).toBe("media/0.mp4");
    expect(result.draft.source).toBeTruthy();
    expect(result.draft.source.clip_range).toEqual([1830.0, 1877.0]);
  });

  it("writes clip-local SRT before invoking ffmpeg", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    const srtWrite = deps.writeFileSync.mock.calls.find(c => /clip\.srt$/.test(c[0]));
    expect(srtWrite).toBeTruthy();
    const ffmpegOrder = deps.runFfmpeg.mock.invocationCallOrder[0];
    const srtWriteOrder = deps.writeFileSync.mock.invocationCallOrder[deps.writeFileSync.mock.calls.indexOf(srtWrite)];
    expect(srtWriteOrder).toBeLessThan(ffmpegOrder);
  });

  it("passes start_s, end_s, video path, srt path to ffmpeg", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    const [args] = deps.runFfmpeg.mock.calls[0];
    expect(args).toMatchObject({
      startS: 1830.0,
      endS: 1877.0,
      inputPath: "/fake/ep999.mp4",
      outputPath: expect.stringContaining("0.mp4"),
      srtPath: expect.stringContaining("clip.srt"),
    });
  });

  it("draft.source.attribution_template renders with episode title substituted", async () => {
    deps = makeDeps();
    const ce = createClipExtract(deps);
    const source = { id: "lex-fridman", title: "Lex Fridman", license: "permission-granted", attribution_template: "🎙️ From {episode_title}" };
    const { draft } = await ce.run({ transcript: TRANSCRIPT, source, videoPath: "/fake/ep999.mp4" });
    expect(draft.source.attribution).toContain("Lex Fridman #999");
  });
});
```

- [ ] **Step 9.4: Run tests — verify failure**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/clip-extract
npm install && npm test
```

- [ ] **Step 9.5: Implement `srt.js`**

```js
export function formatSrtTime(s) {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

export function buildClipSrt(segments, startS, endS) {
  const inRange = segments.filter(s => s.t_end > startS && s.t_start < endS);
  const shifted = inRange.map((s, idx) => {
    const localStart = Math.max(0, s.t_start - startS);
    const localEnd = Math.min(endS - startS, s.t_end - startS);
    return { idx: idx + 1, localStart, localEnd, text: s.text };
  });
  return shifted.map(s =>
    `${s.idx}\n${formatSrtTime(s.localStart)} --> ${formatSrtTime(s.localEnd)}\n${s.text}\n`
  ).join("\n");
}
```

- [ ] **Step 9.6: Implement `ffmpeg.js`**

```js
import { spawn } from "node:child_process";

export function createFfmpegRunner({ binary = "ffmpeg" } = {}) {
  return async function runFfmpeg({ startS, endS, inputPath, outputPath, srtPath }) {
    // Build the filter string. NOTE: subtitles=path escapes any commas/colons via :
    const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=${srtPath}:force_style='FontName=Inter,Fontsize=28,Alignment=2,OutlineColour=&H00000000,BorderStyle=3'`;
    const args = [
      "-y",
      "-ss", String(startS),
      "-to", String(endS),
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "23",
      "-c:a", "aac",
      "-r", "30",
      outputPath,
    ];
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args);
      let err = "";
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => code === 0 ? resolve(true) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`)));
      proc.on("error", reject);
    });
  };
}
```

- [ ] **Step 9.7: Implement `index.js`**

```js
import { buildClipSrt } from "./srt.js";

export function createClipExtract(deps) {
  const { router, runFfmpeg, writeDraft, writeFileSync, mkdirp, now, draftsRoot, idGenerator } = deps;

  function renderAttribution(template, episodeTitle, creator) {
    return template
      .replace("{episode_title}", episodeTitle || "")
      .replace("{creator}", creator || "")
      .replace(/\{episode_num\}/g, "");
  }

  async function run({ transcript, source, videoPath }) {
    // 1. LLM picks top 3 viral moments
    const prompt = `You are scanning a podcast transcript for viral clippable moments. Given these transcript segments, return a JSON array of the top 3 candidates. Each candidate must be 40-60 seconds long.
Return format:
[{"start_s": <float>, "end_s": <float>, "reasoning": "<short>", "hook_quote": "<exact quote>"}]

Transcript (full segments):
${transcript.segments.map(s => `[${s.t_start.toFixed(1)}-${s.t_end.toFixed(1)}] ${s.text}`).join("\n")}

Return ONLY the JSON array.`;
    const pickResp = await router.complete({ taskClass: "reason", prompt, maxTokens: 1000 });
    let candidates;
    try { candidates = JSON.parse(pickResp.text); } catch { throw new Error(`clip-extract: LLM picker JSON invalid`); }
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`clip-extract: no candidates returned`);
    const pick = candidates[0];

    // 2. Build clip-local SRT
    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);
    const srtPath = `${draftDir}/media/clip.srt`;
    writeFileSync(srtPath, buildClipSrt(transcript.segments, pick.start_s, pick.end_s));

    // 3. FFmpeg vertical cut + subtitle burn
    const outputPath = `${draftDir}/media/0.mp4`;
    await runFfmpeg({ startS: pick.start_s, endS: pick.end_s, inputPath: videoPath, outputPath, srtPath });

    // 4. Caption
    const attribution = renderAttribution(source.attribution_template, transcript.title, source.creator || source.title);
    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 1-2 sentence Instagram caption (max 200 chars) for a clip. Tone: thoughtful. End with: "${attribution}". Do not include hashtags. Clip content:\n"${pick.hook_quote}"`,
      maxTokens: 200,
    });
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for a clip from the "${source.id}" channel about: "${pick.hook_quote}". No explanation.`,
      maxTokens: 100,
    });
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "clip",
      topic: pick.hook_quote.slice(0, 80),
      niche: (source.niches && source.niches[0]) || "ai",
      caption: capResp.text.trim(),
      hashtags,
      media: [{ path: "media/0.mp4", type: "video", duration_s: Math.round(pick.end_s - pick.start_s) }],
      source: {
        url: source.url || null,
        title: transcript.title,
        creator: source.creator || source.title,
        license: source.license,
        attribution_required: true,
        attribution_template: source.attribution_template,
        attribution,
        clip_range: [pick.start_s, pick.end_s],
      },
      provider_used: pickResp.provider || null,
      tokens_in: (pickResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (pickResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };
    writeDraft(id, draft);
    return { draft, dir: draftDir };
  }

  return { run };
}
```

- [ ] **Step 9.8: Implement CLI `bin/extract.js`**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createFfmpegRunner } from "../ffmpeg.js";
import { createClipExtract } from "../index.js";

const [transcriptPath, sourceId] = process.argv.slice(2);
if (!transcriptPath || !sourceId) { console.error("Usage: bin/extract.js <transcript-path> <source-id>"); process.exit(1); }

const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
const sources = yaml.load(readFileSync(`${process.env.HOME}/.openclaw/workspace/config/sources.yaml`, "utf8"));
const source = sources.sources.find(s => s.id === sourceId);
if (!source) { console.error(`source ${sourceId} not found`); process.exit(1); }

const manifestPath = `${process.env.HOME}/openclaw-drafts/whitelist/audio-cache/${sourceId}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ep = manifest.episodes.find(e => e.episode_id === transcript.episode_id);
if (!ep?.video_path) { console.error(`video not cached for ${transcript.episode_id}`); process.exit(1); }

const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});
const ffmpeg = createFfmpegRunner();

const ce = createClipExtract({
  router,
  runFfmpeg: ffmpeg,
  writeDraft: (id, d) => {
    const dir = `${process.env.HOME}/openclaw-drafts/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeFileSync,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot: `${process.env.HOME}/openclaw-drafts`,
  idGenerator: () => `${new Date().toISOString().slice(0,10)}-clip-${Math.random().toString(36).slice(2,6)}`,
});

const { dir } = await ce.run({ transcript, source, videoPath: ep.video_path });
console.log(dir);
```

`chmod +x workspace-mirror/skills/clip-extract/bin/extract.js`

- [ ] **Step 9.9: Run tests — expect pass**

```bash
cd /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/clip-extract
npm test
```

- [ ] **Step 9.10: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/clip-extract/
git commit -m "feat(clip-extract): LLM viral-moment detection + ffmpeg vertical cut with burned captions"
```

---

## Task 10: Poller integration — provider-router wiring + `s:` callbacks + `/sources` commands

**Files:**
- Modify: `workspace-mirror/skills/poller/bin/poll.js` (wire provider-router, add `s:` dispatch, add `/sources` commands)
- Modify: `workspace-mirror/skills/poller/index.js` (extend dispatch)
- Create: `workspace-mirror/skills/poller/tests/source-callback.test.js`

- [ ] **Step 10.1: Read existing poller structure**

```bash
cat workspace-mirror/skills/poller/index.js
cat workspace-mirror/skills/poller/bin/poll.js
```

Familiarize with existing patterns (callback dispatch, slash command dispatch).

- [ ] **Step 10.2: Write failing test for `s:approve` callback**

Create `workspace-mirror/skills/poller/tests/source-callback.test.js`:

```js
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
    await h.handle({ data: "s:approve:cand-001", messageId: 42, chatId: 123 });
    expect(deps.sourcesStore.append).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String), url: "https://www.youtube.com/@lexfridman", license: "permission-granted",
    }));
    expect(deps.editMessage).toHaveBeenCalled();
  });

  it("s:reject logs to rejected-sources.jsonl (does NOT touch sources.yaml)", async () => {
    const deps = makeDeps();
    const h = createSourceCallbackHandler(deps);
    await h.handle({ data: "s:reject:cand-001", messageId: 42, chatId: 123 });
    expect(deps.sourcesStore.append).not.toHaveBeenCalled();
    expect(deps.appendRejectedLog).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: "cand-001" }));
  });
});
```

- [ ] **Step 10.3: Run test — verify failure**

```bash
cd workspace-mirror/skills/poller && npm test -- tests/source-callback.test.js
```

Expected: FAIL (source-callback.js not found).

- [ ] **Step 10.4: Create `source-callback.js`**

```js
export function createSourceCallbackHandler(deps) {
  const { sourcesStore, readPendingSource, appendRejectedLog, editMessage, movePendingToArchive } = deps;

  async function handle({ data, messageId, chatId }) {
    const [_prefix, action, candidateId] = data.split(":");
    const pending = readPendingSource(candidateId);
    if (!pending) return { ok: false, reason: "not found" };
    const c = pending.candidate;

    if (action === "approve") {
      // Derive a stable sources.yaml id from the channel handle or id
      const id = (c.channel_handle || c.channel_id || c.candidate_id).replace(/^@/, "").toLowerCase();
      sourcesStore.append({
        id,
        creator: c.creator,
        type: "youtube_channel",
        url: c.url,
        license: c.license_type,
        license_evidence: c.license_evidence_url,
        attribution_required: true,
        attribution_template: c.attribution_template,
        poll_frequency_h: 24,
        niches: [c.niche],
        lastScanned: null,
      });
      if (movePendingToArchive) movePendingToArchive(candidateId, "approved");
      await editMessage({ chatId, messageId, text: `✅ Approved: ${c.creator} added to sources.yaml` });
      return { ok: true, action: "approved", id };
    }
    if (action === "reject") {
      appendRejectedLog({ candidate_id: candidateId, creator: c.creator, url: c.url, rejected_at: new Date().toISOString() });
      if (movePendingToArchive) movePendingToArchive(candidateId, "rejected");
      await editMessage({ chatId, messageId, text: `❌ Rejected: ${c.creator}` });
      return { ok: true, action: "rejected" };
    }
    return { ok: false, reason: `unknown action ${action}` };
  }

  return { handle };
}
```

- [ ] **Step 10.5: Run test — expect pass**

```bash
cd workspace-mirror/skills/poller && npm test -- tests/source-callback.test.js
```

- [ ] **Step 10.6: Wire `s:` dispatch + provider-router into `bin/poll.js`**

Edit `workspace-mirror/skills/poller/bin/poll.js` — locate the callback dispatcher and add the `s:` branch before the existing `a:` / `m:` / `r:` branches. Also inject a real provider-router instead of `null`.

Add near imports:

```js
import { createRouter } from "../../provider-router/router.js";
import ollama from "../../provider-router/providers/ollama.js";
import anthropic from "../../provider-router/providers/anthropic.js";
import { createSourcesStore } from "../../shared/sources-store.js";
import { createSourceCallbackHandler } from "../source-callback.js";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
```

Replace the `router = null` line with:

```js
const router = createRouter({
  configPath: `${process.env.HOME}/.openclaw/workspace/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${process.env.HOME}/openclaw-drafts/logs/router.jsonl`,
});
```

Instantiate source-callback:

```js
const sourcesStore = createSourcesStore({ path: `${process.env.HOME}/.openclaw/workspace/config/sources.yaml` });

const sourceCb = createSourceCallbackHandler({
  sourcesStore,
  readPendingSource: (id) => {
    const path = `${process.env.HOME}/openclaw-drafts/pending-source/${id}/state.json`;
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  },
  appendRejectedLog: (entry) => {
    const path = `${process.env.HOME}/openclaw-drafts/logs/rejected-sources.jsonl`;
    mkdirSync(`${process.env.HOME}/openclaw-drafts/logs`, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  },
  editMessage: async ({ chatId, messageId, text }) => tg.editMessageText({ chatId, messageId, text }),
  movePendingToArchive: (id, bucket) => {
    const src = `${process.env.HOME}/openclaw-drafts/pending-source/${id}`;
    const dest = `${process.env.HOME}/openclaw-drafts/${bucket}-source/${id}`;
    mkdirSync(dest.replace(/\/[^/]+$/, ""), { recursive: true });
    if (existsSync(src)) renameSync(src, dest);
  },
});
```

Add the `s:` branch to callback dispatch (inside the `callback_query` handler):

```js
if (callbackData.startsWith("s:")) {
  await sourceCb.handle({ data: callbackData, messageId: cbq.message.message_id, chatId: cbq.message.chat.id });
  await tg.answerCallbackQuery({ id: cbq.id });
  continue;
}
```

Add `/sources` slash commands (after existing slash-command handlers):

```js
if (text.startsWith("/sources")) {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 1) {
    const list = sourcesStore.list();
    const msg = list.length === 0 ? "No sources configured." :
      list.map(s => `• ${s.id} — ${s.creator} (${s.license})`).join("\n");
    await tg.sendMessage({ text: msg });
    continue;
  }
  if (parts[1] === "propose" && parts[2]) {
    await tg.sendMessage({ text: `Evaluating ${parts[2]}...` });
    // Delegate to source-discovery CLI
    const { spawn } = await import("node:child_process");
    spawn("node", [`${process.env.HOME}/.openclaw/workspace/skills/source-discovery/bin/discover.js`, `--url=${parts[2]}`],
      { detached: true, stdio: "ignore" }).unref();
    continue;
  }
  if (parts[1] === "remove" && parts[2]) {
    try {
      sourcesStore.remove(parts[2]);
      await tg.sendMessage({ text: `Removed: ${parts[2]}` });
    } catch (e) {
      await tg.sendMessage({ text: `Remove failed: ${e.message}` });
    }
    continue;
  }
}
```

- [ ] **Step 10.7: Run all poller tests**

```bash
cd workspace-mirror/skills/poller && npm test
```

Expected: all existing + new tests pass.

- [ ] **Step 10.8: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/skills/poller/
git commit -m "feat(poller): wire provider-router + s: callback dispatch + /sources commands"
```

---

## Task 11: `bin/smoke-run.js` — end-to-end dry-run

**Files:**
- Create: `workspace-mirror/bin/smoke-run.js`

- [ ] **Step 11.1: Create the dry-run script**

```js
#!/usr/bin/env node
/**
 * bin/smoke-run.js — runs the M2 pipeline once end-to-end.
 *
 * Modes:
 *   (default)   —cached fixture path. Skips scan+transcribe. Produces 3 drafts + sends to Telegram.
 *   --live      —run scan+transcribe (SLOW: ~60 min first time for Whisper).
 *   --sandbox   —writes drafts to /tmp/openclaw-smoke/ and does NOT send to Telegram.
 *
 * Every smoke draft_id is prefixed `smoke-` so bulk cleanup is trivial:
 *   rm -rf ~/openclaw-drafts/pending/smoke-*
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const HOME = process.env.HOME;
const WS = `${HOME}/.openclaw/workspace`;
const DRAFTS = `${HOME}/openclaw-drafts`;
const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const SANDBOX = args.includes("--sandbox");
const draftsRoot = SANDBOX ? "/tmp/openclaw-smoke" : DRAFTS;
mkdirSync(`${draftsRoot}/pending`, { recursive: true });

// Dynamic imports so workspace-mirror → workspace rsync works.
const { createRouter } = await import(`${WS}/skills/provider-router/router.js`);
const ollama = (await import(`${WS}/skills/provider-router/providers/ollama.js`)).default;
const anthropic = (await import(`${WS}/skills/provider-router/providers/anthropic.js`)).default;
const { createResearch } = await import(`${WS}/skills/research/index.js`);
const { createSlideshowDraft } = await import(`${WS}/skills/slideshow-draft/index.js`);
const { createQuotecardDraft, createRenderCard } = await import(`${WS}/skills/quotecard-draft/index.js`);
const { createClipExtract } = await import(`${WS}/skills/clip-extract/index.js`);
const { createFfmpegRunner } = await import(`${WS}/skills/clip-extract/ffmpeg.js`);
const { createPexelsClient } = await import(`${WS}/skills/slideshow-draft/pexels.js`);
const { createSourcesStore } = await import(`${WS}/skills/shared/sources-store.js`);
const approval = SANDBOX ? null : await import(`${WS}/skills/approval/index.js`);

const router = createRouter({
  configPath: `${WS}/config/providers.yaml`,
  adapters: { ollama, anthropic },
  logPath: `${DRAFTS}/logs/router.jsonl`,
});

// ——— 1. Research ———
const research = createResearch({
  readFileSync,
  nichesPath: `${WS}/config/niches.yaml`,
  browserSearch: async () => [],  // keep smoke-run self-contained; RSS-only
  router,
});
const topics = await research.run("ai");
console.log(`[smoke] research → ${topics.length} topics`);
const topic = topics[0]?.topic || "AI agents replacing junior devs";
console.log(`[smoke] picked topic: ${topic}`);

// ——— 2. clip-extract (from pre-cached transcript+video) ———
const sourcesStore = createSourcesStore({ path: `${WS}/config/sources.yaml` });
const lex = sourcesStore.get("lex-fridman");
if (!lex && !LIVE) {
  console.error("[smoke] no lex-fridman in sources.yaml — run Phase 1 seeding");
  process.exit(1);
}

const manifestPath = `${DRAFTS}/whitelist/audio-cache/lex-fridman/manifest.json`;
if (!existsSync(manifestPath)) {
  console.error(`[smoke] no fixture manifest at ${manifestPath} — pre-cache at least one Lex episode`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const fixtureEp = manifest.episodes[0];
if (!fixtureEp?.video_path) { console.error("[smoke] fixture episode has no video_path"); process.exit(1); }

const transcriptPath = `${DRAFTS}/whitelist/transcript-cache/lex-fridman/${fixtureEp.episode_id}.json`;
if (!existsSync(transcriptPath)) { console.error(`[smoke] no transcript at ${transcriptPath}`); process.exit(1); }
const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));

const ffmpeg = createFfmpegRunner();
const clipExtract = createClipExtract({
  router,
  runFfmpeg: ffmpeg,
  writeDraft: (id, d) => {
    const dir = `${draftsRoot}/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeFileSync,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot,
  idGenerator: () => `smoke-${new Date().toISOString().slice(0,10)}-clip-${Math.random().toString(36).slice(2,6)}`,
});
const { draft: d1 } = await clipExtract.run({ transcript, source: lex, videoPath: fixtureEp.video_path });
console.log(`[smoke] clip draft: ${d1.id}`);

// ——— 3. slideshow ———
const pexels = createPexelsClient({ apiKey: process.env.PEXELS_API_KEY });
const ss = createSlideshowDraft({
  router,
  pexelsSearch: pexels.searchOne,
  writeDraft: (id, d) => {
    const dir = `${draftsRoot}/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  writeMedia: (p, c) => writeFileSync(p, c),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot,
  idGenerator: () => `smoke-${new Date().toISOString().slice(0,10)}-slideshow-${Math.random().toString(36).slice(2,6)}`,
});
const { draft: d2 } = await ss.run({ topic, niche: "ai" });
console.log(`[smoke] slideshow draft: ${d2.id}`);

// ——— 4. quotecard ———
const renderCard = createRenderCard({
  pythonBin: `${WS}/.venv/bin/python3`,
  scriptPath: `${WS}/skills/quotecard-draft/render.py`,
});
const qc = createQuotecardDraft({
  router, renderCard,
  writeDraft: (id, d) => {
    const dir = `${draftsRoot}/pending/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/draft.json`, JSON.stringify(d, null, 2));
  },
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  draftsRoot,
  idGenerator: () => `smoke-${new Date().toISOString().slice(0,10)}-quotecard-${Math.random().toString(36).slice(2,6)}`,
});
const { draft: d3 } = await qc.run({ topic, niche: "ai" });
console.log(`[smoke] quotecard draft: ${d3.id}`);

// ——— 5. Send for approval (skipped in sandbox) ———
if (SANDBOX) {
  console.log("[smoke] sandbox mode: skipping Telegram send");
  process.exit(0);
}
const { sendForApproval } = approval;
for (const draft of [d1, d2, d3]) {
  try {
    await sendForApproval({ draftId: draft.id });
    console.log(`[smoke] sent ${draft.id}`);
  } catch (e) {
    console.error(`[smoke] send failed for ${draft.id}: ${e.message}`);
  }
}
console.log("[smoke] done");
```

`chmod +x workspace-mirror/bin/smoke-run.js`

- [ ] **Step 11.2: Commit**

```bash
cd /Users/vividadmin/Desktop/openclaw
git add workspace-mirror/bin/smoke-run.js
git commit -m "feat(smoke): add bin/smoke-run.js end-to-end dry-run with --sandbox/--live flags"
```

---

## Task 12: End-to-end smoke validation

**Files:** none (verification only)

This task is primary-agent-driven. It executes the full smoke pipeline against the real workspace and validates the M2 exit criteria.

- [ ] **Step 12.1: Rsync workspace-mirror → live workspace**

```bash
rsync -a --delete --exclude='node_modules' --exclude='package-lock.json' \
  /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/shared/ \
  ~/.openclaw/workspace/skills/shared/

for skill in research whitelist-scan transcribe slideshow-draft quotecard-draft source-discovery clip-extract poller; do
  rsync -a --delete --exclude='node_modules' \
    /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/$skill/ \
    ~/.openclaw/workspace/skills/$skill/
done
rsync -a /Users/vividadmin/Desktop/openclaw/workspace-mirror/bin/ ~/.openclaw/workspace/bin/

# npm install each skill
for skill in shared research whitelist-scan transcribe slideshow-draft quotecard-draft source-discovery clip-extract; do
  (cd ~/.openclaw/workspace/skills/$skill && npm install --silent)
done
```

- [ ] **Step 12.2: Pre-cache a fixture Lex Fridman episode (one-time, slow)**

Ask the user to manually pick an interesting episode URL, then:

```bash
# Pick a short-ish episode if possible (< 2h) to keep transcription under an hour.
EP_URL="https://www.youtube.com/watch?v=YOUR_CHOSEN_ID"

# Download both audio and video
mkdir -p ~/openclaw-drafts/whitelist/audio-cache/lex-fridman
mkdir -p ~/openclaw-drafts/whitelist/video-cache/lex-fridman
yt-dlp -f m4a -o "~/openclaw-drafts/whitelist/audio-cache/lex-fridman/%(id)s.m4a" "$EP_URL"
yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 \
  -o "~/openclaw-drafts/whitelist/video-cache/lex-fridman/%(id)s.mp4" "$EP_URL"

# Build manifest.json
# (write by hand or use a small script that reads audio/video paths)

# Transcribe (blocks ~60 min)
node ~/.openclaw/workspace/skills/transcribe/bin/transcribe.js \
  ~/openclaw-drafts/whitelist/audio-cache/lex-fridman/EP_ID.m4a \
  lex-fridman EP_ID "Episode Title" EP_DURATION_S
```

- [ ] **Step 12.3: Run smoke-run in sandbox mode**

```bash
cd ~/.openclaw/workspace
node bin/smoke-run.js --sandbox
```

Expected output (roughly):
```
[smoke] research → 5 topics
[smoke] picked topic: <some AI topic>
[smoke] clip draft: smoke-2026-04-16-clip-xxxx
[smoke] slideshow draft: smoke-2026-04-16-slideshow-xxxx
[smoke] quotecard draft: smoke-2026-04-16-quotecard-xxxx
[smoke] sandbox mode: skipping Telegram send
```

Verify:
```bash
ls /tmp/openclaw-smoke/pending/
# Should show 3 directories, each with draft.json and media/
cat /tmp/openclaw-smoke/pending/smoke-*-clip-*/draft.json | head -50
file /tmp/openclaw-smoke/pending/smoke-*-quotecard-*/media/card.png
# Should say "PNG image data, 1080 x 1080"
```

- [ ] **Step 12.4: Run smoke-run for real (Telegram)**

Make sure the poller daemon is running (M1):
```bash
ps aux | grep -v grep | grep "bin/poll.js"  # should show it running
```

Then:
```bash
cd ~/.openclaw/workspace
node bin/smoke-run.js
```

Expected: 3 Telegram DMs arrive within ~3 min, each with Approve/Modify/Reject buttons.

**Acceptance verification:**
- [ ] Tap [✅ Approve] on one draft → bot replies with Template B (polished copy-paste)
- [ ] Tap [✏️ Modify] on another → bot asks for changes → reply with text → regeneration works
- [ ] Tap [❌ Reject] on the third → bot asks for reason → reply or /skip → archived

- [ ] **Step 12.5: Source-discovery push smoke test**

```bash
cd ~/.openclaw/workspace
node skills/source-discovery/bin/discover.js --url=https://www.youtube.com/@allin --niche=finance
```

Expected: Telegram DM with a candidate card for All-In Podcast. Tap Approve → verify `~/.openclaw/workspace/config/sources.yaml` gains a new entry.

- [ ] **Step 12.6: Clean up sandbox artifacts**

```bash
rm -rf /tmp/openclaw-smoke
rm -rf ~/openclaw-drafts/pending/smoke-*
```

- [ ] **Step 12.7: Close the beads issue + final commit**

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bd close openclaw-ohk --reason="M2 complete: 7 skills shipped, 2 shared modules, dry-run + real e2e smoke tests passing"
```

If any drift between workspace-mirror and live workspace, sync back:
```bash
rsync -a --delete --exclude='node_modules' --exclude='package-lock.json' \
  ~/.openclaw/workspace/skills/ \
  /Users/vividadmin/Desktop/openclaw/workspace-mirror/skills/
```

Final commit + push:
```bash
cd /Users/vividadmin/Desktop/openclaw
git add -A workspace-mirror/ docs/
git status  # review
git commit -m "chore(m2): final workspace-mirror sync after e2e validation"
git push
```

---

## Exit Criteria (M2 complete when all true)

- [ ] All 8 skill test suites pass (shared, research, whitelist-scan, transcribe, slideshow-draft, quotecard-draft, source-discovery, clip-extract) — plus poller and existing M1 suites (approval, archive, provider-router)
- [ ] `bin/smoke-run.js --sandbox` produces 3 valid drafts in `/tmp/openclaw-smoke/pending/` with the expected files (draft.json, media/)
- [ ] `bin/smoke-run.js` (live) delivers 3 Telegram DMs, all three buttons work per M1 flow, modify flow produces a regenerated draft
- [ ] `source-discovery --url=<real channel>` → Telegram DM → approve → `sources.yaml` grows; reject → `rejected-sources.jsonl` grows; sources.yaml untouched
- [ ] Feature branch `feat/plan-c-content-generation` pushed to origin; PR opened against `main`

---

## Handoff to M3

M3 will be planned separately. It consumes everything M2 produced:

- Orchestrator skill at `skills/orchestrator/` that chains research → mode-selection → draft-skill → approval
- Report skill at `skills/report/`
- Cron wiring via `config/cron.yaml` (already defined in parent spec §7.2)
- Topic↔episode matching logic (spec §9)
- "One draft per mode per day" rule (spec §3.2)
- Quiet-hours batching
- Spend-cap enforcement across scheduled jobs
