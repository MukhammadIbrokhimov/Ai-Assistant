# M2: Content Generation — Design

**Date:** 2026-04-16
**Status:** Approved, ready for writing-plans
**Parent spec:** [2026-04-16-openclaw-content-agent-design.md](2026-04-16-openclaw-content-agent-design.md)
**Beads issue:** openclaw-ohk
**Branch:** `feat/plan-c-content-generation`

---

## 1. Goal & Scope

### Goal

Ship the six content-production skills plus one source-discovery skill, so that the approval pipeline built in M1 has real drafts to consume. Every skill independently runnable and TDD-covered; a dry-run script chains them end-to-end for pre-M3 smoke testing.

### Deltas from parent spec

| Change | Why |
|---|---|
| **7 skills, not 6.** Added `source-discovery`. | User wants automated candidate discovery (YouTube viral/trending + user-pushed URLs) with Telegram HITL approval to populate `sources.yaml` safely. Compliance gate stays: human always approves each source. |
| `sources.yaml` seeded with **Lex Fridman only** as fixture. | User has no pre-verified list; source-discovery fills the rest post-launch. Lex Fridman's clip policy is public at lexfridman.com/clip-policy, verifiable. |
| Whisper model: **large-v3** (3GB, ~60 min per 2h podcast). | User chose best quality over speed. Transcription runs once per episode, cached. |
| Quotecard rendering: **Node skill spawns Python/Pillow subprocess** for `render.py`. | Pillow is industry standard for text-on-image typography; Node canvas libs need 2-3× dev time to match. Python isolated to one 60-line file. |
| Research skill uses **RSS + OpenClaw browser tool web-search**, not RSS-only. | User wants richer topic coverage than pure RSS gives. |
| M2 ships a **dry-run script** (`bin/smoke-run.js`), not a real orchestrator. | Orchestrator stays M3. Dry-run validates pipeline end-to-end before cron wiring. |

### In scope for M2

- 7 skills (see §2), each with programmatic entry + CLI entry point + Vitest unit tests + manual smoke-test instructions
- `bin/smoke-run.js` — chains skills once for e2e validation
- `sources.yaml` seeded with Lex Fridman fixture
- External deps installed: `ffmpeg`, `whisper-cpp` + large-v3 model, `yt-dlp`, Python `Pillow` in a workspace venv
- `.env` gains `YOUTUBE_API_KEY`
- Shared JSON schemas (Transcript, Storyboard, Candidate) pinned in `shared/`
- Updated `provider-router` wiring in `poller/bin/poll.js` so the M1 modify flow's regeneration actually works

### Out of scope for M2 (parent-spec deferrals stand)

- Orchestrator (M3)
- Report skill (M3)
- Quiet-hours batching (M3)
- Cron wiring (M3)
- Real publishing — IG/YT/TikTok (E3, E4, E5)
- Slideshow video assembly — MVP outputs storyboard JSON only (E2)
- Local image generation replacing Pexels (E1)
- Instagram/TikTok trending signals for source-discovery (follow-on)
- Podcast-directory (Spotify/Apple) discovery (follow-on)

---

## 2. Skill Catalog

Each skill lives at `~/.openclaw/workspace/skills/<name>/`, mirrored to `~/Desktop/openclaw/workspace-mirror/skills/<name>/`. All Node 22 / ESM (`"type": "module"`), Vitest tests, dependency injection throughout (same pattern as M1 skills).

### 2.1 `research`

- **Responsibility:** Given a niche, return 3-5 ranked topics from RSS feeds and web search.
- **Input:** niche name ∈ `{ai, finance, make-money-with-ai}`
- **Output:** array of `{topic, source_url, score, niche, published_at}`
- **How:**
  1. Fetch every RSS feed in `config/niches.yaml[<niche>].rss` — parse titles + summaries
  2. Run each `web_search_queries` template (substitute `{today}`) via OpenClaw browser tool — harvest top 10 headlines per query
  3. Dedupe by URL + title similarity (LLM `bulk-classify`)
  4. Filter by `keywords_must_include` / `keywords_must_exclude`
  5. LLM `reason` ranks surviving candidates by engagement potential → returns top 5
- **CLI:** `bin/research.js <niche>` → JSON to stdout
- **Deps:** `provider-router`, `shared`, OpenClaw browser tool, `node-fetch` RSS parsing

### 2.2 `whitelist-scan`

