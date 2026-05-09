# Clip Pipeline Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bin/orchestrator.js --job=daily-loop` produce a real clip draft end-to-end by (a) backfilling `manifest.json` for hand-placed audio/video pairs and (b) wiring the orchestrator's transcript→manifest→source lookup correctly.

**Architecture:** New one-shot CLI `backfill-manifest.js` rebuilds the manifest from on-disk files via ffprobe + yt-dlp lookups (with stale-entry pruning). `loadTranscripts` is extracted from `bin/orchestrator.js` into a testable module that joins each transcript with its manifest entry. `daily-loop.js callSkill("clip")` is rewritten to look up the source from `sources.yaml` via a `sourcesById` Map threaded through `runDailyLoop`. A `lex-fridman` entry is added to `sources.yaml` so the smoke run has a real source to attribute against.

**Tech Stack:** Node.js 18+ (ESM), vitest, js-yaml, ffprobe, yt-dlp.

**Beads:** openclaw-kn9 (P2 bug, primary), openclaw-4j6 (P3 task, dependency).

**Spec:** `docs/superpowers/specs/2026-04-28-clip-pipeline-wiring-design.md`.

---

## Task 1: Branch setup

**Files:** none (git operations only).

- [ ] **Step 1: Verify clean working tree**

Run: `git status --short`
Expected: only the pre-existing untracked `.perles/`, `skills/`, and `package-lock.json` entries shown in initial gitStatus. No staged or modified tracked files.

- [ ] **Step 2: Determine target branch**

Run: `git branch --show-current && git log --oneline -3`
Expected: current branch is `fix/transcribe-m4a-wav-conversion`; HEAD is `5d5003e docs: address review feedback on clip pipeline spec`.

The two spec commits (21013f6, 5d5003e) are clip-pipeline-related and don't belong on the transcribe branch. Move them onto a new branch off `main`:

- [ ] **Step 3: Create new branch from main and cherry-pick spec commits**

```bash
git fetch origin main
git checkout -b feat/clip-pipeline-wiring origin/main
git cherry-pick 21013f6 5d5003e
```

Expected: `feat/clip-pipeline-wiring` exists with two commits on top of `origin/main`. Verify with `git log --oneline origin/main..HEAD`.

- [ ] **Step 4: Reset transcribe branch back to its last clip-unrelated commit**

```bash
git update-ref refs/heads/fix/transcribe-m4a-wav-conversion 68603b6
```

