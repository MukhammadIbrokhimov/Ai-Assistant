# Clip Pipeline Wiring — Design

**Date:** 2026-04-28
**Beads issues:** openclaw-kn9 (P2 bug), openclaw-4j6 (P3 task)
**Out of scope:** openclaw-9im (whisper fixture quality) — separate PR.

## Problem

`bin/orchestrator.js --job=daily-loop` produces clip drafts that ffmpeg-fail in real runs even though tests pass. Two coupled defects:

1. **Missing manifest.** `bin/clip-extract/extract.js` and the orchestrator both expect `audio-cache/<source_id>/manifest.json` with `video_path` entries. The 14 lex-fridman audio/video pairs in `~/openclaw-drafts/whitelist/{audio,video}-cache/lex-fridman` were placed by hand outside the `whitelist-scan` flow, so no manifest exists.
2. **Wrong wiring.** `daily-loop.js:46` calls `clipExtract.run({ transcript, source: episode, videoPath: episode?.video_path })`, where `episode` is a transcript returned by `matchTopicToEpisode`. Transcripts have no `video_path` and are not `sources.yaml` entries — so `videoPath` is undefined and `source` lacks `attribution_template`/`creator`/`url`/`niches`. Tests miss this because `clipExtract.run` is mocked.

Compounding both: `config/sources.yaml` is currently `sources: []`, so even after wiring there is no `lex-fridman` entry to look up.

## Goals

- Backfill `manifest.json` for the existing on-disk lex-fridman cache.
- Wire orchestrator's `loadTranscripts()` to merge each transcript with its manifest entry (attaching `video_path` and `source_id`).
- Wire `daily-loop.js callSkill("clip")` to pass the matching `sources.yaml` entry as `source`.
- Add a working `lex-fridman` `sources.yaml` entry so the smoke run can complete.
- Stay generic — nothing lex-fridman-specific in code; new sources work by adding YAML + cached files.

## Non-goals

- Whisper hallucination / fixture-quality fixes (openclaw-9im).
- Modifying `whitelist-scan/index.js` or `bin/scan.js` to re-seed manifests from disk.
- Auto-discovery of trending sources (already a separate skill).

## Architecture

Three changes, one PR:

| File | Change | Issue |
|---|---|---|
| `workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js` | new one-shot CLI | 4j6 |
| `workspace-mirror/skills/whitelist-scan/tests/backfill-manifest.test.js` | new unit test | 4j6 |
| `workspace-mirror/skills/orchestrator/bin/orchestrator.js` | extend `loadTranscripts` to join manifest; load `sources.yaml` into a Map | kn9 |
| `workspace-mirror/skills/orchestrator/bin/orchestrator.test.js` | new test for `loadTranscripts` join | kn9 |
| `workspace-mirror/skills/orchestrator/daily-loop.js` | thread `sourcesById`; rewrite `callSkill("clip")` | kn9 |
| `workspace-mirror/skills/orchestrator/daily-loop.test.js` | extend with new clip-mode cases | kn9 |
| `workspace-mirror/config/sources.yaml` | add lex-fridman entry | kn9 |

## Component 1 — `bin/backfill-manifest.js`

**Invocation:** `node backfill-manifest.js <source-id>` (e.g. `lex-fridman`). One positional arg, no flags. Writes `~/openclaw-drafts/whitelist/audio-cache/<source-id>/manifest.json`.

**Algorithm:**

1. Read `~/openclaw-drafts/whitelist/audio-cache/<source-id>/` and `video-cache/<source-id>/`. Take the intersection of basenames — episodes with both `.m4a` and `.mp4`. Audio-only or video-only files are skipped.
2. For each `episode_id` in the intersection, build a manifest entry:
   - `episode_id`: filename minus extension.
   - `audio_path`, `video_path`: absolute paths, matching `whitelist-scan/index.js:42-43`.
   - `duration_s`: from `ffprobe -i <video> -show_entries format=duration -v quiet -of csv="p=0"`.
   - `title`: from `yt-dlp --skip-download --print "%(title)s" "https://youtu.be/<episode_id>"`. On any failure, falls back to `episode_id`.
   - `published_at`: from `yt-dlp --skip-download --print "%(upload_date)s"`, formatted as `YYYY-MM-DDT00:00:00Z` to match the format `whitelist-scan/ytdlp.js` produces. Falls back to `null`.
   - `video_pruned_at`: `null` (matches `whitelist-scan/index.js:53`).