- **Responsibility:** Poll sources.yaml for new episodes, download audio.
- **Input:** reads `~/.openclaw/workspace/config/sources.yaml` via `shared/sources-store.js` (sole reader)
- **Output:** new episodes → `~/openclaw-drafts/whitelist/audio-cache/<source-id>/<ep-id>.m4a` + per-source `manifest.json`
- **How:**
  1. **Disk-space precheck**: `statfs` free bytes on `~/openclaw-drafts/` volume; abort + DM user if < 5 GB free
  2. For each source in sources.yaml where `lastScanned + poll_frequency_h < now`
  3. `yt-dlp --dateafter <lastScanned> --flat-playlist <url>` → list new video IDs
  4. For each new ID: `yt-dlp -f m4a -o <audio-cache-path> <video-id>`
  5. Update `manifest.json` with `{episode_id, title, duration_s, published_at, audio_path}`
  6. Mark source's `lastScanned` timestamp (written back via `sources-store.js`)
- **CLI:** `bin/scan.js [<source-id>]` — runs all sources or one
- **Deps:** `yt-dlp`, `shared`

### 2.3 `transcribe`

- **Responsibility:** Whisper.cpp large-v3 on a cached audio file.
- **Input:** audio file path + source_id + episode_id
- **Output:** `~/openclaw-drafts/whitelist/transcript-cache/<source>/<ep-id>.json` (Transcript schema, §3.1). Transcript JSON carries `segments[].{t_start, t_end, text}` which is sufficient for clip-extract to regenerate any SRT it needs — no raw SRT is retained.
- **How:**
  1. **Ollama unload (RAM co-tenancy)**: before invoking whisper, trigger Ollama to evict loaded models by calling `POST /api/generate` with `keep_alive: 0` against every model the router may have warm. Whisper large-v3 + qwen2.5:14b exceed 16GB if both are resident. This is an implementation detail of transcribe — callers don't need to know.
  2. Shell out to `whisper-cli -m <model-path> -l en -osrt <audio>` using the pinned `large-v3` GGML model
  3. Parse the generated SRT into segments, emit Transcript JSON
  4. Delete raw SRT file (Transcript JSON is authoritative)
  5. Return — Ollama reloads its models lazily on next router call
- **CLI:** `bin/transcribe.js <audio-path> <source-id> <episode-id>`
- **Deps:** `whisper-cpp` (Metal backend), `shared`, Ollama HTTP (for unload step)

### 2.4 `clip-extract`

- **Responsibility:** Turn a transcript into 1 clip Draft (with vertical MP4).
- **Input:** transcript JSON path + source metadata (from sources.yaml) + original audio/video path (for the source episode)
- **Output:** `~/openclaw-drafts/pending/<draft-id>/draft.json` (mode: clip) + `media/0.mp4`
- **How:**
  1. LLM `reason` scans transcript → returns top 3 candidates: `[{start_s, end_s, reasoning, hook_quote}]`
  2. For M2, keep top-1 (orchestrator will pick in M3)
  3. **Emit clip-local SRT**: filter `transcript.segments` to those overlapping `[start_s, end_s]`, time-shift each by `-start_s` so segment 0 starts at `00:00:00,000`, write to `pending/<draft-id>/media/clip.srt`
  4. **FFmpeg filtergraph** (real command, not pseudo):
     ```
     ffmpeg -ss <start_s> -to <end_s> -i <source-video-path> \
       -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=media/clip.srt:force_style='FontName=Inter,Fontsize=28,Alignment=2,OutlineColour=&H00000000,BorderStyle=3'" \
       -c:v libx264 -preset medium -crf 23 -c:a aac -r 30 \
       media/0.mp4
     ```
     - `-ss/-to` before `-i` = fast seek; `subtitles=` filter burns ASS-styled captions from the time-shifted SRT; `BorderStyle=3` gives a solid black box behind text for readability
  5. LLM `write` composes caption + hashtags using source's `attribution_template` (validated non-empty)
  6. Write `draft.json` matching parent-spec §5 schema
- **Note on source video**: `whitelist-scan` currently downloads `m4a` audio only. For clip-extract to produce a real video, scan must also cache the video stream — updated to `yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" -o <video-cache-path>` OR clip-extract re-downloads on demand. Decision: **scan caches both audio-only (for transcribe) and video (for clip-extract)**; the video file is auto-pruned 7 days after first successful clip-extract. This is explicit in §2.2 manifest.json: `{audio_path, video_path, video_pruned_at}`.
- **CLI:** `bin/extract.js <transcript-path> <source-id>`
- **Deps:** `ffmpeg`, `provider-router`, `shared`

### 2.5 `slideshow-draft`

