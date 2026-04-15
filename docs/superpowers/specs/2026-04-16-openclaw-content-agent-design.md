# OpenClaw Content Agent — MVP Design

**Date:** 2026-04-16
**Status:** Approved by user, ready for implementation planning
**Scope:** MVP only (Option C: full draft pipeline with mocked publishing)
**Runtime:** OpenClaw daemon on macOS (M1, 16GB RAM)

---

## 1. Goal & Scope

### Goal

A single-laptop, locally-run autonomous content agent that:

1. Wakes daily on a cron schedule
2. Researches trending topics across **AI agents**, **AI × finance**, and **make-money-with-AI** niches
3. Produces draft posts in three modes — clip from a permission-granted whitelist, AI-narrated slideshow, and quote card
4. DMs the user on Telegram for human approval
5. On approve: archives to disk and re-sends a clean, copy-pasteable package back to the user via Telegram
6. Operates fully under the user's control, with no public network surface and no automated publishing

### MVP terminus: mocked publishing

The MVP **does not publish anywhere**. The "publish" step is replaced by:
- Archive to `~/openclaw-drafts/approved/YYYY-MM-DD/<draft-id>/`
- Re-deliver the polished package (caption + hashtags + media) on Telegram for manual copy-paste into Instagram / YouTube

This is deliberate: the approval-loop architecture is the riskiest part to get right (it's where everything composes). Validating it with cheap deps first lets us layer real publishing on top later as bounded follow-on epics.

### Explicitly out of scope for MVP

- Real Instagram / YouTube / TikTok publishing (E3, E4, E5)
- Local image generation — slideshow mode uses **Pexels free API stock images** in MVP (E1)
- Slideshow video assembly — slideshow mode in MVP outputs **script + storyboard manifest only**, no rendered video (E2)
- Email / file-organization / general task automation (E6)
- Multi-account / brand mode (E7)
- Web dashboard (E8)
- Keychain-backed secrets (E9)

All 12 follow-on epics are catalogued in §10.

---

## 2. Daily Loop (Happy Path)

```
06:00  Ollama daemon already up (started at boot via launchd)
09:00  cron triggers `daily-loop`
       │
       ├─ research-skill: pull trending topics (RSS + web search)
       │   in {AI agents, AI×finance, make-money-with-AI}
       │
       ├─ for each topic, agent picks a content mode:
       │    ├─ MODE A: clip from whitelist  → clip-extract skill
       │    ├─ MODE B: AI-narrated slideshow → slideshow-draft skill
       │    └─ MODE C: quote card            → quotecard-draft skill
       │
       ├─ each mode produces a Draft object (canonical schema, §5)
       │
       └─ approval-skill: DMs each draft to user on Telegram
          with inline keyboard: [✅ Approve] [✏️ Modify] [❌ Reject]

09:05  user is notified of N drafts pending
?      user taps buttons / replies with text
       │
       ├─ APPROVE   → archive-skill: move to approved/YYYY-MM-DD/
       │             archive-skill: re-send polished package on Telegram
       │
       ├─ MODIFY <text> → regenerate via provider-router using user feedback,
       │                  re-DM the new version (parent_id link)
       │
       └─ REJECT [reason] → archive to rejected/, log reason for future tuning

13:00  cron triggers `scan-whitelist`
       Polls whitelisted YouTube/podcast feeds (yt-dlp), downloads new
       episodes, transcribes with Whisper.cpp, deduplicates, queues
       for tomorrow's clip pool.

23:00  cron triggers `nightly-report`
       Daily digest DM: drafts produced/approved/rejected, mode mix,
       provider mix, total token spend if hybrid was on.
```

**Cron-triggered skills are invoked directly**, not via the conversational agent. The conversational agent (defined by SOUL.md + AGENTS.md + TOOLS.md) is what the user talks to over Telegram.

---

## 3. Architecture

### 3.1 Component diagram

```
┌──────────────────────────────────────────────────────────┐
│ macOS launchd (boot)                                     │
│  ├─ ollama serve                       (port 11434)      │
│  └─ openclaw gateway --install-daemon  (port 18789)      │
└─────────────────┬────────────────────────────────────────┘
                  │
   ┌──────────────┴──────────────┐
   │   OpenClaw Gateway Daemon   │
   │  ┌────────────┐ ┌────────┐  │
   │  │ Telegram   │ │ Cron   │  │
   │  │ channel    │ │ engine │  │
   │  └─────┬──────┘ └───┬────┘  │
   │        │            │        │
   │     events       triggers   │
   │        │            │        │
   │  ┌─────┴────────────┴─────┐ │
   │  │   Conversational       │ │
   │  │   Agent (SOUL.md +     │ │
   │  │   AGENTS.md + TOOLS.md)│ │
   │  └─────┬──────────────────┘ │
   └────────┼─────────────────────┘
            │ invokes
            ▼
   ┌─────────────────────────────────────────┐
   │ Skills (~/.openclaw/workspace/skills/)  │
   │ ├─ provider-router/    (LLM abstraction)│
   │ ├─ research/           (web-search)     │
   │ ├─ whitelist-scan/     (yt-dlp + cache) │
   │ ├─ transcribe/         (Whisper local)  │
   │ ├─ clip-extract/       (LLM + FFmpeg)   │
   │ ├─ slideshow-draft/    (LLM + Pexels)   │
   │ ├─ quotecard-draft/    (LLM + Pillow)   │
   │ ├─ approval/           (Telegram I/O)   │
   │ ├─ archive/            (disk + redeliv) │
   │ └─ report/             (nightly digest) │
   └─────────────────────────────────────────┘
            │ reads/writes
            ▼
   ┌─────────────────────────────────────────┐
   │ State (~/openclaw-drafts/)              │
   │ ├─ pending/<draft-id>/                  │
   │ ├─ approved/YYYY-MM-DD/<draft-id>/      │
   │ ├─ rejected/YYYY-MM-DD/<draft-id>/      │
   │ ├─ whitelist/sources.yaml               │
   │ ├─ whitelist/transcript-cache/          │
   │ └─ logs/agent.jsonl                     │
   └─────────────────────────────────────────┘
```

### 3.2 Skill catalog

| Skill | Single responsibility | Hard deps |
|---|---|---|
| `orchestrator` | Wires the daily loop together: invokes `research`, picks a mode per topic, calls the appropriate `*-draft` skill, hands each draft to `approval`. | All other skills |
| `provider-router` | Returns an LLM client based on `currentMode` and `taskClass`. Handles model selection, retry, fallback, spend tracking. | Ollama HTTP, optional Anthropic SDK |
| `research` | Pulls trending topics from RSS + web sources, filters by niche. Returns 3-5 ranked topics per niche. | OpenClaw `browser` tool, `provider-router` |
| `whitelist-scan` | Reads `sources.yaml`, polls each source via yt-dlp `--dateafter`, downloads new episodes, deduplicates. | `yt-dlp` |
| `transcribe` | Whisper.cpp on cached audio → timestamped transcript JSON. | `whisper-cpp` (Metal backend) |
| `clip-extract` | LLM scans transcript for viral moments → returns N candidates with start/end timestamps + reasoning → FFmpeg cuts vertical 1080×1920 + auto-burned captions from SRT. | FFmpeg, `provider-router` |
| `slideshow-draft` | LLM generates 60s script → splits into 6-8 beats → Pexels API search per beat → outputs storyboard manifest (no video assembly in MVP). | Pexels free API, `provider-router` |
| `quotecard-draft` | LLM extracts a punchy quote → Pillow renders 1080×1080 brand template. | Pillow |
| `approval` | Sends Draft to Telegram with inline keyboard, listens for callback, dispatches APPROVE/MODIFY/REJECT. | OpenClaw Telegram channel |
| `archive` | Moves draft folder by status; on APPROVE re-sends polished package on Telegram. | OpenClaw fs tools, Telegram channel |
| `report` | Aggregates last 24h logs into a Telegram digest. | logs |

**Mode selection per topic (orchestrator's job):** For MVP, the orchestrator uses a deterministic rule: each daily loop produces **one draft per mode** (one clip + one slideshow + one quotecard) drawn from the top-ranked topics. Topics that aren't in any clip-eligible source default to slideshow or quotecard. This keeps output predictable and easy to debug. Adaptive mode selection (e.g., LLM-decided based on topic shape, or weighted by historical approval rate per mode) is a follow-on tuning epic, not MVP.

### 3.3 External dependencies (Homebrew install)

```bash
brew install ollama ffmpeg whisper-cpp yt-dlp python@3.12
npm install -g openclaw@latest
pip install Pillow requests        # for quotecard + Pexels
```

Optional: `ANTHROPIC_API_KEY` env var for hybrid/premium modes. Pexels free API key required (free, no review).

---

## 4. Provider Abstraction (LLM Routing)

### 4.1 Mental model: 3 modes × 4 task classes

Every LLM call declares its **task class**. The current **mode** maps each task class to a concrete provider+model. Switching modes = re-mapping a routing table; never touches skill code.

#### Task classes (tagged by each skill at the call site)

| Class | Used for | Quality sensitivity |
|---|---|---|
| `bulk-classify` | Topic ranking, transcript chunk filtering, relevance scoring | Low — small model is fine |
| `extract` | Pulling a quote from a transcript, finding entities | Low-Medium |
| `reason` | Moment-detection on a 30-min transcript, picking which 3 moments are viral | Medium-High |
| `write` | Final caption, script, hook, quotecard text — anything user-visible | High |

#### Modes (switched via Telegram, persisted to disk)

| Mode | `bulk-classify` | `extract` | `reason` | `write` |
|---|---|---|---|---|
| **`local`** (default, $0/mo) | `ollama:llama3.1:8b` | `ollama:qwen2.5:14b` | `ollama:qwen2.5:14b` | `ollama:qwen2.5:14b` |
| **`hybrid`** (~$1-2/mo) | `ollama:llama3.1:8b` | `ollama:qwen2.5:14b` | `anthropic:claude-haiku-4-5` | `anthropic:claude-sonnet-4-6` |
| **`premium`** (~$3-5/mo) | `anthropic:claude-haiku-4-5` | `anthropic:claude-haiku-4-5` | `anthropic:claude-sonnet-4-6` | `anthropic:claude-sonnet-4-6` |

The auto-routing in hybrid mode **is this matrix** — the agent doesn't decide per-call. Per-call LLM-decided routing creates non-determinism that's hard to debug.

### 4.2 Telegram commands for routing

```
/mode                    → "Current: local (qwen2.5:14b for everything)"
/mode hybrid             → switches; persists; if ANTHROPIC_API_KEY missing, refuses with how-to-fix
/mode local              → switches back
/mode premium            → switches; warns "~$3-5/mo at current volume"
/providers               → lists configured providers + health + last latency
/spend                   → "Today: $0.12 / cap $1.00. MTD: $1.84."
/spend cap 2.00          → set today's hard-cap
```

### 4.3 Adding a new provider = ~30 lines

The router is one file (`provider-router/router.js`) that imports adapters from `providers/`. Each adapter implements:

```js
// providers/<name>.js
export default {
  name: "openai",
  async complete({ taskClass, prompt, maxTokens, temperature, model }) {
    return { text, tokensIn, tokensOut, latencyMs };
  },
  async health() { return { ok: bool, latencyMs } },
}
```

To add OpenAI / Mistral / Together / Groq / a new local model:

1. Drop a new file in `~/.openclaw/workspace/skills/provider-router/providers/<name>.js` (~30 lines)
2. Add an entry to `providers.yaml`
3. Optionally add a new mode (or extend `hybrid`/`premium`) in the routing matrix
4. New mode shows up in `/mode` Telegram command immediately. No skill code touched.

### 4.4 Fallback semantics

Every call goes through `router.complete({taskClass, ...})`. The router:

1. Looks up `(currentMode, taskClass)` → primary provider+model
2. Calls primary; on transient error (5xx, timeout, rate-limit), retries once with backoff
3. On hard failure or quota-exceeded → falls back **down the tier** (anthropic → ollama, never the reverse — never silently upgrade spend)
4. Logs the routing decision + outcome to `~/openclaw-drafts/logs/router.jsonl`

If `local` mode is selected and Ollama is down → router DMs the user on Telegram: *"Ollama unreachable. Pausing scheduled jobs. Run `ollama serve` or switch /mode hybrid (requires ANTHROPIC_API_KEY)."* No silent upgrades to a paid provider.

### 4.5 Spend tracking

- Every call's tokens_in/out and computed cost goes into `router.jsonl`
- Daily aggregate computed lazily on `/spend`
- Hard-cap is per-day, defaults to $1, configurable. Hitting the cap downgrades all task classes to `local` for the rest of the day and DMs the user that it happened.

---

## 5. The Draft Object (Canonical Schema)

Every skill that produces or consumes drafts agrees on this JSON, written to `~/openclaw-drafts/pending/<draft-id>/draft.json`:

```json
{
  "id": "2026-04-16-clip-lex-altman-001",
  "created_at": "2026-04-16T09:01:23Z",
  "mode": "clip" | "slideshow" | "quotecard",
  "topic": "AI agents replacing junior devs",
  "niche": "ai" | "finance" | "make-money-with-ai",
  "caption": "...",
  "hashtags": ["#aiagents", "#..."],
  "media": [{"path": "media/0.mp4", "type": "video", "duration_s": 47}],
  "source": {                               // null for slideshow/quotecard
    "url": "https://youtu.be/...",
    "title": "Lex Fridman #999 — Sam Altman",
    "creator": "Lex Fridman",
    "license": "permission-granted",
    "attribution_required": true,
    "clip_range": [1830, 1877]
  },
  "provider_used": "ollama:qwen2.5:14b",
  "tokens_in": 8421,
  "tokens_out": 412,
  "status": "pending",
  "parent_id": null                         // populated for MODIFY regenerations
}
```

This schema is the contract between skills. Anything that produces a draft writes one of these; `approval` and `archive` only need to know this schema.

---

## 6. Telegram Protocol & Approval State Machine

### 6.1 One-time setup

1. `@BotFather` on Telegram → `/newbot` → save token (`TG_BOT_TOKEN`)
2. Add to `~/.openclaw/workspace/.env`
3. Configure `~/.openclaw/workspace/config/telegram.yaml` with `dmPolicy: pairing`
4. Start daemon: `openclaw gateway status` should show telegram channel green
5. From **your** Telegram client → DM the bot `/start` → bot replies with a pairing code
6. From your **laptop terminal**: `openclaw pairing approve telegram <code>` → bot now only listens to you
7. Verify: `/whoami` → bot replies with your Telegram user ID

After this, every message from any other Telegram user is silently dropped at the OpenClaw layer.

### 6.2 Two message templates

**Template A — Draft pending approval:**

```
🆕 Draft 2026-04-16-clip-003  •  CLIP mode
Source: Lex Fridman #999 (permission-granted)
Topic: AI agents replacing junior devs

📝 Caption preview:
"Sam Altman explains why AI agents won't replace
junior devs — they'll create them. From Lex Fridman
#999 (clip 30:30-31:17). 🎙️ Full ep linked in bio."

#aiagents #lexfridman #aijobs #softwaredev (8 more)

🎬 [video attached, 47s, 1080×1920]

[✅ Approve]  [✏️ Modify]  [❌ Reject]
```

(`callback_data` carries `act:draft-id`.)

**Template B — Approved package (re-sent after approval):**

```
✅ READY TO POST  •  Draft 2026-04-16-clip-003

═══ COPY THIS ═══
Sam Altman explains why AI agents won't replace
junior devs — they'll create them. From Lex Fridman
#999 (clip 30:30-31:17). 🎙️ Full ep linked in bio.

#aiagents #lexfridman #aijobs #softwaredev #ai
#agents #automation #future #tech #podcast #clip
═════════════════

🎬 [video attached]

Saved to: ~/openclaw-drafts/approved/2026-04-16/clip-003/
```

The "═══ COPY THIS ═══" framing is so the caption is instantly tap-and-hold copyable on mobile without grabbing meta lines.

### 6.3 State machine

```
                    ┌──────────────┐
                    │   PENDING    │  ← draft created, message sent
                    └──┬────┬───┬──┘
              [Approve]│    │   │[Reject]
                       │    │[Modify]
                       ▼    ▼   ▼
               ┌─────────┐ ┌──────────┐ ┌──────────┐
               │ APPROVED│ │ MODIFYING│ │ REJECTED │
               └────┬────┘ └────┬─────┘ └────┬─────┘
                    │           │            │
              archive/       force_reply   archive/
              redeliver      "what         rejected/
              package         changes?"    (with reason
                              │            if given)
                          user replies
                              │
                              ▼
                       regenerate via
                       provider-router
                              │
                              ▼
                        new PENDING
                       (new draft-id,
                        old → SUPERSEDED)
```

#### MODIFY semantics

When user taps **✏️ Modify**:
- Bot edits original message → strikethrough caption + "✏️ Awaiting your changes…"
- Bot sends new message: *"Tell me what to change. Reply to this message. Or /cancel."* with `force_reply` reply_markup
- User replies inline (Telegram's UI auto-targets the reply)
- Bot acks with 👀 reaction
- `regenerate` calls `provider-router.complete({ taskClass: "write", prompt: original_brief + your_feedback, prior_draft })`
- Original draft moves to `superseded/`, new draft created with `parent_id` link
- New draft enters PENDING flow

If user starts a modify and doesn't reply within 30 minutes → bot DMs *"Modify on draft-003 timed out, original restored to PENDING."*

#### REJECT semantics

Tap **❌ Reject**:
- Bot edits message → strikethrough + "❌ Rejected"
- Bot replies inline: *"Reason? (helps tune future drafts) — or /skip"* with force_reply
- If user replies with text → archived to `rejected/` with `reason` saved into draft.json
- If `/skip` or no reply in 5 min → archived with `reason: null`
- Rejection reasons accumulate in `logs/rejections.jsonl` and the `*-draft` skills read the last 30 days as a "user previously rejected things like X — avoid" preamble for `write` task class calls

#### APPROVE semantics

Tap **✅ Approve**:
- Bot edits message → strikethrough → "✅ Approved → posting queue"
- `archive` skill moves draft folder to `approved/YYYY-MM-DD/<id>/`
- Bot sends Template B (clean copy-paste package)
- Done. User copy-pastes into IG/YT manually in MVP.

### 6.4 Slash command catalog

| Command | Effect |
|---|---|
| `/start` | Pairing handshake (one-time) |
| `/whoami` | Confirms paired user ID |
| `/status` | Daemon health, last loop run, pending draft count |
| `/queue` | Lists pending drafts |
| `/queue clear` | Rejects all pending (with confirmation) |
| `/run daily-loop` | Manually trigger 09:00 loop now |
| `/run scan-whitelist` | Manually trigger 13:00 scan now |
| `/mode` `[local\|hybrid\|premium]` | See/change provider mode |
| `/providers` | Show provider health + latencies |
| `/spend` `[cap N]` | See/set today's spend cap |
| `/sources` | List clip whitelist |
| `/sources add <youtube_url>` | Append source |
| `/sources remove <id>` | Remove source |
| `/pause` / `/resume` | Stop / re-enable cron triggers |
| `/quiet 22-07` | Set quiet-hour window |
| `/help` | Lists all commands |

### 6.5 Quiet hours & notification policy

- Default quiet hours: **22:00–08:00** local time
- During quiet hours: cron jobs **still run**, drafts **still get created**, but Telegram messages are **queued**, not sent
- At start of "open hours" (08:00), bot sends one batched message: *"3 drafts ready overnight: tap below to review"* with a button per draft
- Override per-message: any message FROM the user is always processed
- Critical errors (Ollama down, Anthropic auth failure) bypass quiet hours

### 6.6 Concurrency & state

- All draft state lives on disk, not process memory — daemon restart loses zero work
- `pending/<id>/state.json` tracks: `{ status, telegram_message_id, awaiting_modify_input?, awaiting_reject_reason? }`
- Multiple drafts can be in MODIFYING simultaneously (each tied to its own `message_id`), no conflict
- File-lock on `pending/` directory prevents duplicate draft IDs from concurrent cron fires

---

## 7. Storage Layout

### 7.1 Directory tree

```
~/.openclaw/                              ← OpenClaw-managed (don't touch internals)
├── openclaw.json                         ← daemon config
└── workspace/
    ├── AGENTS.md                         ← agent instructions (we author)
    ├── SOUL.md                           ← personality / brand voice
    ├── TOOLS.md                          ← tool descriptions
    ├── .env                              ← secrets, chmod 600, gitignored
    ├── config/
    │   ├── providers.yaml                ← LLM routing (§4)
    │   ├── telegram.yaml                 ← bot token ref + dmPolicy
    │   ├── sources.yaml                  ← clip whitelist
    │   ├── niches.yaml                   ← topic seeds per niche
    │   └── cron.yaml                     ← schedule definitions
    └── skills/
        ├── orchestrator/SKILL.md         + orchestrator.js
        ├── provider-router/SKILL.md      + router.js + providers/*.js
        ├── research/SKILL.md             + research.js
        ├── whitelist-scan/SKILL.md       + scan.js
        ├── transcribe/SKILL.md           + transcribe.js
        ├── clip-extract/SKILL.md         + extract.js
        ├── slideshow-draft/SKILL.md      + slideshow.js
        ├── quotecard-draft/SKILL.md      + quotecard.js + templates/*.png
        ├── approval/SKILL.md             + approval.js
        ├── archive/SKILL.md              + archive.js
        └── report/SKILL.md               + report.js

~/openclaw-drafts/                        ← all transient + persistent state we own
├── pending/<draft-id>/
│   ├── draft.json                        ← canonical Draft schema (§5)
│   ├── state.json                        ← {status, telegram_message_id, ...}
│   ├── prompt.txt                        ← exact LLM prompt used (debugging)
│   └── media/
│       ├── 0.mp4                         ← clip mode
│       ├── storyboard.json               ← slideshow mode
│       └── card.png                      ← quotecard mode
├── approved/YYYY-MM-DD/<draft-id>/       ← same shape as pending/
├── rejected/YYYY-MM-DD/<draft-id>/       ← same shape + rejection_reason in draft.json
├── superseded/<draft-id>/                ← drafts replaced by MODIFY regenerations
├── whitelist/
│   ├── transcript-cache/<source>/<episode-id>.json
│   └── audio-cache/<source>/<episode-id>.m4a    (auto-pruned >7d after transcribe)
├── pexels-cache/<query-hash>.json        ← stock-image API responses, 30d TTL
└── logs/
    ├── agent.jsonl                       ← high-level events
    ├── router.jsonl                      ← every LLM call + cost
    ├── rejections.jsonl                  ← user rejections + reasons
    └── errors.jsonl                      ← stack traces, retries, failures
```

### 7.2 Key configuration files

#### `config/providers.yaml`

```yaml
default_mode: local
current_mode: local        # mutated by /mode command
spend:
  daily_cap_usd: 1.00
  cost_per_million_tokens:
    "anthropic:claude-haiku-4-5":   { in: 0.25, out: 1.25 }
    "anthropic:claude-sonnet-4-6":  { in: 3.00, out: 15.00 }
    "ollama:*":                     { in: 0.00, out: 0.00 }

providers:
  ollama:
    adapter: ollama
    base_url: http://127.0.0.1:11434
    models:
      fast:    llama3.1:8b
      quality: qwen2.5:14b
  anthropic:
    adapter: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models:
      cheap:   claude-haiku-4-5
      quality: claude-sonnet-4-6

modes:
  local:
    bulk-classify: ollama:fast
    extract:       ollama:quality
    reason:        ollama:quality
    write:         ollama:quality
  hybrid:
    bulk-classify: ollama:fast
    extract:       ollama:quality
    reason:        anthropic:cheap
    write:         anthropic:quality
  premium:
    bulk-classify: anthropic:cheap
    extract:       anthropic:cheap
    reason:        anthropic:quality
    write:         anthropic:quality
```

#### `config/telegram.yaml`

```yaml
bot_token_env: TG_BOT_TOKEN          # never put the literal token here
dm_policy: pairing                   # OpenClaw built-in
paired_user_id: null                 # auto-filled on first /start handshake
quiet_hours:
  start: "22:00"
  end: "08:00"
  timezone: auto                     # follows system TZ
batch_quiet_drafts: true             # send one "good morning" digest at 08:00
```

#### `config/sources.yaml` (clip whitelist)

```yaml
sources:
  - id: lex-fridman
    creator: "Lex Fridman"
    type: youtube_channel
    url: https://www.youtube.com/@lexfridman
    license: permission-granted       # "creator publicly allows clipping"
    license_evidence: https://lexfridman.com/clip-policy
    attribution_required: true
    attribution_template: "🎙️ From Lex Fridman {episode_title}"
    poll_frequency_h: 24
    niches: [ai]

  - id: all-in-podcast
    creator: "All-In Podcast"
    type: youtube_channel
    url: https://www.youtube.com/@allin
    license: permission-granted
    license_evidence: https://allinpodcast.co/clip-policy   # verify before adding
    attribution_required: true
    attribution_template: "🎙️ From All-In E{episode_num}"
    poll_frequency_h: 24
    niches: [finance, ai]
```

**The user manually verifies each source's clip-permission posture before adding. The bot does not scrape arbitrary YouTube — it only processes URLs in this file.**

#### `config/niches.yaml`

```yaml
niches:
  ai:
    rss:
      - https://www.theverge.com/ai-artificial-intelligence/rss/index.xml
      - https://feeds.arstechnica.com/arstechnica/index
      - https://hnrss.org/newest?q=AI+agent
    web_search_queries:
      - "AI agent release {today}"
      - "open source LLM {today}"
    keywords_must_include: [ai, llm, agent, model]
    keywords_must_exclude: [crypto, web3]

  finance:
    rss:
      - https://hnrss.org/newest?q=fintech
    web_search_queries:
      - "AI in finance {today}"
      - "AI trading {today}"
    keywords_must_include: [ai, finance, money, trading, fintech]

  make-money-with-ai:
    rss: []
    web_search_queries:
      - "make money with AI {today}"
      - "AI side hustle {today}"
    keywords_must_include: [ai, income, business, hustle]
```

#### `config/cron.yaml`

```yaml
jobs:
  - name: daily-loop
    schedule: "0 9 * * *"               # 09:00 daily
    skill: orchestrator
    args: { phase: daily-loop }

  - name: scan-whitelist
    schedule: "0 13 * * *"              # 13:00 daily
    skill: whitelist-scan

  - name: nightly-report
    schedule: "0 23 * * *"              # 23:00 daily
    skill: report

  - name: cache-prune
    schedule: "0 4 * * 0"               # 04:00 Sundays
    skill: archive
    args: { phase: prune-old-cache, retain_days: 7 }
```

OpenClaw's built-in cron tool consumes this; we don't write our own scheduler.

### 7.3 Secrets

`~/.openclaw/workspace/.env`, mode `0600`:

```bash
TG_BOT_TOKEN=8123456789:AA...                      # from @BotFather
ANTHROPIC_API_KEY=sk-ant-...                       # optional, only for hybrid/premium
OPENAI_API_KEY=                                    # leave blank if unused
PEXELS_API_KEY=...                                 # free, no review required
```

The launchd plist (auto-generated by `openclaw onboard --install-daemon`) sources this file at startup. Skills read `process.env.X` — never touch the file directly.

**Why `.env` and not Keychain:** Single laptop, full-disk-encrypted by default, single user. Keychain integration is more secure but adds a `security` CLI shim per startup and breaks if the daemon runs before login. For a personal-use bot, `.env` with `chmod 600` is the right tradeoff. Keychain is E9 (follow-on epic).

**`.gitignore`:**

```
.env
*-cache/
pending/
approved/
rejected/
superseded/
logs/
```

### 7.4 Backup & portability

- The whole `~/.openclaw/workspace/` (minus `.env`) is the **portable artifact** — copy to a new laptop and the agent works identically once OpenClaw is installed and `.env` is recreated from a password manager
- `~/openclaw-drafts/` is **local state** — backed up by Time Machine but not strictly required for portability

### 7.5 Log schemas

`agent.jsonl`:
```json
{"ts":"2026-04-16T09:01:00Z","level":"info","skill":"research","event":"loop_start","loop":"daily-loop"}
{"ts":"2026-04-16T09:01:23Z","level":"info","skill":"clip-extract","event":"draft_created","draft_id":"...","mode":"clip"}
```

`router.jsonl`:
```json
{"ts":"2026-04-16T09:01:18Z","skill":"clip-extract","task_class":"reason","provider":"ollama:qwen2.5:14b","tokens_in":8421,"tokens_out":412,"latency_ms":11203,"cost_usd":0.0,"ok":true}
```

`rejections.jsonl`:
```json
{"ts":"2026-04-16T09:14:02Z","draft_id":"...","mode":"slideshow","topic":"...","reason":"too clickbait, sounds AI-written"}
```

The last 30 days of `rejections.jsonl` get summarized into a "things the user previously rejected — avoid" preamble prepended to every `write` task class call.

---

## 8. Failure Modes & Self-Healing

| Failure | Detection | Response |
|---|---|---|
| **Ollama down** | router pre-call health check | `local` mode → DM critical alert + pause cron; `hybrid`/`premium` → `bulk-classify`/`extract` quietly fall back, alert if 3 consecutive fails |
| **Anthropic API 5xx / 429** | router catches | Retry once with backoff → fall back **down** the tier. Never up. Logged + counted toward hourly fail budget |
| **Anthropic auth fails** | first call returns 401 | DM: *"ANTHROPIC_API_KEY invalid; switching back to local. Fix and `/mode hybrid` to retry."* — silent mode-revert |
| **Spend cap hit** | router pre-call check | Auto-revert to `local` for rest of day, DM the cap was hit |
| **Telegram unreachable** | bot client connection error | Drafts still get created and persisted. On reconnect, drains pending message queue. Local network outages survive transparently. |
| **yt-dlp source 404 / private / age-gated** | stderr scan | Source marked `unhealthy: true` after 3 consecutive failures, DM user. Loop continues. |
| **Whisper crash on corrupt audio** | exit code | Episode marked `transcribe_failed`, skipped, logged. Loop continues. |
| **FFmpeg crash on bad cut** | exit code | That single draft fails, archived to `errors/`, loop continues. Other drafts unaffected. |
| **Disk space < 5GB** | weekly cron check | DM warning + auto-prune oldest items in `audio-cache/` first, then `pexels-cache/`. Pending/approved drafts never auto-pruned. |
| **Daemon crash** | launchd restarts it | Crash log dumped to `errors.jsonl`. State on disk → resumes cleanly. If crash-loops 5× in 10 min, separate watchdog launchd job pings Telegram (E12 in MVP if user wants) |
| **Cron miss-fire** (laptop asleep at 09:00) | scheduled-run check at next wake | If daemon detects "missed daily-loop by >2h" on startup, DM: *"Missed 09:00 loop, run now? [Yes / Skip]"* |
| **All drafts rejected for 3 days** | nightly report | Flags it; DM *"Brand voice may be drifting — check `SOUL.md` and recent rejection reasons"* |
| **Bot DMed by anyone other than paired user** | dmPolicy=pairing | Silently ignored at OpenClaw layer. Never reaches our skills. |

### Monitoring surface

1. **`/status`** — daily/casual: daemon up?, last loop?, pending count, mode, today's spend
2. **Nightly report DM (23:00)** — weekly review: drafts produced/approved/rejected by mode, top rejection reasons, provider mix, total spend
3. **`logs/*.jsonl`** — debugging: tail/jq workflow when something specific is broken

Optional add-on (E12): Healthchecks.io ping — daemon pings free external URL every 5min; SMS alert if it goes silent.

---

## 9. Security Model

| Layer | Control |
|---|---|
| **Network exposure** | OpenClaw gateway binds `127.0.0.1:18789` only. Ollama binds `127.0.0.1:11434` only. Nothing on a routable interface. |
| **Inbound auth** | Only Telegram. dmPolicy=pairing → only paired user ID is authorized; pairing handshake one-time, code-confirmed at laptop terminal. |
| **Outbound** | Anthropic API (HTTPS, key-auth), Pexels API (HTTPS, key-auth), YouTube via yt-dlp (anonymous read), web search via OpenClaw browser tool. No outbound webhooks. |
| **Secrets** | `.env` chmod 0600, on FileVault-encrypted disk, never committed. Keys referenced by env-var name in YAML, never literal. |
| **Filesystem** | OpenClaw `bash`/`process` tools sandboxed by default (workspace-scoped). Skills only read/write under `~/.openclaw/workspace/` and `~/openclaw-drafts/`. No `sudo`. |
| **Content gating** | Clipping gated by `sources.yaml` whitelist requiring `license: permission-granted` + evidence URL. No path to clip arbitrary URLs. |
| **HITL gate** | Every user-visible artifact requires explicit Telegram tap. No auto-approve path in MVP. |
| **Audit trail** | Every approval/rejection/modify/provider-call logged with timestamps. `archive/` and `rejected/` folders are append-only. |

### Known limitations

- `.env` is plaintext on disk. User-level compromise = key leak. Mitigation: rotate keys quarterly; consider Keychain (E9).
- Telegram-account compromise = bot compromise. Use Telegram 2FA. No out-of-band confirm-via-second-factor for destructive ops.
- Pexels and Anthropic API responses are not signed; we trust TLS.

---

## 10. Roadmap — Follow-On Epics (file in beads after MVP ships)

| ID | Epic | Why deferred from MVP |
|---|---|---|
| **E1** | Local SDXL/Flux image generation (replace Pexels for slideshow mode) | Validate approval loop with cheaper deps first |
| **E2** | FFmpeg slideshow video assembly (text+image+TTS+music → 1080×1920 mp4) | Composition complexity; ship script-only first |
| **E3** | Real Instagram publishing via Meta Graph API + app-review | Meta app review takes 2-6 weeks; needs Business IG + linked FB Page |
| **E4** | Real YouTube publishing via Data API v3 + OAuth flow | Quota application + OAuth setup |
| **E5** | TikTok publishing pipeline (Content Posting API) | Similar to IG; separate developer account |
| **E6** | Email triage / file organization skills | Different niche, separate cron loop |
| **E7** | Multi-account / brand mode | Architectural refactor of SOUL.md |
| **E8** | Read-only mobile web dashboard (`localhost:18790`) | Nice-to-have; Telegram covers most needs |
| **E9** | Migrate secrets from `.env` to macOS Keychain | Defense-in-depth; not required for v1 |
| **E10** | Voice auto-tuning from rejection corpus (LoRA on local model) | Need >100 rejections of data first |
| **E11** | Cross-posting once E3+E4 land (one approval → IG + YT + TikTok) | Depends on E3, E4, E5 |
| **E12** | Healthchecks.io watchdog for daemon liveness | Nice-to-have for unattended operation |

---

## 11. Cost Summary (MVP, steady-state)

| Item | $/month |
|---|---|
| Ollama (local) | $0 |
| Anthropic API (`local` mode) | $0 |
| Anthropic API (`hybrid` mode, est.) | ~$1-2 |
| Anthropic API (`premium` mode, est.) | ~$3-5 |
| Pexels API | $0 (free tier, 200 req/h) |
| Telegram bot | $0 |
| Electricity (24/7 M1 laptop) | ~$2-3 |
| **Total in `local` mode** | **~$2-3** (just electricity) |
| **Total in `hybrid` mode** | **~$3-5** |

---

## 12. Open Questions / Deferred Decisions

These were not blockers for v1 design but the implementation plan should pin them down:

- **Brand voice (`SOUL.md` content)** — concrete tone/persona to be drafted during implementation; user iterates from a baseline template
- **Initial whitelist seed** — user supplies 5-10 verified clip-permitted sources during implementation
- **Pexels search prompts per niche** — to be tuned during slideshow-draft skill build
- **Quote card visual template** — Pillow template PNG to be designed during quotecard-draft skill build
- **Modify timeout (currently 30 min)** and reject-reason timeout (currently 5 min) — confirmed defaults, adjustable later via config

---

## Approval Record

This design was developed iteratively over a brainstorming session on 2026-04-15 / 2026-04-16. User confirmed each of the 6 sections in turn:

- Section 1 (Goal & loop) — confirmed
- Section 2 (Architecture & components) — confirmed
- Section 3 (Provider abstraction) — confirmed
- Section 4 (Telegram protocol) — confirmed
- Section 5 (Storage & secrets) — confirmed
- Section 6 (Failure modes & roadmap) — confirmed

Email-based delivery was removed mid-design at user request; Telegram is the sole delivery surface.

Next step after user reviews this written spec: invoke writing-plans skill to produce the implementation plan, which becomes the seed for beads epics + tasks.
