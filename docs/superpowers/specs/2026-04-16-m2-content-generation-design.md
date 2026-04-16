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
- **Input:** reads `config/sources.yaml`
- **Output:** new episodes → `~/openclaw-drafts/whitelist/audio-cache/<source-id>/<ep-id>.m4a` + per-source `manifest.json`
- **How:**
  1. For each source in sources.yaml where `lastScanned + poll_frequency_h < now`
  2. `yt-dlp --dateafter <lastScanned> --flat-playlist <url>` → list new video IDs
  3. For each new ID: `yt-dlp -f m4a -o <audio-cache-path> <video-id>`
  4. Update `manifest.json` with `{episode_id, title, duration_s, published_at, audio_path}`
  5. Mark source's `lastScanned` timestamp
- **CLI:** `bin/scan.js [<source-id>]` — runs all sources or one
- **Deps:** `yt-dlp`, `shared`

### 2.3 `transcribe`

- **Responsibility:** Whisper.cpp large-v3 on a cached audio file.
- **Input:** audio file path + source_id + episode_id
- **Output:** `~/openclaw-drafts/whitelist/transcript-cache/<source>/<ep-id>.json` (Transcript schema, §3.1)
- **How:**
  1. Shell out to `whisper-cli --model large-v3 --language en --output-srt <audio>`
  2. Parse the generated SRT into segments
  3. Emit Transcript JSON
  4. Delete raw SRT (kept only as intermediate)
- **CLI:** `bin/transcribe.js <audio-path> <source-id> <episode-id>`
- **Deps:** `whisper-cpp` (Metal backend), `shared`

### 2.4 `clip-extract`

- **Responsibility:** Turn a transcript into 1 clip Draft (with vertical MP4).
- **Input:** transcript JSON path + source metadata (from sources.yaml)
- **Output:** `~/openclaw-drafts/pending/<draft-id>/draft.json` (mode: clip) + `media/0.mp4`
- **How:**
  1. LLM `reason` scans transcript → returns top 3 candidates: `[{start_s, end_s, reasoning, hook_quote}]`
  2. Orchestrator picks best-1 by score (for M2: just top of list)
  3. FFmpeg:
     - `-ss <start> -to <end>` — trim
     - `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"` — vertical crop
     - Burn captions from SRT segments in the clip range
     - `-c:v libx264 -preset medium -crf 23 -c:a aac`
  4. LLM `write` composes caption + hashtags using source's `attribution_template`
  5. Write `draft.json` matching parent-spec §5 schema
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
- **Output:** Telegram message with candidate + [✅ Approve] [❌ Reject] [🔗 Open evidence]. On approve → `~/.openclaw/workspace/config/sources.yaml` gets a new entry. On reject → appended to `~/openclaw-drafts/logs/rejected-sources.jsonl`.
- **How:**
  1. **Push:** fetch channel/video page via OpenClaw browser → YouTube Data API channel metadata (subs, recent views) → scan description + linked website for clip-policy keywords → LLM `extract` on any found policy page
  2. **Pull:** YouTube Data API `/search` in niche keywords, sort by viewCount 30d → fetch channel metadata → policy check (same as push)
  3. Score = `subs × (recent 30d views / subs)` — surfaces rising channels, not just big old ones
  4. LLM `bulk-classify` assigns niche fit + confidence 0-1
  5. Filter: confidence ≥ 0.7 AND license detected AND attribution template extractable
  6. For each surviving candidate: create `~/openclaw-drafts/pending-source/<candidate-id>/state.json` → `approval.sendForApproval()` with Candidate message template
  7. Poller-side: add callback prefix `s:` (source) to dispatcher → on approve, append to `sources.yaml` atomically; on reject, log
- **CLI:** `bin/discover.js --url=<url>` (push) or `bin/discover.js --niche=<n>` (pull)
- **Deps:** YouTube Data API v3 (`YOUTUBE_API_KEY`), OpenClaw browser tool, `provider-router`, `shared`, `approval` (reuses Telegram plumbing)

### 2.8 Supporting changes to existing skills

- **`shared/`** — add three schema constants: Transcript, Storyboard, Candidate (and their validators)
- **`shared/`** — add `sources-store.js` for atomic read/write of `sources.yaml`
- **`poller/bin/poll.js`** — wire in provider-router (currently `router = null`) so M1's modify flow can regenerate; add callback prefix dispatch for `s:` (source-discovery approvals); add `/sources` slash commands (`/sources`, `/sources propose <url>`, `/sources remove <id>`)

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
  ├─ whisper-cli --download-model large-v3
  ├─ python3 -m venv ~/.openclaw/workspace/.venv && .venv/bin/pip install Pillow
  ├─ obtain YOUTUBE_API_KEY (Google Cloud Console, enable YouTube Data API v3)
  ├─ add YOUTUBE_API_KEY to ~/.openclaw/workspace/.env
  └─ seed sources.yaml with Lex Fridman fixture