- **Responsibility:** Turn a topic into a storyboard Draft (no video render in MVP).
- **Input:** topic string + niche
- **Output:** `pending/<draft-id>/draft.json` (mode: slideshow) + `media/storyboard.json`
- **How:**
  1. LLM `write` generates 60-second script from topic
  2. Split into **6 beats** (10s each) via LLM — returns `[{text}]`
  3. For each beat: LLM `extract` pulls 2-3 search keywords → Pexels API search → pick top result
  4. Emit storyboard.json (§3.2 schema)
  5. LLM `write` composes caption + hashtags
- **CLI:** `bin/slideshow.js "<topic>" <niche>`
- **Deps:** Pexels API (`PEXELS_API_KEY`), `provider-router`, `shared`

### 2.6 `quotecard-draft`

- **Responsibility:** Render a 1080×1080 quote card PNG.
- **Input:** topic + optional source context (transcript chunk or article text)
- **Output:** `pending/<draft-id>/draft.json` (mode: quotecard) + `media/card.png`
- **How:**
  1. If context provided: LLM `extract` pulls a punchy quote verbatim; else LLM `write` generates one
  2. Node writes spec JSON: `{quote, attribution, niche, template: "default"}`
  3. Spawn `python3 render.py` with spec on stdin
  4. Python/Pillow renders PNG with:
     - Dark bg `#0F172A`
     - Serif quote (IBM Plex Serif, large, centered, word-wrapped)
     - Attribution bottom-left (small, italic)
     - Niche watermark bottom-right
  5. LLM `write` composes caption + hashtags
- **CLI:** `bin/quotecard.js "<topic>" [<context-path>]`
- **Deps:** Python 3 + Pillow (in `workspace/.venv`), `provider-router`, `shared`

### 2.7 `source-discovery`

- **Responsibility:** Discover clip-permitted YouTube channels, propose for user approval via Telegram.
- **Input (push mode):** `<url>` — a YouTube channel or video URL
- **Input (pull mode):** `<niche>` — agent searches autonomously
- **Output:** Telegram message with candidate + [✅ Approve] [❌ Reject] [🔗 Open evidence]. On approve → `~/.openclaw/workspace/config/sources.yaml` gets a new entry via `shared/sources-store.js` (sole writer). On reject → appended to `~/openclaw-drafts/logs/rejected-sources.jsonl`.
- **How:**
  1. **Push:** fetch channel/video page via OpenClaw browser → YouTube Data API `channels.list(part=snippet,statistics)` (1 unit) → scan channel description + linked website for clip-policy keywords → LLM `extract` on any found policy page
  2. **Pull:** YouTube Data API `search.list(q=<niche keywords>, publishedAfter=now-30d, type=channel, maxResults=25)` (100 units) to surface channels that have been publishing recently; then for each returned channel, `channels.list` (1 unit each) + optional `search.list(channelId, order=viewCount, maxResults=5)` to sample recent high-view videos (100 units each). Note: the YouTube Data API does NOT natively support sorting channels by "30-day views" — the `publishedAfter` filter is used as a proxy for "active recently"; per-channel video-list aggregation is used for velocity. Expected quota per pull run: ~1-3k units (roughly 3 niches × ~500-1000 units each). Quota safety margin: 3-6× headroom under the 10k/day default.
  3. Score = `subs × (sum of views on last-30d uploads / subs)` — surfaces rising channels, not just big old ones. Channels with zero recent uploads score 0.
  4. **Compliance gate (multi-step, no single-signal bypass):**
     - **Step a — regex precheck**: the policy page's text must match at least one of the following phrasings: `/\b(clip|clipping|highlight|repost|excerpt|short)s?\b.{0,60}\b(allow|grant|permit|free|welcome|ok|fine|encouraged)/i` OR `/creative commons/i` (and if CC, it must be CC-BY or CC-BY-SA, not NC/ND). No regex match → candidate dropped.
     - **Step b — LLM classifies**: `bulk-classify` task returns `{license_type, confidence, evidence_snippet_verbatim, niche_fit}`. The `evidence_snippet_verbatim` must be a substring of the fetched page text (we validate this programmatically — no paraphrasing allowed).
     - **Step c — scoring threshold**: `recommendation_confidence ≥ 0.70` AND `attribution_template` non-empty AND contains `{episode_title}` OR `{episode_num}` placeholder.
  5. **Telegram message layout** (enforces human-must-read gate): the Candidate message renders the `evidence_snippet_verbatim` INLINE (not behind a button), plus the evidence URL as a button. No auto-approve path under any confidence score — approval is always a human tap on [✅ Approve]. If LLM confidence is 1.0, it still goes through the same human gate.
  6. For each surviving candidate: create `~/openclaw-drafts/pending-source/<candidate-id>/state.json` → `approval.sendForApproval()` with Candidate message template. Pending-source entries have NO timeout — they stay pending until user approves or rejects, matching M1's draft-pending behavior.
  7. Poller-side callback wiring (prefix `s:`) is **NOT** built inside source-discovery. It lives in Phase 5 (§4), alongside other poller integration work. This keeps source-discovery Phase-3-parallel-safe.