Expected: `git log fix/transcribe-m4a-wav-conversion --oneline -3` shows `68603b6` as HEAD with no spec commits. (We don't delete the branch — per memory, never delete branches.)

**Note:** `origin/fix/transcribe-m4a-wav-conversion` already ends at `68603b6` — the spec/plan commits never reached the remote. After this `update-ref`, `git status` on the transcribe branch will report "up to date with origin/fix/transcribe-m4a-wav-conversion" — no force-push needed.

- [ ] **Step 5: Claim beads issues**

```bash
bd update openclaw-kn9 --claim
bd update openclaw-4j6 --claim
```

Expected: both issues show as in_progress and assigned to the current user.

---

## Task 2: Failing tests for backfill-manifest

**Files:**
- Create: `workspace-mirror/skills/whitelist-scan/tests/backfill-manifest.test.js`

- [ ] **Step 1: Write the test file**

```js
import { describe, it, expect, vi } from "vitest";
import { createBackfillManifest } from "../backfill-manifest.js";

function makeDeps(overrides = {}) {
  return {
    listAudio: vi.fn(() => ["epA.m4a", "epB.m4a", "audio-only.m4a"]),
    listVideo: vi.fn(() => ["epA.mp4", "epB.mp4", "video-only.mp4"]),
    fileExists: vi.fn(() => true),
    readManifest: vi.fn(() => null),
    writeManifest: vi.fn(),
    probeDurationS: vi.fn(async () => 3600),
    fetchVideoMeta: vi.fn(async (id) => ({ title: `Title ${id}`, publishedAt: "2026-01-15T00:00:00Z" })),
    sourceId: "lex-fridman",
    audioDir: "/cache/audio-cache/lex-fridman",
    videoDir: "/cache/video-cache/lex-fridman",
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("backfill-manifest", () => {
  it("includes only episodes with both audio and video files", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id).sort();
    expect(ids).toEqual(["epA", "epB"]);
    expect(deps.fetchVideoMeta).toHaveBeenCalledTimes(2);
  });

  it("each entry has the canonical manifest schema fields", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ep = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(ep).toEqual({
      episode_id: "epA",
      title: "Title epA",
      duration_s: 3600,
      published_at: "2026-01-15T00:00:00Z",
      audio_path: "/cache/audio-cache/lex-fridman/epA.m4a",
      video_path: "/cache/video-cache/lex-fridman/epA.mp4",
      video_pruned_at: null,
    });
  });

  it("falls back to episode_id and null published_at when fetchVideoMeta fails", async () => {
    const deps = makeDeps({
      fetchVideoMeta: vi.fn(async () => { throw new Error("network down"); }),
    });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ep = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(ep.title).toBe("epA");
    expect(ep.published_at).toBeNull();
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("skips episode entirely when probeDurationS fails", async () => {
    const probe = vi.fn(async (path) => {
      if (path.includes("epA")) throw new Error("ffprobe failed");
      return 3600;
    });
    const deps = makeDeps({ probeDurationS: probe });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id);
    expect(ids).not.toContain("epA");
    expect(ids).toContain("epB");
  });

  it("merges with existing manifest, preserving entries whose video_path still resolves", async () => {
    const existing = {
      episodes: [
        {
          episode_id: "epA",
          title: "Pre-existing Title",
          duration_s: 1234,
          published_at: "2025-12-01T00:00:00Z",
          audio_path: "/cache/audio-cache/lex-fridman/epA.m4a",
          video_path: "/cache/video-cache/lex-fridman/epA.mp4",
          video_pruned_at: null,
        },
      ],
    };
    const deps = makeDeps({ readManifest: vi.fn(() => existing) });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const epA = result.manifest.episodes.find(e => e.episode_id === "epA");
    expect(epA.title).toBe("Pre-existing Title");
    expect(deps.fetchVideoMeta).toHaveBeenCalledTimes(1);
    expect(deps.fetchVideoMeta).toHaveBeenCalledWith("epB");
  });

  it("drops existing entries whose video_path no longer exists on disk", async () => {
    const existing = {
      episodes: [
        {
          episode_id: "ghost",
          title: "Deleted Episode",
          duration_s: 1234,
          published_at: "2025-12-01T00:00:00Z",
          audio_path: "/cache/audio-cache/lex-fridman/ghost.m4a",
          video_path: "/cache/video-cache/lex-fridman/ghost.mp4",
          video_pruned_at: null,
        },
      ],
    };
    const fileExists = vi.fn((p) => !p.includes("ghost"));
    const deps = makeDeps({ readManifest: vi.fn(() => existing), fileExists });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    const ids = result.manifest.episodes.map(e => e.episode_id);
    expect(ids).not.toContain("ghost");
  });

  it("sorts entries by published_at desc with episode_id fallback for nulls", async () => {
    const deps = makeDeps({
      listAudio: vi.fn(() => ["a.m4a", "b.m4a", "c.m4a"]),
      listVideo: vi.fn(() => ["a.mp4", "b.mp4", "c.mp4"]),
      fetchVideoMeta: vi.fn(async (id) => {
        const map = {
          a: { title: "A", publishedAt: "2026-01-01T00:00:00Z" },
          b: { title: "B", publishedAt: "2026-03-01T00:00:00Z" },
          c: { title: "C", publishedAt: null },
        };
        return map[id];
      }),
    });
    const bf = createBackfillManifest(deps);
    const result = await bf.run();
    expect(result.manifest.episodes.map(e => e.episode_id)).toEqual(["b", "a", "c"]);
  });

  it("writes via writeManifest with the merged manifest", async () => {
    const deps = makeDeps();
    const bf = createBackfillManifest(deps);
    await bf.run();
    expect(deps.writeManifest).toHaveBeenCalledTimes(1);
    const written = deps.writeManifest.mock.calls[0][0];
    expect(written.episodes).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd workspace-mirror/skills/whitelist-scan && npx vitest run tests/backfill-manifest.test.js`
Expected: all 8 tests fail with `Cannot find module '../backfill-manifest.js'`.

---

## Task 3: Implement createBackfillManifest

**Files:**
- Create: `workspace-mirror/skills/whitelist-scan/backfill-manifest.js`

- [ ] **Step 1: Write the implementation**

```js
import { join, basename, extname } from "node:path";

export function createBackfillManifest(deps) {
  const {
    listAudio, listVideo, fileExists,
    readManifest, writeManifest,
    probeDurationS, fetchVideoMeta,
    sourceId, audioDir, videoDir,
    log,
  } = deps;

  function basenamesOf(files, ext) {
    return new Set(
      files
        .filter(f => extname(f).toLowerCase() === ext.toLowerCase())
        .map(f => basename(f, ext))
    );
  }

  async function buildEntry(episodeId) {
    const videoPath = join(videoDir, `${episodeId}.mp4`);
    const audioPath = join(audioDir, `${episodeId}.m4a`);
    let duration_s;
    try {
      duration_s = await probeDurationS(videoPath);
    } catch (err) {
      log.warn(`ffprobe failed for ${episodeId}: ${err.message}; skipping`);
      return null;
    }
    let title = episodeId;
    let published_at = null;
    try {
      const meta = await fetchVideoMeta(episodeId);
      if (meta?.title) title = meta.title;
      if (meta?.publishedAt) published_at = meta.publishedAt;
    } catch (err) {
      log.warn(`fetchVideoMeta failed for ${episodeId}: ${err.message}; using fallbacks`);
    }
    return {
      episode_id: episodeId,
      title,
      duration_s,
      published_at,
      audio_path: audioPath,
      video_path: videoPath,
      video_pruned_at: null,
    };
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      if (a.published_at && b.published_at) {
        if (a.published_at > b.published_at) return -1;
        if (a.published_at < b.published_at) return 1;
        return 0;
      }
      if (a.published_at && !b.published_at) return -1;
      if (!a.published_at && b.published_at) return 1;
      return a.episode_id < b.episode_id ? -1 : a.episode_id > b.episode_id ? 1 : 0;
    });
  }

  async function run() {
    const audioIds = basenamesOf(listAudio(), ".m4a");
    const videoIds = basenamesOf(listVideo(), ".mp4");
    const intersection = [...audioIds].filter(id => videoIds.has(id));

    const existing = readManifest() || { episodes: [] };
    const existingById = new Map();
    for (const ep of existing.episodes || []) {
      if (fileExists(ep.video_path)) {
        existingById.set(ep.episode_id, ep);
      } else {
        log.warn(`pruning stale manifest entry: ${ep.episode_id} (video file missing)`);
      }
    }

    const result = [];
    for (const id of intersection) {
      if (existingById.has(id)) {
        result.push(existingById.get(id));
        continue;
      }
      const entry = await buildEntry(id);
      if (entry) result.push(entry);
    }

    const manifest = { episodes: sortEntries(result) };
    writeManifest(manifest);
    return { manifest };
  }

  return { run };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd workspace-mirror/skills/whitelist-scan && npx vitest run tests/backfill-manifest.test.js`
Expected: all 8 tests pass.

---

## Task 4: Implement the CLI wrapper

**Files:**
- Create: `workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js`

- [ ] **Step 1: Write the CLI**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBackfillManifest } from "../backfill-manifest.js";