Phase 2 — Shared contracts (~30 min):
  ├─ shared/schemas.js (Transcript, Storyboard, Candidate + validators)
  ├─ shared/sources-store.js (atomic read/write for sources.yaml)
  └─ update shared tests

Phase 3 — Parallel independent skills (6 subagents concurrently):
  ├─ research
  ├─ whitelist-scan
  ├─ transcribe
  ├─ slideshow-draft
  ├─ quotecard-draft (includes render.py)
  └─ source-discovery (skill code + approval-side callback dispatch)

Phase 4 — Depends on Phase 3 (sequential):
  └─ clip-extract (consumes Transcript schema from transcribe)

Phase 5 — Integration:
  ├─ poller wiring: provider-router injection + /sources commands + s: callback
  ├─ bin/smoke-run.js (dry-run)
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

| Phase | Time |
|---|---|
| 1. External deps | ~30 min (large-v3 download bottleneck) |
| 2. Shared schemas | ~30 min |
| 3. Parallel skills | ~2-3 hrs |
| 4. clip-extract | ~1 hr |
| 5. Integration + smoke | ~1 hr |
| **Total active work** | **~5-6 hrs** |

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

- `bin/smoke-run.js` runs a full chain:
  1. `research(ai)` → picks topic T
  2. `whitelist-scan --source lex-fridman` (uses a pre-cached audio file to skip the 60-min transcribe wait)
  3. `transcribe(cached-audio)` (skipped if transcript-cache hit)
  4. `clip-extract(transcript, lex-fridman)` → Draft 1
  5. `slideshow-draft(T, ai)` → Draft 2
  6. `quotecard-draft(T)` → Draft 3
  7. For each draft: `approval.sendForApproval(...)` (reused from M1)
- Expected: 3 Telegram DMs within ~5 min of running `bin/smoke-run.js`, each with approve/modify/reject buttons that work per M1 flow

### 6.4 Pre-cached test assets

- One Lex Fridman episode pre-transcribed and checked into `~/openclaw-drafts/whitelist/transcript-cache/lex-fridman/<fixture-id>.json` so the Phase 5 smoke run doesn't block on a real 60-minute Whisper transcribe
- This fixture is gitignored (lives under `~/openclaw-drafts/`, not the repo)

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
| slideshow-draft | beat keyword extraction | `extract` |
| slideshow-draft | caption + hashtags | `write` |
| quotecard-draft | quote extraction from context | `extract` |
| quotecard-draft | quote generation (no-context path) | `write` |
| quotecard-draft | caption + hashtags | `write` |
| source-discovery | niche fit classification | `bulk-classify` |
| source-discovery | policy evidence extraction | `extract` |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Whisper large-v3 slow** (~60 min per 2h podcast) | Phase 5 smoke uses a pre-cached transcript so the dev loop isn't gated on a live transcribe run. In production, the 13:00 scan-whitelist cron is independent from the 09:00 daily-loop, so latency doesn't block drafts. |
| **OpenClaw browser tool flake** (used by research + source-discovery) | Every browser call wrapped in try/catch. `research` falls back to RSS-only if browser fails 3× consecutively. `source-discovery` pull-mode skips the candidate on browser failure; push-mode surfaces the error to the user's DM. |
| **YouTube Data API quota exhaustion** | Default 10k units/day. `/search` = 100 units, `/channels` = 1 unit. Pull-mode uses ~300-500 units/run (weekly) — well under. Push-mode is user-initiated so unlikely to spike. Quota-exceeded errors surfaced as Telegram DM with *"YouTube API quota hit for today."* |
| **Pexels rate limit** (200 req/hour free tier) | Slideshow uses 6 req/draft; even 30 drafts/hour = 180 req, just under. Log + alert if 429 received. |
| **Python subprocess fails silently** | `quotecard-draft` captures stderr + non-zero exit codes; Node throws with full Python traceback. Unit test covers the failure path. |
| **LLM returns invalid JSON** (clip-extract, source-discovery) | Use Ollama / Anthropic structured output where supported. Validate with `shared/schemas.js`. Retry once with schema-correction prompt. If second attempt fails, log + skip. |
| **sources.yaml write race** (two source-discovery runs concurrently) | `shared/sources-store.js` uses atomic write (write to temp → rename) + `lockfile` equivalent (pid file or fs.open `wx`). |
| **LLM hallucinates a clip policy** in source-discovery | HITL guardrail: human always approves each candidate and is encouraged to click the Evidence URL before tapping Approve. The agent provides `license_evidence_snippet` verbatim from the source page, not paraphrased — makes it easy for user to spot fabrication. |

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

---

## Approval Record

Design brainstormed 2026-04-16. User confirmed each scoping decision:

- 7th skill `source-discovery` with HITL Telegram approval — confirmed
- Whisper large-v3 — confirmed
- Node + Python/Pillow subprocess for quotecard — confirmed
- Research uses RSS + OpenClaw browser tool web-search — confirmed
- Dry-run script in M2; real orchestrator stays M3 — confirmed

Next step after user reviews this spec: invoke `superpowers:writing-plans` to produce the implementation plan that feeds into beads epics + tasks.