- **CLI:** `bin/discover.js --url=<url>` (push) or `bin/discover.js --niche=<n>` (pull)
- **Deps:** YouTube Data API v3 (`YOUTUBE_API_KEY`), OpenClaw browser tool, `provider-router`, `shared`, `approval` (reuses Telegram plumbing)

### 2.8 Supporting changes to existing skills

**`provider-router` (pre-existing, built in Plan A — 21 tests passing on main):** Already handles Ollama + Anthropic adapters, mode/task-class routing, spend tracking, retry + fallback. M2 does NOT rebuild it; M2 skills import and call `router.complete({taskClass, prompt, ...})`.

**`shared/` additions:**
- `schemas.js` — Transcript, Storyboard, Candidate schema constants + AJV-style validators (returns `{valid: bool, errors: [...]}`)
- `sources-store.js` — **sole reader AND writer** for `~/.openclaw/workspace/config/sources.yaml`. Uses `fs.open(..., 'wx+')` lockfile + write-to-temp + `fs.rename` for atomicity. Every caller (whitelist-scan, source-discovery approval handler, poller `/sources` commands) goes through this store — no direct YAML reads/writes anywhere else.

**`poller/bin/poll.js` updates (Phase 5 — poller integration):**
- Wire in `provider-router` (currently `router = null`) so M1's modify flow can regenerate drafts
- Add callback prefix dispatch for `s:` (source-discovery approve/reject) → invokes `sources-store.append()` on approve, `logs/rejected-sources.jsonl` append on reject
- Add `/sources` slash commands: `/sources` (list), `/sources propose <url>` (triggers `bin/discover.js --url=<url>`), `/sources remove <id>` (goes through `sources-store.remove()`)

### 2.9 File layout per skill

```
skills/<name>/
├── package.json          (type: module, vitest, shared: file:../shared, engines.node: >=22)
├── index.js              (programmatic entry; exports primary function)
├── bin/<name>.js         (CLI wrapper; #!/usr/bin/env node)
├── <name>.test.js        (vitest; externals mocked via dependency injection)
├── README.md             (smoke-test instructions)
└── (skill-specific files, e.g. quotecard-draft/render.py)
```

---

## 3. Shared JSON Schemas

Pinned in `shared/schemas.js`; consumers import and validate.

### 3.1 Transcript schema

```json
{
  "source_id": "lex-fridman",
  "episode_id": "ABC123XYZ",
  "title": "Lex Fridman #999 — Sam Altman",
  "language": "en",
  "duration_s": 7234,
  "transcribed_at": "2026-04-16T13:14:00Z",
  "model": "whisper-large-v3",
  "segments": [
    {"t_start": 0.0, "t_end": 3.2, "text": "Welcome to the Lex Fridman Podcast."},
    {"t_start": 3.2, "t_end": 7.8, "text": "This is my conversation with Sam Altman."}
  ]
}
```

### 3.2 Storyboard schema

```json
{
  "script": "Full 60-second narration text...",
  "duration_s": 60,
  "beats": [
    {
      "text": "AI agents are replacing junior devs...",
      "duration_s": 10,
      "keywords": ["artificial intelligence", "office"],
      "pexels_photo_id": 123456,
      "image_url": "https://...",
      "pexels_attribution": "Photo by Jane Doe on Pexels"
    }
  ]
}
```

### 3.3 Candidate schema (source-discovery)

**Validator requirement**: `attribution_template` must be a non-empty string containing at least one of `{episode_title}`, `{episode_num}`, or `{creator}` as a literal substring. Candidates failing this validator are dropped before reaching Telegram.