3. **Idempotent merge with stale-entry pruning:** if a `manifest.json` already exists, merge — keep existing entries whose `video_path` still resolves on disk (skipping `ffprobe`/`yt-dlp` re-fetch for them), drop existing entries whose `video_path` no longer exists (so a manually-deleted file doesn't keep handing `clip-extract` a dangling path), and add new `episode_id`s found in the audio∩video intersection. Re-running must not destroy data once `scan.js` starts maintaining it.
4. Sort entries by `published_at` desc (stable fallback to `episode_id` for nulls).
5. Write atomically via `tmpPath + renameSync`, matching `sources-store.js:21-25`.

**Error handling:**

- Missing `ffprobe` or `yt-dlp` binaries: fail loudly with install hint.
- Per-episode `yt-dlp` failure (network off, video private, etc.): warn, use fallback values, continue.
- Per-episode `ffprobe` failure: skip that episode entirely — `duration_s` is required by downstream consumers.

**Dependencies:** `ffprobe` (typically ships alongside `ffmpeg`, but is not invoked elsewhere in the repo today — fail with a clear install hint if absent); `yt-dlp` (already used by `whitelist-scan/ytdlp.js`).

**Test (`backfill-manifest.test.js`):** mock `readdirSync` and `execFile`. Cases: intersection logic, yt-dlp fallback, idempotent merge with pre-existing manifest, ffprobe failure skips episode, output schema matches consumer expectations.

## Component 2 — Orchestrator wiring

### 2.1 `loadTranscripts()` (orchestrator/bin/orchestrator.js:132-144)

Currently walks `transcript-cache/<source>/<episode>.json` and returns raw transcripts. Change to:

1. Track `<source>` directory name as `source_id` while walking.
2. For each `<source>`, read the matching `audio-cache/<source>/manifest.json` once. Cache as a `Map<episode_id, manifestEntry>`.
3. For each transcript, look up the manifest entry by `transcript.episode_id`. Merge `video_path` onto the transcript object. Skip transcripts whose manifest entry is missing (`console.warn` once, don't throw).
4. Return the merged array.

Rationale: `loadTranscripts` is the only place that knows about the cache layout, so the join belongs there. Daily-loop stays declarative.

**Note on `source_id`:** transcripts produced by `bin/transcribe.js` already carry `source_id` (required by `validateTranscript` in `shared/schemas.js:24`, written by `transcribe/index.js:13`). The join's load-bearing field is `video_path`. Implementations may also overwrite `source_id` from the directory name as a defensive fallback for legacy transcripts, but it's not strictly required.

**Error handling:**

- Missing `manifest.json` for a source: warn once, skip all transcripts for that source. Other sources still load.
- Transcript present but no manifest entry for its `episode_id`: warn, skip that transcript.

### 2.2 `loadSkillsAndRouter()` (orchestrator/bin/orchestrator.js:28-130)

Add: load `config/sources.yaml` once via `createSourcesStore({ path: ... }).list()`, build a `Map<id, sourceEntry>` (`sourcesById`), pass to `runDailyLoop`.

### 2.3 `runDailyLoop` and `callSkill` (daily-loop.js)

- Add `sourcesById` to `runDailyLoop` params (line 64-67), thread to `callSkill`.
- Rewrite `callSkill("clip")` (line 44-47):

  ```js
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
  ```

- Guard the `null` return at the existing call site (between current lines 118 and 119): if `callSkill` returns `null`, push `{ mode, ok: false, reason: "missing_source_or_video" }` into results and `continue` the outer loop instead of dereferencing `draft.id`. Matches the existing skip-with-reason pattern at line 154.

Note: `matchTopicToEpisode` returns the merged transcript itself, so `episode === transcript` is the same object. The variable name stays for now; the meaningful change is sourcing `source` from the lookup.

**Tests:**

- `orchestrator.test.js` (new, small): fixture filesystem with a transcript + manifest pair; assert `video_path` and `source_id` are attached. Cover missing-manifest and missing-entry warn/skip paths.
- `daily-loop.test.js` (extend): provide `sourcesById` Map. Three new cases:
  - Happy path: transcript with `source_id` resolves to a source; `clipExtract.run` called with `{transcript, source, videoPath}`.
  - Unknown `source_id`: mode skipped with reason `missing_source_or_video`; no throw.
  - Transcript resolved to a source but `video_path` undefined (manifest lookup miss in `loadTranscripts`): mode skipped with reason `missing_source_or_video`; `clipExtract.run` is never called (so ffmpeg can't crash on a missing path).

## Component 3 — `sources.yaml` lex-fridman entry

Schema mirrors what `source-callback.js:14-28` writes when source-discovery approves a candidate, so future automated additions stay consistent with this hand-added one.

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

**Field rationale:**

- `id: lex-fridman` matches the existing on-disk cache directory naming.
- `license: permission-granted` — editorial label only; nothing in `clip-extract` filters on license, so this primarily affects `commands/sources.js` display and future source-discovery merges.
- `attribution_template` uses two of the three valid placeholders (`{creator}`, `{episode_title}`), passes `validateCandidate` schema check, renders cleanly in a caption tail.
- `niches: [ai]` matches `config/niches.yaml`.
- `poll_frequency_h: 24` matches `whitelist-scan/index.js:14` default.
- `lastScanned: null` — `scan.js` populates on first real run; not used by the orchestrator/clip path.

This is the only `sources.yaml` entry the PR adds. The system remains source-agnostic: future entries (manual or via source-discovery approval) work without code changes.

## Acceptance verification (kn9)

Pre-conditions before the smoke run (runbook in PR description, not code):

1. `node workspace-mirror/skills/whitelist-scan/bin/backfill-manifest.js lex-fridman` → produces `~/openclaw-drafts/whitelist/audio-cache/lex-fridman/manifest.json` with entries for the 14 audio/video pairs.
2. Generate at least one transcript: `node workspace-mirror/skills/transcribe/bin/transcribe.js <episode-id>` → writes `~/openclaw-drafts/whitelist/transcript-cache/lex-fridman/<episode>.json`. The branch's earlier m4a→wav fix makes this work.
3. `node workspace-mirror/skills/orchestrator/bin/orchestrator.js --job=daily-loop` → expect a clip draft at `~/openclaw-drafts/pending/<id>/` with non-empty `media/0.mp4` and `draft.json.source.attribution` containing `"Lex Fridman"`.

## Risks & mitigations

- **`yt-dlp` rate-limited or offline during backfill** → titles fall back to `episode_id`. Acceptable: smoke run still produces a valid clip; titles can be re-fetched later.
- **License labeling editorial choice may not reflect Lex's actual terms** → noted in PR description; user can flip to `unclear` post-merge with no code change.
- **`scan.js` re-running could overwrite a backfilled manifest** → idempotent merge in backfill protects on the backfill side, and `scan.js` already only appends new episodes (line 46-54), so it shouldn't drop existing entries either. Cross-checked.
- **Transcript-cache directory does not currently exist on disk** → `loadTranscripts` already handles this (`existsSync` guard at line 134); no behavior change for the empty case.
- **Stale manifest entries (file deleted after manifest written)** → handled by the backfill's stale-entry pruning step (Component 1, step 3): re-running backfill drops manifest entries whose `video_path` no longer resolves on disk. For runtime defense, `callSkill("clip")`'s `!transcript.video_path` guard prevents calling ffmpeg with a missing path. If a file is deleted between `loadTranscripts` and `clipExtract.run` (very narrow race), ffmpeg fails loudly into the existing try/catch at daily-loop.js:120 — surfaced as a skipped mode, not a crash.
- **`source.niches[0]` indirectly required** → `clip-extract/index.js:55` indexes `source.niches[0]`. A `sources.yaml` entry that omits `niches` would crash inside `clipExtract.run`. Not a bug for this PR (the lex-fridman entry has `niches: [ai]`), but flagged so future hand-written entries include it.