const run = promisify(execFile);
const sourceId = process.argv[2];
if (!sourceId) {
  console.error("Usage: backfill-manifest.js <source-id>");
  process.exit(2);
}

const HOME = process.env.HOME;
const audioDir = `${HOME}/openclaw-drafts/whitelist/audio-cache/${sourceId}`;
const videoDir = `${HOME}/openclaw-drafts/whitelist/video-cache/${sourceId}`;
const manifestPath = join(audioDir, "manifest.json");

if (!existsSync(audioDir)) {
  console.error(`audio cache directory not found: ${audioDir}`);
  process.exit(1);
}
if (!existsSync(videoDir)) {
  console.error(`video cache directory not found: ${videoDir}`);
  process.exit(1);
}

async function probeDurationS(videoPath) {
  try {
    const { stdout } = await run("ffprobe", [
      "-i", videoPath,
      "-show_entries", "format=duration",
      "-v", "quiet",
      "-of", "csv=p=0",
    ]);
    const v = parseFloat(stdout.trim());
    if (!Number.isFinite(v)) throw new Error(`unparseable duration: ${stdout}`);
    return v;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("ffprobe not found. Install via: brew install ffmpeg");
      process.exit(1);
    }
    throw err;
  }
}

async function fetchVideoMeta(episodeId) {
  try {
    const { stdout } = await run("yt-dlp", [
      "--skip-download",
      "--print", "%(title)s|||%(upload_date)s",
      `https://youtu.be/${episodeId}`,
    ]);
    const [title, uploadDate] = stdout.trim().split("|||");
    let publishedAt = null;
    if (uploadDate && /^\d{8}$/.test(uploadDate)) {
      publishedAt = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`;
    }
    return { title, publishedAt };
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("yt-dlp not found. Install via: brew install yt-dlp");
      process.exit(1);
    }
    throw err;
  }
}

const bf = createBackfillManifest({
  listAudio: () => readdirSync(audioDir),
  listVideo: () => readdirSync(videoDir),
  fileExists: (p) => existsSync(p),
  readManifest: () => existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
  writeManifest: (m) => {
    const tmp = manifestPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, manifestPath);
  },
  probeDurationS,
  fetchVideoMeta,
  sourceId,
  audioDir,
  videoDir,
  log: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
});

const { manifest } = await bf.run();
console.log(JSON.stringify({ source: sourceId, episodes: manifest.episodes.length, manifest_path: manifestPath }));
```

- [ ] **Step 2: Verify CLI parses correctly with --help-style invocation**

Run: `node workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js`
Expected: prints `Usage: backfill-manifest.js <source-id>` on stderr and exits with code 2.

- [ ] **Step 3: Commit Task 2-4 work**

```bash
git add workspace-mirror/skills/whitelist-scan/backfill-manifest.js \
        workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js \
        workspace-mirror/skills/whitelist-scan/tests/backfill-manifest.test.js
git commit -m "feat(whitelist-scan): backfill-manifest CLI for hand-placed cache files

Closes openclaw-4j6.

Walks audio-cache/<id>/ ∩ video-cache/<id>/, calls ffprobe + yt-dlp to
populate manifest.json. Idempotent merge with stale-entry pruning.
Required precondition for orchestrator clip pipeline."
```

---

## Task 5: Failing tests for loadTranscripts join

**Files:**
- Create: `workspace-mirror/skills/orchestrator/load-transcripts.test.js`

- [ ] **Step 1: Write the test file**

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTranscripts } from "./load-transcripts.js";

let drafts;
let log;
beforeEach(() => {
  drafts = mkdtempSync(join(tmpdir(), "lt-"));
  mkdirSync(join(drafts, "whitelist/transcript-cache/lex-fridman"), { recursive: true });
  mkdirSync(join(drafts, "whitelist/audio-cache/lex-fridman"), { recursive: true });
  log = { warn: vi.fn() };
});
afterEach(() => rmSync(drafts, { recursive: true, force: true }));

function writeTranscript(sourceDir, id, extra = {}) {
  const t = {
    source_id: "lex-fridman",
    episode_id: id,
    title: `Title ${id}`,
    language: "en",
    duration_s: 1800,
    transcribed_at: "2026-04-20T12:00:00Z",
    model: "whisper-large-v3",
    segments: [{ t_start: 0, t_end: 1, text: "hello" }],
    ...extra,
  };
  writeFileSync(
    join(drafts, "whitelist/transcript-cache", sourceDir, `${id}.json`),
    JSON.stringify(t),
  );
}
function writeManifest(sourceDir, episodes) {
  writeFileSync(
    join(drafts, "whitelist/audio-cache", sourceDir, "manifest.json"),
    JSON.stringify({ episodes }),
  );
}

describe("loadTranscripts", () => {
  it("returns empty array when transcript-cache root does not exist", () => {
    rmSync(join(drafts, "whitelist/transcript-cache"), { recursive: true });
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toEqual([]);
  });

  it("merges video_path from manifest into each transcript", () => {
    writeTranscript("lex-fridman", "ep1");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "Lex Title 1", duration_s: 1800, published_at: "2026-04-19T00:00:00Z",
        audio_path: "/cache/audio/ep1.m4a", video_path: "/cache/video/ep1.mp4", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toHaveLength(1);
    expect(result[0].episode_id).toBe("ep1");
    expect(result[0].video_path).toBe("/cache/video/ep1.mp4");
    expect(result[0].source_id).toBe("lex-fridman");
  });

  it("warns and skips transcripts whose source has no manifest.json", () => {
    writeTranscript("lex-fridman", "ep1");
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("manifest.json missing for source lex-fridman"),
    );
  });

  it("warns and skips an individual transcript whose episode_id is not in the manifest", () => {
    writeTranscript("lex-fridman", "ep1");
    writeTranscript("lex-fridman", "ghost");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result.map(t => t.episode_id)).toEqual(["ep1"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("no manifest entry for ghost"),
    );
  });

  it("handles multiple sources independently — manifest miss on one does not affect the other", () => {
    mkdirSync(join(drafts, "whitelist/transcript-cache/other-channel"), { recursive: true });
    mkdirSync(join(drafts, "whitelist/audio-cache/other-channel"), { recursive: true });
    writeTranscript("lex-fridman", "epL");
    writeTranscript("other-channel", "epO", { source_id: "other-channel" });
    writeManifest("other-channel", [
      { episode_id: "epO", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v-other", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result.map(t => t.episode_id)).toEqual(["epO"]);
    expect(result[0].video_path).toBe("/v-other");
  });

  it("ignores non-json files in source directories", () => {
    writeFileSync(join(drafts, "whitelist/transcript-cache/lex-fridman/notes.txt"), "ignore me");
    writeTranscript("lex-fridman", "ep1");
    writeManifest("lex-fridman", [
      { episode_id: "ep1", title: "x", duration_s: 1, published_at: null,
        audio_path: "/a", video_path: "/v", video_pruned_at: null },
    ]);
    const result = loadTranscripts({ draftsRoot: drafts, log });
    expect(result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run load-transcripts.test.js`
Expected: 6 tests fail with `Cannot find module './load-transcripts.js'`.

---

## Task 6: Implement loadTranscripts module

**Files:**
- Create: `workspace-mirror/skills/orchestrator/load-transcripts.js`

- [ ] **Step 1: Write the implementation**

```js
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadTranscripts({ draftsRoot, log = { warn: console.warn } }) {
  const transcriptRoot = join(draftsRoot, "whitelist", "transcript-cache");
  const audioRoot = join(draftsRoot, "whitelist", "audio-cache");
  if (!existsSync(transcriptRoot)) return [];

  const out = [];
  for (const sourceDir of readdirSync(transcriptRoot, { withFileTypes: true })) {
    if (!sourceDir.isDirectory()) continue;
    const sourceId = sourceDir.name;
    const manifestPath = join(audioRoot, sourceId, "manifest.json");
    if (!existsSync(manifestPath)) {
      log.warn(`loadTranscripts: manifest.json missing for source ${sourceId}; skipping all transcripts for this source`);
      continue;
    }
    let manifestById;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifestById = new Map((manifest.episodes || []).map(e => [e.episode_id, e]));
    } catch (err) {
      log.warn(`loadTranscripts: failed to parse manifest for ${sourceId}: ${err.message}`);
      continue;
    }

    for (const f of readdirSync(join(transcriptRoot, sourceId))) {
      if (!f.endsWith(".json")) continue;
      let transcript;
      try {
        transcript = JSON.parse(readFileSync(join(transcriptRoot, sourceId, f), "utf8"));
      } catch {
        continue;
      }
      const entry = manifestById.get(transcript.episode_id);
      if (!entry) {
        log.warn(`loadTranscripts: no manifest entry for ${transcript.episode_id} in source ${sourceId}; skipping`);
        continue;
      }
      out.push({
        ...transcript,
        source_id: transcript.source_id || sourceId,
        video_path: entry.video_path,
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run load-transcripts.test.js`
Expected: all 6 tests pass.

---

## Task 7: Wire loadTranscripts into bin/orchestrator.js

**Files:**
- Modify: `workspace-mirror/skills/orchestrator/bin/orchestrator.js`

- [ ] **Step 1: Replace the inline loadTranscripts function and load sourcesById**

Locate the inline `loadTranscripts` function (currently lines 132-144). Delete it. Add the import at the top of the imports block, and add a `loadSourcesById` helper plus thread `sourcesById` through:

Replace the imports section (currently lines 1-7) with:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createLogger } from "shared/jsonl-logger";
import { createQuietQueue } from "shared/quiet-queue";
import { createSourcesStore } from "shared/sources-store";
import { loadTranscripts } from "../load-transcripts.js";
```

- [ ] **Step 2: Delete the inline loadTranscripts function**

Find and remove the entire block:

```js
function loadTranscripts() {
  const root = `${DRAFTS}/whitelist/transcript-cache`;
  if (!existsSync(root)) return [];
  const out = [];
  for (const source of readdirSync(root, { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    for (const f of readdirSync(join(root, source.name))) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(root, source.name, f), "utf8"))); } catch {}
    }
  }
  return out;
}
```

Also remove `existsSync` and `readdirSync` from the `node:fs` import — they're no longer needed in this file (the new module handles them internally).

- [ ] **Step 3: Add loadSourcesById helper**

Add this helper just after `loadSkillsAndRouter`'s closing brace:

```js
function loadSourcesById() {
  const store = createSourcesStore({ path: `${WORKSPACE}/config/sources.yaml` });
  return new Map(store.list().map(s => [s.id, s]));
}
```

- [ ] **Step 4: Update the daily-loop call site**

In `main()`, replace the existing `transcripts: loadTranscripts(),` line with both transcripts and sourcesById:

```js
      const res = await runDailyLoop({
        clock: new Date(),
        providerRouter: d.router,
        skills: d.skills,
        approval: d.approval,
        quietQueue,
        logger,
        paths: { workspace: WORKSPACE, drafts: DRAFTS },
        transcripts: loadTranscripts({ draftsRoot: DRAFTS, log: { warn: (m) => logger.jsonl({ event: "load_transcripts_warn", msg: m }) } }),
        sourcesById: loadSourcesById(),
        telegramClient: d.telegramClient,
        chatId: d.chatId,
      });
```

- [ ] **Step 5: Verify the file still parses**

Run: `node --check workspace-mirror/skills/orchestrator/bin/orchestrator.js`
Expected: no output, exit 0.

- [ ] **Step 6: Re-run loadTranscripts tests to ensure no regression**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run load-transcripts.test.js`
Expected: all 6 tests still pass.

---

## Task 8: Failing tests for daily-loop clip wiring

**Files:**
- Modify: `workspace-mirror/skills/orchestrator/daily-loop.test.js`

- [ ] **Step 1: Add three new test cases at the end of the file**

Append before the final `});` of the last `describe` block (or as a new `describe` block):

```js
describe("runDailyLoop — clip mode source/video wiring (kn9)", () => {
  function makeClipDeps(overrides = {}) {
    const transcript = {
      source_id: "lex-fridman",
      episode_id: "ep1",
      title: "Whatever this Episode is",
      language: "en",
      duration_s: 3600,
      transcribed_at: new Date().toISOString(),
      model: "whisper-large-v3",
      segments: [
        { t_start: 0, t_end: 50, text: "AI agents are eating the world" },
      ],
      video_path: "/cache/video-cache/lex-fridman/ep1.mp4",
    };
    const source = {
      id: "lex-fridman",
      creator: "Lex Fridman",
      url: "https://www.youtube.com/@lexfridman",
      attribution_template: '— {creator}, "{episode_title}"',
      niches: ["ai"],
      license: "permission-granted",
    };
    const matchingTopic = { topic: "AI agents replacing junior devs", source_url: "https://a.test/1", score: 0.9, niche: "ai" };
    return {
      ...makeDeps({
        skills: makeSkills({
          research: { run: vi.fn().mockResolvedValue([matchingTopic]) },
          clipExtract: { run: vi.fn().mockResolvedValue({ draft: { id: "d-clip-real", mode: "clip" } }) },
        }),
        providerRouter: { complete: vi.fn().mockResolvedValue({ text: JSON.stringify({ best_episode_id: "ep1", confidence: 0.9, reasoning: "match" }) }) },
        transcripts: [transcript],
        sourcesById: new Map([["lex-fridman", source]]),
      }),
      ...overrides,
    };
  }

  it("happy path: clipExtract.run receives sources.yaml entry as source and transcript.video_path as videoPath", async () => {
    const deps = makeClipDeps();
    await runDailyLoop(deps);
    expect(deps.skills.clipExtract.run).toHaveBeenCalledTimes(1);
    const call = deps.skills.clipExtract.run.mock.calls[0][0];
    expect(call.source.id).toBe("lex-fridman");
    expect(call.source.creator).toBe("Lex Fridman");
    expect(call.source.attribution_template).toBe('— {creator}, "{episode_title}"');
    expect(call.videoPath).toBe("/cache/video-cache/lex-fridman/ep1.mp4");
    expect(call.transcript.episode_id).toBe("ep1");
    expect(deps.providerRouter.complete).toHaveBeenCalled();
  });

  it("unknown source_id: clip mode is skipped with reason missing_source_or_video, no throw, no clipExtract call", async () => {
    const deps = makeClipDeps({ sourcesById: new Map() });
    const res = await runDailyLoop(deps);
    expect(deps.skills.clipExtract.run).not.toHaveBeenCalled();
    const clipResult = res.drafts.find(d => d.mode === "clip");
    expect(clipResult).toEqual({ mode: "clip", ok: false, reason: "missing_source_or_video" });
  });

  it("transcript with no video_path: clip mode is skipped, clipExtract.run never called", async () => {
    const deps = makeClipDeps();
    deps.transcripts = deps.transcripts.map(t => ({ ...t, video_path: undefined }));
    const res = await runDailyLoop(deps);
    expect(deps.skills.clipExtract.run).not.toHaveBeenCalled();
    const clipResult = res.drafts.find(d => d.mode === "clip");
    expect(clipResult).toEqual({ mode: "clip", ok: false, reason: "missing_source_or_video" });
  });
});
```

- [ ] **Step 2: Run tests to verify the three new ones fail**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run daily-loop.test.js`
Expected: the three new tests fail (the existing tests still pass). Failure modes: happy-path asserts the new `source` object — will fail because today's `daily-loop.js` passes the transcript as `source`. The two skip-cases will also fail because today's code throws or silently passes wrong args.

---

## Task 9: Wire sourcesById through runDailyLoop and rewrite callSkill

**Files:**
- Modify: `workspace-mirror/skills/orchestrator/daily-loop.js`

- [ ] **Step 1: Update callSkill signature and clip case (lines 42-55)**

Replace the existing `callSkill` function with:

```js
async function callSkill(mode, skills, topic, episode, transcripts, sourcesById) {
  switch (mode) {
    case "clip": {
      const transcript = episode ? transcripts.find(t => t.episode_id === episode.episode_id) : null;
      const source = transcript ? sourcesById.get(transcript.source_id) : null;
      if (!transcript || !source || !transcript.video_path) return null;
      return (await skills.clipExtract.run({
        transcript,
        source,
        videoPath: transcript.video_path,
      })).draft;
    }
    case "slideshow":
      return (await skills.slideshowDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    case "quotecard":
      return (await skills.quotecardDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}
```

- [ ] **Step 2: Add sourcesById to runDailyLoop params (lines 64-67)**

Replace the function signature:

```js
export async function runDailyLoop({
  clock, providerRouter, skills, approval, quietQueue, logger,
  paths, transcripts = [], sourcesById = new Map(), telegramClient, chatId,
}) {
```

- [ ] **Step 3: Update the call sites to pass sourcesById and handle null draft**

The current code (around line 113-135) loops over modes and calls `callSkill`. Replace with:

```js
  const results = [];
  for (const mode of ["clip", "slideshow", "quotecard"]) {
    if (!assignments[mode]) continue;
    const { topic, episode } = assignments[mode];
    try {
      const draft = await callSkill(mode, skills, topic, episode, transcripts, sourcesById);
      if (draft === null) {
        results.push({ mode, ok: false, reason: "missing_source_or_video" });
        continue;
      }
      results.push({ mode, draft_id: draft.id, ok: true });
    } catch (err) {
      if (isTransient(err)) {
        try {
          await new Promise(r => setTimeout(r, 2000));
          const draft = await callSkill(mode, skills, topic, episode, transcripts, sourcesById);
          if (draft === null) {
            results.push({ mode, ok: false, reason: "missing_source_or_video" });
            continue;
          }
          results.push({ mode, draft_id: draft.id, ok: true });
        } catch (retryErr) {
          results.push({ mode, ok: false, reason: retryErr.message });
          logger.errorjsonl(retryErr, { phase: "daily-loop", mode });
        }
      } else {
        results.push({ mode, ok: false, reason: err.message });
        logger.errorjsonl(err, { phase: "daily-loop", mode });
      }
    }
  }
```

- [ ] **Step 4: Run all daily-loop tests**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run daily-loop.test.js`
Expected: all tests pass — both the original ones and the three new ones from Task 8.

- [ ] **Step 5: Run all orchestrator tests**

Run: `cd workspace-mirror/skills/orchestrator && npx vitest run`
Expected: all tests pass across daily-loop, load-transcripts, topic-episode-match, source-discovery-pull, time, flush-quiet-queue.

- [ ] **Step 6: Commit Task 5-9 work**

```bash
git add workspace-mirror/skills/orchestrator/load-transcripts.js \
        workspace-mirror/skills/orchestrator/load-transcripts.test.js \
        workspace-mirror/skills/orchestrator/bin/orchestrator.js \
        workspace-mirror/skills/orchestrator/daily-loop.js \
        workspace-mirror/skills/orchestrator/daily-loop.test.js
git commit -m "fix(orchestrator): wire transcripts→manifest→sources for clip mode

Closes openclaw-kn9.

loadTranscripts now joins each transcript with its manifest entry to
attach video_path. daily-loop's callSkill('clip') looks up the
sources.yaml entry via a sourcesById Map instead of passing the
transcript as the source. Three new test cases cover the happy path
plus two skip-with-reason cases (unknown source, missing video_path)
that today's code mishandles silently."
```

---

## Task 10: Add lex-fridman entry to sources.yaml

**Files:**
- Modify: `workspace-mirror/config/sources.yaml`

- [ ] **Step 1: Replace the empty sources list**

Replace the entire file contents with:

```yaml
sources:
  - id: lex-fridman
    creator: Lex Fridman
    type: youtube_channel
    url: https://www.youtube.com/@lexfridman
    license: permission-granted
    license_evidence: https://lexfridman.com/about
    attribution_required: true
    attribution_template: '— {creator}, "{episode_title}"'
    poll_frequency_h: 24
    niches: [ai]
    lastScanned: null
```

- [ ] **Step 2: Verify YAML parses**

Run: `node -e "console.log(require('js-yaml').load(require('fs').readFileSync('workspace-mirror/config/sources.yaml','utf8')).sources.length)"`
Expected: prints `1`.

- [ ] **Step 3: Commit**

```bash
git add workspace-mirror/config/sources.yaml
git commit -m "config: add lex-fridman as initial sources.yaml entry

Required for clip mode end-to-end: the orchestrator looks up source
attribution metadata from sources.yaml. Schema mirrors what the
source-discovery approval flow writes via shared/sources-store. New
sources can be added without code changes."
```

---

## Task 11: Verification — full test suite

**Files:** none (verification only).

- [ ] **Step 1: Run every workspace test**

```bash
cd workspace-mirror/skills/whitelist-scan && npx vitest run
cd ../orchestrator && npx vitest run
cd ../shared && npx vitest run
cd ../clip-extract && npx vitest run
cd ../transcribe && npx vitest run
cd ../poller && npx vitest run
cd ../research && npx vitest run
cd ../slideshow-draft && npx vitest run
cd ../quotecard-draft && npx vitest run
cd ../source-discovery && npx vitest run
cd ../report && npx vitest run
cd ../approval && npx vitest run
```

Expected: every package shows all tests passing. Any failure here is a regression and must be fixed before proceeding.

---

## Task 12: Verification — backfill against real cache

**Files:** none (smoke run).

- [ ] **Step 1: Confirm preconditions**

```bash
ls ~/openclaw-drafts/whitelist/audio-cache/lex-fridman | wc -l
ls ~/openclaw-drafts/whitelist/video-cache/lex-fridman | wc -l
command -v ffprobe && command -v yt-dlp
```

Expected: both directories populated with `.m4a` / `.mp4` files; both binaries on PATH.

- [ ] **Step 2: Run backfill**

Run: `node workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js lex-fridman`
Expected: prints JSON like `{"source":"lex-fridman","episodes":N,"manifest_path":"..."}`. N should equal the size of the audio∩video intersection.

- [ ] **Step 3: Spot-check the manifest**

```bash
cat ~/openclaw-drafts/whitelist/audio-cache/lex-fridman/manifest.json | head -40
```

Expected: valid JSON with an `episodes` array; each entry has `episode_id`, `title`, `duration_s` (a number > 0), `published_at` (ISO date or null), `audio_path`, `video_path`, `video_pruned_at: null`.

- [ ] **Step 4: Re-run backfill to verify idempotence**

Run: `node workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js lex-fridman`
Expected: same N reported; `yt-dlp` and `ffprobe` should NOT be re-invoked for already-present entries (verified by speed of the second run vs the first).

---

## Task 13: Push branch

**Files:** none (git operations).

- [ ] **Step 1: Pull-rebase main to be safe**

```bash
git fetch origin
git rebase origin/main
```

Expected: clean rebase (no conflicts; main hasn't moved during this work).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/clip-pipeline-wiring
```

Expected: branch published; `git status` shows `up to date with origin/feat/clip-pipeline-wiring`.

- [ ] **Step 3: Push beads sync**

```bash
bd dolt push
```

Expected: beads issues sync to the Dolt remote.

---

## Task 14: Open PR

**Files:** none.

- [ ] **Step 1: Check whether `gh` CLI is available**

Run: `command -v gh`
Expected: either prints a path (gh is installed) or empty output (not installed).

- [ ] **Step 2a (gh available): Create PR via gh**

```bash
gh pr create --title "fix(clip-pipeline): wire transcripts→manifest→sources end-to-end" --body "$(cat <<'EOF'
## Summary
- Closes openclaw-kn9 (P2 bug): orchestrator's daily-loop clip mode now looks up `video_path` from the manifest and the source entry from `sources.yaml` instead of passing the transcript itself as the source.
- Closes openclaw-4j6 (P3 task): new `bin/backfill-manifest.js` rebuilds `manifest.json` from on-disk audio/video pairs (one-shot, idempotent, prunes stale entries).
- Adds an initial `lex-fridman` entry to `sources.yaml` so the smoke run has a real source to attribute against.

Spec: `docs/superpowers/specs/2026-04-28-clip-pipeline-wiring-design.md`
Plan: `docs/superpowers/plans/2026-04-28-clip-pipeline-wiring.md`

## Test plan
- [x] All workspace vitest suites pass.
- [x] `bin/backfill-manifest.js lex-fridman` produces a valid manifest from real cache and is idempotent on re-run.
- [ ] Reviewer: run `node workspace-mirror/skills/orchestrator/bin/orchestrator.js --job=daily-loop` after generating at least one transcript via `bin/transcribe.js` and confirm a clip draft appears under `~/openclaw-drafts/pending/<id>/` with non-empty `media/0.mp4` and `draft.json.source.attribution` containing "Lex Fridman".

## Out of scope
- openclaw-9im (whisper hallucination on sparse-speech audio) — separate PR.
EOF
)"
```

Expected: prints PR URL.

- [ ] **Step 2b (gh missing): Print PR-create URL for the user**

```bash
echo "Open: https://github.com/MukhammadIbrokhimov/Ai-Assistant/pull/new/feat/clip-pipeline-wiring"
```

Expected: URL printed; user clicks it and uses the title/body from Step 2a's content.

- [ ] **Step 3: Close beads issues**

```bash
bd close openclaw-kn9 openclaw-4j6
bd dolt push
```

Expected: both issues marked closed; sync succeeds.

- [ ] **Step 4: Final verification**

```bash
git status
git log --oneline origin/main..HEAD
```

Expected: working tree clean, branch is up to date with its remote, three commits on top of `origin/main` (backfill, orchestrator wiring, sources.yaml) plus the two pre-existing spec commits.

---

## Self-review checklist (executed inline, not a subagent)

- **Spec coverage:**
  - Backfill script (Component 1) → Tasks 2-4. ✓
  - `loadTranscripts` join (Component 2.1) → Tasks 5-6. ✓
  - `loadSourcesById` + threading (Component 2.2) → Task 7. ✓
  - `callSkill` rewrite + null guard (Component 2.3) → Tasks 8-9. ✓
  - `sources.yaml` lex-fridman entry (Component 3) → Task 10. ✓
  - Acceptance verification → Task 12 (backfill smoke); orchestrator smoke deferred to PR reviewer (transcript-cache empty in dev env). ✓
  - Risks: stale-entry pruning baked into Task 3; `!video_path` guard baked into Task 9; ffprobe install hint baked into Task 4. ✓

- **Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to". All test code and impl code is concrete.

- **Type consistency:**
  - `createBackfillManifest` factory — used in Tasks 2-4, signature matches.
  - `loadTranscripts({ draftsRoot, log })` — used in Tasks 5-7, signature matches.
  - `runDailyLoop({ ... sourcesById, ... })` — added Task 9, used in Tasks 7 + 8 with same name.
  - `callSkill(mode, skills, topic, episode, transcripts, sourcesById)` — added Task 9, called in updated loop with same arg order.
  - Manifest entry shape `{ episode_id, title, duration_s, published_at, audio_path, video_path, video_pruned_at }` — consistent across Tasks 2-3 (backfill), 5-6 (loadTranscripts test fixtures), 12 (verification).