```json
{
  "candidate_id": "2026-04-16-cand-lex-001",
  "discovered_at": "2026-04-16T10:03:00Z",
  "discovery_mode": "push" | "pull",
  "creator": "Lex Fridman",
  "channel_id": "UCSHZKyawb77ixDdsGog4iWA",
  "channel_handle": "@lexfridman",
  "url": "https://www.youtube.com/@lexfridman",
  "subs": 5300000,
  "recent_30d_views": 12400000,
  "velocity_score": 2.34,
  "niche": "ai",
  "niche_fit_confidence": 0.92,
  "license_type": "permission-granted",
  "license_evidence_url": "https://lexfridman.com/clip-policy",
  "license_evidence_snippet": "Feel free to clip and post highlights...",
  "attribution_template": "🎙️ From Lex Fridman {episode_title}",
  "recommendation_confidence": 0.88
}
```

---

## 4. Build Order & Parallelization

```
Phase 1 — Install externals (sequential, user-in-loop):
  ├─ brew install ffmpeg whisper-cpp yt-dlp
  ├─ download whisper large-v3 GGML model
  ├─ python3 -m venv ~/.openclaw/workspace/.venv && .venv/bin/pip install Pillow
  ├─ obtain YOUTUBE_API_KEY (Google Cloud Console, enable YouTube Data API v3)
  ├─ add YOUTUBE_API_KEY to ~/.openclaw/workspace/.env
  └─ seed sources.yaml with Lex Fridman fixture

Phase 2 — Shared contracts (~30 min):
  ├─ shared/schemas.js (Transcript, Storyboard, Candidate + validators)
  ├─ shared/sources-store.js (atomic read/write for sources.yaml with lockfile)
  └─ update shared tests

Phase 3 — Parallel independent skills (6 subagents concurrently):
  ├─ research
  ├─ whitelist-scan (audio AND video caching; manifest.json as in §2.2)
  ├─ transcribe (Ollama unload + whisper + Transcript JSON)
  ├─ slideshow-draft
  ├─ quotecard-draft (includes render.py + venv spawn)
  └─ source-discovery (skill code only — poller-side callback lives in Phase 5)

Phase 4 — Depends on Phase 3 (sequential):
  └─ clip-extract (consumes Transcript schema from transcribe + cached video)

Phase 5 — Integration:
  ├─ poller wiring: provider-router injection + /sources commands + s: callback dispatch
  ├─ bin/smoke-run.js (dry-run, starts at clip-extract using pre-cached audio+transcript)
  └─ e2e smoke test (real topic → 3 real drafts in pending/ → Telegram approval)
```

### Parallelization model

Subagents **cannot** run Bash or write outside `~/Desktop/openclaw/`.

- **Human (user + primary agent) handles:** external dep installs, `.env` edits, `npm install`, ollama checks, git commits, smoke-test execution, Python venv creation, YouTube API key setup
- **Subagents handle:** writing skill source code + Vitest tests inside `workspace-mirror/skills/<name>/`, following M1 TDD pattern

Phase 3 launches up to 6 subagents in one message for max concurrency. Each gets:
- The parent-spec §5 Draft schema
- The §3 schemas from this doc
- The M1 `shared/` package API (constants, telegram-client, draft-store)
- Explicit TDD instructions: failing tests first, then implementation, rsync to workspace for real runs

### Wall-clock estimate

Revised after initial review found subagent coordination overhead was understated.

| Phase | Time | Notes |
|---|---|---|
| 1. External deps | ~45 min | large-v3 model download (~3GB) is bottleneck; YouTube API key signup parallel |
| 2. Shared schemas | ~45 min | schemas.js + sources-store.js both need tests |
| 3. Parallel skills | ~4-5 hrs | 6 subagents × rsync + npm install + test/fix cycles; primary agent is the serialization point |
| 4. clip-extract | ~1.5 hrs | includes SRT time-shift logic + filtergraph tuning |
| 5. Integration + smoke | ~1.5 hrs | poller wiring + `s:` dispatch + smoke-run + e2e |
| **Total active work** | **~8-9 hrs** | plan for two 4-hr sessions |

---

## 5. External Dependencies — Install Checklist

```bash
# 1. Homebrew packages
brew install ffmpeg whisper-cpp yt-dlp

# 2. Whisper large-v3 model
mkdir -p ~/.whisper-models
cd ~/.whisper-models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin

# 3. Python venv + Pillow for quotecard
python3 -m venv ~/.openclaw/workspace/.venv
~/.openclaw/workspace/.venv/bin/pip install --upgrade pip Pillow

# 4. YouTube Data API v3 key
# → https://console.cloud.google.com → new project → enable YouTube Data API v3
# → create API key, restrict to YouTube Data API v3
# → append to ~/.openclaw/workspace/.env as YOUTUBE_API_KEY=...

# 5. Sanity checks
ffmpeg -version                       # should print 6.x
whisper-cli --help                    # should show Metal backend support
yt-dlp --version                      # should print 2025.x
~/.openclaw/workspace/.venv/bin/python -c "from PIL import Image; print(Image.__version__)"
```

Existing `.env` entries untouched (TG_BOT_TOKEN, ANTHROPIC_API_KEY, PEXELS_API_KEY).

---

## 6. Test Strategy

Every skill follows M1 conventions (reference: `shared/`, `approval/`, `poller/`).

### 6.1 Unit tests (TDD — write first)

- Vitest, `describe/it`, dependency injection for all externals (`fetch`, `child_process`, `fs`)
- Mock Ollama + Anthropic HTTP via `vi.stubGlobal('fetch', vi.fn())` — Node 22 native fetch bypasses nock
- Mock FFmpeg / whisper-cli / yt-dlp by injecting a fake `spawn` that returns a promise with `{stdout, stderr, exitCode}`
- Mock Pexels / YouTube Data API via fetch stub
- No network in tests. No real file writes outside `os.tmpdir()`.

### 6.2 Smoke tests (manual, documented per skill)

- Each skill's README has a "Smoke test" section: exact CLI invocation, expected outputs, verification steps
- Example: `bin/quotecard.js "AI agents replacing junior devs"` → must produce `pending/<id>/media/card.png` that looks correct when opened

### 6.3 End-to-end (Phase 5)

- `bin/smoke-run.js` runs a full chain. To avoid a 60-min Whisper wait, smoke-run accepts a `--cached` flag (default on in dev) that skips the scan+transcribe phases and starts at clip-extract using the pre-cached fixture (audio file AND transcript JSON, see §6.4).
- `bin/smoke-run.js [--live]` chain:
  1. `research(ai)` → picks topic T
  2. If `--live`: `whitelist-scan --source lex-fridman` (downloads real latest Lex episode if not yet cached)
  3. If `--live` AND no cached transcript: `transcribe(cached-audio)` (blocks ~60 min)
  4. `clip-extract(transcript, lex-fridman, video-path)` → Draft 1
  5. `slideshow-draft(T, ai)` → Draft 2
  6. `quotecard-draft(T)` → Draft 3
  7. For each draft: `approval.sendForApproval(...)` (reused from M1)
- **State isolation**: smoke-run writes to `~/openclaw-drafts/pending/` by default (the real user root), BUT prefixes each draft_id with `smoke-` so they are visually distinct in the pending folder and easy to bulk-delete (`rm -rf ~/openclaw-drafts/pending/smoke-*`). An additional `--sandbox` flag redirects all writes to `/tmp/openclaw-smoke/` (no Telegram — just creates files) for pure offline validation.
- Expected: `--cached` mode produces 3 Telegram DMs within ~3 min of running `bin/smoke-run.js`, each with approve/modify/reject buttons that work per M1 flow.

### 6.4 Pre-cached test assets

- One Lex Fridman episode pre-downloaded AND pre-transcribed, living at:
  - `~/openclaw-drafts/whitelist/audio-cache/lex-fridman/<fixture-id>.m4a` (audio for reference)
  - `~/openclaw-drafts/whitelist/video-cache/lex-fridman/<fixture-id>.mp4` (video, required by clip-extract to produce an actual clip)
  - `~/openclaw-drafts/whitelist/transcript-cache/lex-fridman/<fixture-id>.json` (Transcript JSON)
- Fixture paths are gitignored (under `~/openclaw-drafts/`, not the repo)
- Creating the fixture is a one-time manual step in Phase 1: pick an episode that's interesting enough to produce a good smoke-clip, run `bin/scan.js --source lex-fridman --video` then `bin/transcribe.js <audio>` once

---

## 7. Pinned Defaults

| Decision | Default | Config key |
|---|---|---|
| Clip candidates returned by LLM | 3 | (hardcoded in clip-extract) |
| Clip picked per transcript in M2 | top-1 (orchestrator picks in M3) | — |
| Clip dimensions | 1080×1920, 30fps, H.264 | (hardcoded in clip-extract) |
| Clip duration window | 45-60s (LLM-picked within range) | (prompt constraint) |
| Slideshow beats | 6 × 10s = 60s | (hardcoded in slideshow-draft) |
| Quotecard dimensions | 1080×1080 | (hardcoded in render.py) |
| Quotecard template | Dark `#0F172A` bg, IBM Plex Serif quote, attribution bottom-left, watermark bottom-right | (`render.py` template: "default") |
| Whisper model | large-v3 | (hardcoded in transcribe) |
| Source-discovery pull cron | Sundays 10:00 local | `cron.yaml` (deferred to M3) |
| Source-discovery confidence threshold | ≥ 0.70 | (hardcoded initially; move to `providers.yaml` if tuning needed) |
| Reject-reason timeout (source-discovery) | 5 min | matches M1 |

### LLM task-class map (for spend tracking)

| Skill | Call | Task class |
|---|---|---|
| research | RSS dedupe + topic similarity | `bulk-classify` |
| research | topic engagement ranking | `reason` |
| clip-extract | viral-moment detection on transcript | `reason` |
| clip-extract | caption + hashtags | `write` |
| slideshow-draft | script generation | `write` |
| slideshow-draft | script → 6-beat split | `write` |
| slideshow-draft | beat keyword extraction | `extract` |
| slideshow-draft | caption + hashtags | `write` |
| quotecard-draft | quote extraction from context | `extract` |
| quotecard-draft | quote generation (no-context path) | `write` |
| quotecard-draft | caption + hashtags | `write` |
| source-discovery | niche fit classification | `bulk-classify` |
| source-discovery | policy evidence extraction (with verbatim snippet validation) | `bulk-classify` |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Whisper large-v3 slow** (~60 min per 2h podcast) | Smoke flow uses pre-cached audio+transcript so dev loop isn't blocked. In production, the 13:00 scan-whitelist cron is independent from the 09:00 daily-loop. |
| **Whisper + Ollama RAM co-tenancy** (large-v3 needs ~10GB, qwen2.5:14b ~9-10GB; 16GB M1 can't hold both resident) | `transcribe` explicitly evicts Ollama models via `POST /api/generate` with `keep_alive:0` before invoking whisper, waits ~1s for unload, then runs whisper. After whisper exits, Ollama lazy-loads its model on next router call (~3-5s cold-start penalty, acceptable for 13:00 cron). If evict fails or RAM pressure detected via `vm_stat`, transcribe aborts + DMs the user. |
| **OpenClaw browser tool flake** (used by research + source-discovery) | Every browser call wrapped in try/catch. `research` falls back to RSS-only if browser fails 3× consecutively. `source-discovery` pull-mode skips the candidate on browser failure; push-mode surfaces the error to the user's DM. |
| **YouTube Data API quota exhaustion** | Default 10k units/day. `search.list=100`, `channels.list=1`, per-channel video velocity sampling adds ~100 units per channel. Realistic pull-mode per run: 1-3k units (3 niches × ~500-1000 units). 3-6× headroom under quota. Source-discovery caches per-channel results for 24h to absorb retry/reruns. Quota-exceeded → DM + defer pull to next cron. |
| **YouTube search does not support "sort by 30d views"** | Not a hidden bug: spec acknowledges native YouTube Data API sorts by lifetime viewCount only. `publishedAfter=now-30d` used as activity proxy; velocity computed client-side from per-channel video samples. |
| **Pexels rate limit** (200 req/hour free tier) | Slideshow uses 6 req/draft; even 30 drafts/hour = 180 req, just under. Log + alert if 429 received. |
| **Disk space on 16GB M1 laptop** | `whitelist-scan` does a free-space precheck (`statfs`) before every download; aborts + DMs user if < 5 GB free on the drafts volume. 7-day video-cache prune job (cron, deferred to M3) keeps steady-state under 10 GB. |
| **Python subprocess fails silently** | `quotecard-draft` captures stderr + non-zero exit codes; Node throws with full Python traceback. Unit test covers the failure path. |
| **LLM returns invalid JSON** (clip-extract, source-discovery) | Use Ollama / Anthropic structured output where supported. Validate with `shared/schemas.js`. Retry once with schema-correction prompt. If second attempt fails, log + skip. |
| **sources.yaml write race** (source-discovery + poller `/sources remove` concurrent) | `shared/sources-store.js` is the **sole reader and writer** for sources.yaml. It uses `fs.open(..., 'wx+')` advisory lockfile + write-to-temp + `fs.rename` for atomicity. Both callers (source-discovery approval handler and poller command) go through the same module. |
| **LLM hallucinates a clip policy** in source-discovery | Defense-in-depth:<br>(a) regex precheck on page text (§2.7 step 4a) — must match clip-permission phrasings or CC-BY/BY-SA<br>(b) `evidence_snippet_verbatim` must be a substring of fetched page (programmatic validation — blocks LLM paraphrase)<br>(c) Telegram message renders evidence snippet INLINE + evidence URL as a button; no collapsed text<br>(d) no auto-approve path under any confidence score — approval is always a human tap<br>(e) reject → source goes on permanent blocklist, won't resurface |
| **smoke-run pollutes production pending/** | Every smoke-run draft_id is prefixed `smoke-` for visual isolation + easy bulk delete. `--sandbox` flag redirects all writes to `/tmp/openclaw-smoke/` and skips Telegram entirely. |

---

## 9. Handoff to M3

M2 terminates when:
- All 7 skills have passing unit tests
- All 7 skills have documented smoke tests
- `bin/smoke-run.js` produces 3 real drafts in `pending/`, all three trigger Telegram approvals, user can approve/modify/reject each
- `sources.yaml` has ≥ 1 verified source (Lex Fridman fixture)
- M2 branch merged to main via PR

**M3 builds on:**
- The dry-run script (`bin/smoke-run.js`) becomes the starting point for the orchestrator's daily loop
- Each skill's programmatic entry is called by orchestrator
- `cron.yaml` wiring (already defined in parent spec §7.2) fires orchestrator at 09:00, whitelist-scan at 13:00, report at 23:00
- `source-discovery` pull-mode gets a new cron: Sundays 10:00
- `approval/` + `archive/` + `poller/` (from M1) already consume the drafts that M2 produces

**M3 responsibilities that M2 explicitly leaves unsolved** (so subagents in M2 don't silently invent solutions):

- **Topic↔episode matching**: `research()` returns topics (e.g., "AI agents replacing junior devs"); `clip-extract` consumes a transcript + source. The join — deciding *which* whitelisted episode best matches a given topic — is the orchestrator's job in M3. M2 skills take decoupled inputs (`clip-extract` is told which transcript to process; it does not choose).
- **Mode selection per topic**: §3.2 of the parent spec says the orchestrator picks one of (clip|slideshow|quotecard) per topic using a deterministic "one per mode per day" rule. M2 skills do not make this decision.
- **Cron scheduling**: M2 skills do not schedule themselves. They are CLI-invokable and programmatically-invokable; M3 wires cron.
- **Cap enforcement**: M2 skills run when invoked. M3 enforces the "N drafts per day" cap.

---

## Approval Record

Design brainstormed 2026-04-16. User confirmed each scoping decision:

- 7th skill `source-discovery` with HITL Telegram approval — confirmed
- Whisper large-v3 — confirmed
- Node + Python/Pillow subprocess for quotecard — confirmed
- Research uses RSS + OpenClaw browser tool web-search — confirmed
- Dry-run script in M2; real orchestrator stays M3 — confirmed

### Review revisions (2026-04-16, post-spec)

Independent technical review surfaced 3 blockers, 7 significant issues, 6 nits. All applied:

- **B1** — FFmpeg filtergraph spelled out with `subtitles=` filter; clip-local time-shifted SRT explicit (§2.4)
- **B2** — YouTube quota re-estimated to 1-3k units/run; `order=viewCount` limitation acknowledged; `publishedAfter` used as activity proxy (§2.7, §8)
- **B3** — Compliance gate now multi-step: regex precheck → verbatim-substring validation → human-eyes evidence inline in Telegram; no auto-approve path under any confidence (§2.7 step 4, §8 defense-in-depth)
- **S1** — Whisper+Ollama RAM co-tenancy explicit: transcribe evicts Ollama models before whisper (§2.3 step 1, §8)
- **S2** — Disk-space precheck in whitelist-scan (§2.2 step 1)
- **S3** — `sources-store.js` named as sole reader+writer; both source-discovery and poller `/sources` commands use it (§2.8)
- **S4** — Wall-clock revised to 8-9 hrs; poller-side `s:` callback wiring moved from Phase 3 to Phase 5 to keep Phase 3 parallel-safe (§2.7 step 7, §4, §4 wall-clock)
- **S5** — `provider-router` explicitly noted as pre-existing from Plan A (§2.8)
- **S6** — Fixture is both audio+transcript; smoke-run default `--cached` starts at clip-extract; `--live` triggers full chain (§6.3, §6.4)
- **S7** — Topic↔episode matching explicitly assigned to M3 (§9)
- **Nits** — language field added to Transcript schema; attribution_template placeholder validator added; smoke-run state isolation via `smoke-` prefix + `--sandbox` flag; source-discovery approval has no timeout (matches M1)

Next step: invoke `superpowers:writing-plans` to produce the implementation plan that feeds into beads epics + tasks.
