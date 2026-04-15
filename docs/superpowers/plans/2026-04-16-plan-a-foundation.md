# Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the OpenClaw daemon on macOS, create the workspace skeleton + all config files, pair the Telegram bot, and ship a fully-tested `provider-router` skill that abstracts LLM calls across Ollama and Anthropic with mode-based routing, fallback, and spend tracking.

**Architecture:** OpenClaw daemon installed via npm runs as a launchd service. Workspace at `~/.openclaw/workspace/` with skills as Node ES modules (one per directory). The first skill, `provider-router`, is a small router (~50 lines) plus per-provider adapters (~30 lines each) implementing a uniform `complete({taskClass, prompt, ...})` interface. Configuration in YAML under `config/`, secrets in chmod-0600 `.env`, all state in `~/openclaw-drafts/`.

**Tech Stack:** Node.js 22+, OpenClaw, Ollama (local LLM), `@anthropic-ai/sdk`, `js-yaml`, Vitest (tests), `nock` (HTTP mocking in tests), Homebrew.

**Deliverable at end of Plan A:** A running daemon paired to your Telegram. From the laptop CLI you can run:
```
openclaw skills run provider-router --task-class write --prompt "say hello"
```
…and get a response from `qwen2.5:14b` (local mode, default). Set `ANTHROPIC_API_KEY`, switch mode to `hybrid`, run again, get a response from Claude Sonnet. Spend log shows the costs. Falls back to Ollama if Anthropic is down. Telegram channel is paired but no draft logic yet (that's Plan B).

**Spec reference:** `docs/superpowers/specs/2026-04-16-openclaw-content-agent-design.md` §4 (provider abstraction), §7 (storage), §9 (security).

**Scope boundaries (deferred to later plans):**
- All draft/approval/archive logic → Plan B
- All content-producing skills (research, clip, slideshow, quotecard) → Plan C
- Orchestrator + cron + report → Plan D
- `/mode` Telegram command → Plan B (depends on approval skill being able to listen for Telegram messages)

---

## Files Created or Modified by This Plan

### Created (paths absolute under `~/.openclaw/workspace/`)

```
~/.openclaw/workspace/
├── AGENTS.md                              ← agent instructions (stub for Plan A; expanded later)
├── SOUL.md                                ← brand voice (stub)
├── TOOLS.md                               ← tool descriptions (stub)
├── .env                                   ← secrets, chmod 0600
├── .gitignore                             ← excludes .env, caches, drafts
├── config/
│   ├── providers.yaml                     ← LLM routing matrix (full)
│   ├── telegram.yaml                      ← bot config (full)
│   ├── sources.yaml                       ← clip whitelist (empty array for now)
│   ├── niches.yaml                        ← topic seeds (full)
│   └── cron.yaml                          ← schedule defs (empty array for now)
└── skills/
    └── provider-router/
        ├── SKILL.md                       ← skill description for OpenClaw
        ├── package.json                   ← npm package, deps + test script
        ├── router.js                      ← the dispatcher (~80 lines)
        ├── spend.js                       ← spend tracking + cap (~40 lines)
        ├── providers/
        │   ├── ollama.js                  ← Ollama adapter (~40 lines)
        │   └── anthropic.js               ← Anthropic adapter (~40 lines)
        ├── lib/
        │   └── load-config.js             ← reads providers.yaml (~20 lines)
        └── tests/
            ├── ollama.test.js
            ├── anthropic.test.js
            ├── router.test.js
            ├── spend.test.js
            └── fallback.test.js
```

### Created (under `~/openclaw-drafts/`)

```
~/openclaw-drafts/
├── pending/         (empty)
├── approved/        (empty)
├── rejected/        (empty)
├── superseded/      (empty)
├── whitelist/       (empty subdirs)
├── pexels-cache/    (empty)
└── logs/
    ├── agent.jsonl       (touched, empty)
    ├── router.jsonl      (touched, empty)
    ├── rejections.jsonl  (touched, empty)
    └── errors.jsonl      (touched, empty)
```

### Created (project repo, for tracking only)

```
~/Desktop/openclaw/
└── (no source code; this repo holds spec + plan + beads only)
```

---

## Phase 1 — Prerequisites & Infrastructure

### Task 1: Verify hardware and macOS baseline

**Files:** none (verification only)

- [ ] **Step 1: Check macOS version and Apple Silicon**

Run:
```bash
sw_vers && uname -m && sysctl -n hw.memsize | awk '{print $1/1024/1024/1024 " GB"}'
```

Expected output should include `arm64` and `>= 16 GB`. If `arm64` is missing or RAM < 16 GB, **stop and flag** — the spec assumes M1 16GB.

- [ ] **Step 2: Verify Homebrew is installed**

Run:
```bash
brew --version
```

Expected: `Homebrew 4.x.x` or newer. If missing:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- [ ] **Step 3: Verify FileVault is enabled (security baseline for `.env`)**

Run:
```bash
fdesetup status
```

Expected: `FileVault is On.` If `Off`, warn the user but proceed (they may enable it later via System Settings).

---

### Task 2: Install Node.js 22+ via Homebrew

**Files:** none

- [ ] **Step 1: Install Node.js**

Run:
```bash
brew install node@22
brew link --force --overwrite node@22
```

- [ ] **Step 2: Verify Node version**

Run:
```bash
node --version
```

Expected: `v22.x.x` or newer (OpenClaw requires `Node 22.16+` minimum, `Node 24` recommended).

- [ ] **Step 3: Verify npm**

Run:
```bash
npm --version
```

Expected: `10.x.x` or newer.

---

### Task 3: Install Ollama and pull baseline models

**Files:** none (model files land in `~/.ollama/`)

- [ ] **Step 1: Install Ollama**

Run:
```bash
brew install ollama
```

- [ ] **Step 2: Start Ollama as a service (auto-start at boot)**

Run:
```bash
brew services start ollama
```

Expected: `Successfully started ollama` and `brew services list` shows `ollama  started`.

- [ ] **Step 3: Verify Ollama is responding on port 11434**

Run:
```bash
curl -s http://127.0.0.1:11434/api/tags | head -c 200
```

Expected: a JSON object like `{"models":[]}` (or with models if any are already pulled).

- [ ] **Step 4: Pull `qwen2.5:14b` (default `quality` model, ~9GB)**

Run:
```bash
ollama pull qwen2.5:14b
```

Expected: progress bars; final line `success`. This downloads ~9GB and takes 5-15 minutes depending on connection.

- [ ] **Step 5: Pull `llama3.1:8b` (default `fast` model, ~5GB)**

Run:
```bash
ollama pull llama3.1:8b
```

Expected: progress bars; `success`. Downloads ~5GB.

- [ ] **Step 6: Smoke-test inference**

Run:
```bash
ollama run qwen2.5:14b "Reply with the single word: ready"
```

Expected: `ready` (model takes ~10-30s to load on first call, then ~3-5s for generation).

---

### Task 4: Install OpenClaw

**Files:** `~/.openclaw/openclaw.json` (created by onboarding)

- [ ] **Step 1: Install OpenClaw globally**

Run:
```bash
npm install -g openclaw@latest
```

Expected: completes without errors. `openclaw --version` returns the installed version.

- [ ] **Step 2: Run onboarding to install daemon**

Run:
```bash
openclaw onboard --install-daemon
```

This is **interactive** in OpenClaw — it will prompt for default LLM provider, etc. **Choose Ollama** (or whatever the prompt phrasing equivalent is). When asked about the default model, enter `qwen2.5:14b`.

Expected at end: launchd plist installed at `~/Library/LaunchAgents/ai.openclaw.gateway.plist`, daemon started.

- [ ] **Step 3: Verify daemon is up**

Run:
```bash
openclaw gateway status
```

Expected: a green "running" indicator with port `18789`. If not, check `~/.openclaw/openclaw.json` exists and re-run `openclaw onboard --install-daemon`.

- [ ] **Step 4: Run `openclaw doctor`**

Run:
```bash
openclaw doctor
```

Expected: at minimum, no errors. Warnings about missing channels (telegram not configured yet) are OK and expected.

---

## Phase 2 — Workspace Skeleton

### Task 5: Create the `~/openclaw-drafts/` state tree

**Files:** create directory tree as listed in §7.1 of spec

- [ ] **Step 1: Create directories**

Run:
```bash
mkdir -p ~/openclaw-drafts/{pending,approved,rejected,superseded,whitelist/transcript-cache,whitelist/audio-cache,pexels-cache,logs}
```

- [ ] **Step 2: Touch initial log files**

Run:
```bash
touch ~/openclaw-drafts/logs/{agent,router,rejections,errors}.jsonl
```

- [ ] **Step 3: Verify tree**

Run:
```bash
find ~/openclaw-drafts -type d | sort && echo "---" && ls ~/openclaw-drafts/logs/
```

Expected: 8 directories listed; 4 `.jsonl` files in `logs/`.

---

### Task 6: Create workspace `.env` and `.gitignore`

**Files:**
- Create: `~/.openclaw/workspace/.env`
- Create: `~/.openclaw/workspace/.gitignore`

- [ ] **Step 1: Create `.env` with placeholders**

Write to `~/.openclaw/workspace/.env`:

```bash
# Telegram (set in Task 11)
TG_BOT_TOKEN=

# LLM providers (only the ones you use)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Stock media (set when needed for slideshow mode in Plan C)
PEXELS_API_KEY=
```

- [ ] **Step 2: Lock down `.env` permissions**

Run:
```bash
chmod 600 ~/.openclaw/workspace/.env
ls -la ~/.openclaw/workspace/.env
```

Expected: `-rw-------  1 vividadmin  staff  ...  .env`

- [ ] **Step 3: Create `.gitignore`**

Write to `~/.openclaw/workspace/.gitignore`:

```
.env
*-cache/
pending/
approved/
rejected/
superseded/
logs/
node_modules/
```

(This protects the workspace if the user later does `git init` inside it.)

---

### Task 7: Create the five config files

**Files:**
- Create: `~/.openclaw/workspace/config/providers.yaml`
- Create: `~/.openclaw/workspace/config/telegram.yaml`
- Create: `~/.openclaw/workspace/config/sources.yaml`
- Create: `~/.openclaw/workspace/config/niches.yaml`
- Create: `~/.openclaw/workspace/config/cron.yaml`

- [ ] **Step 1: Create config directory**

Run:
```bash
mkdir -p ~/.openclaw/workspace/config
```

- [ ] **Step 2: Create `providers.yaml`** (copy verbatim from spec §7.2)

Write to `~/.openclaw/workspace/config/providers.yaml`:

```yaml
default_mode: local
current_mode: local

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

- [ ] **Step 3: Create `telegram.yaml`**

Write to `~/.openclaw/workspace/config/telegram.yaml`:

```yaml
bot_token_env: TG_BOT_TOKEN
dm_policy: pairing
paired_user_id: null
quiet_hours:
  start: "22:00"
  end: "08:00"
  timezone: auto
batch_quiet_drafts: true
```

- [ ] **Step 4: Create `sources.yaml`** (empty list — populated in Plan C)

Write to `~/.openclaw/workspace/config/sources.yaml`:

```yaml
sources: []
```

- [ ] **Step 5: Create `niches.yaml`** (verbatim from spec §7.2)

Write to `~/.openclaw/workspace/config/niches.yaml`:

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

- [ ] **Step 6: Create `cron.yaml`** (empty — populated in Plan D)

Write to `~/.openclaw/workspace/config/cron.yaml`:

```yaml
jobs: []
```

- [ ] **Step 7: Verify all configs parse as valid YAML**

Run:
```bash
node -e "const yaml=require('js-yaml'),fs=require('fs');for (const f of ['providers','telegram','sources','niches','cron']) { yaml.load(fs.readFileSync(\`/Users/vividadmin/.openclaw/workspace/config/\${f}.yaml\`,'utf8')); console.log(f,'OK'); }"
```

Expected:
```
providers OK
telegram OK
sources OK
niches OK
cron OK
```

If any fail, fix the YAML before proceeding. (`js-yaml` may need `npm install -g js-yaml` first.)

---

### Task 8: Create stub `AGENTS.md`, `SOUL.md`, `TOOLS.md`

**Files:**
- Create: `~/.openclaw/workspace/AGENTS.md`
- Create: `~/.openclaw/workspace/SOUL.md`
- Create: `~/.openclaw/workspace/TOOLS.md`

These three files get injected into the conversational agent's context per OpenClaw convention. For Plan A we just need stubs so the daemon doesn't complain; the meaningful content is authored in Plan B (when the conversational surface goes live).

- [ ] **Step 1: Create `AGENTS.md`**

Write to `~/.openclaw/workspace/AGENTS.md`:

```markdown
# OpenClaw Content Agent

You are the control surface for a personal content-drafting agent.

## Your responsibilities

- Respond to slash commands from the paired Telegram user
- Surface daily content drafts for human approval (this functionality lands in Plan B)
- Report status, errors, and metrics on request

## Your hard rules

- Never publish anywhere — every draft requires explicit human approval via Telegram button
- Never invoke skills that act on third-party platforms (Instagram, YouTube, etc.) until follow-on epics E3-E5 are explicitly enabled
- Never escalate spend silently; mode changes always go via the `/mode` command (Plan B)

## Skills available

(Populated as skills are added. Plan A adds: `provider-router`.)
```

- [ ] **Step 2: Create `SOUL.md`** (intentionally minimal — brand voice gets iterated in Plan C)

Write to `~/.openclaw/workspace/SOUL.md`:

```markdown
# Voice & tone (placeholder — will be tuned in Plan C)

Direct, useful, no fluff. Short sentences. No emojis in user-facing copy unless the user explicitly asks for them.
```

- [ ] **Step 3: Create `TOOLS.md`**

Write to `~/.openclaw/workspace/TOOLS.md`:

```markdown
# Built-in tools (OpenClaw provided)

- `bash`, `process`, `read`, `write`, `edit` — workspace-sandboxed by default
- `browser` — for web research (used in Plan C)
- `cron` — schedule definitions consumed from `config/cron.yaml`

# Custom tools (skills we author)

- `provider-router` — route LLM calls based on current mode and task class. Returns `{text, tokensIn, tokensOut, latencyMs, providerUsed}`.

(More tools added in Plans B/C/D.)
```

---

## Phase 3 — Telegram Bot Setup & Pairing

### Task 9: Create the Telegram bot via @BotFather

**Files:** none on the laptop yet (token comes back to user)

> **⚠️ This task requires user action on a phone or Telegram desktop client. The agent cannot do this autonomously.**

- [ ] **Step 1: User opens Telegram, searches for `@BotFather`, starts a chat, sends `/newbot`**

User will be prompted for:
- A **display name** (e.g., "OpenClaw Content Bot")
- A **username** (must end in `bot`, e.g., `oc_content_user_bot`)

@BotFather replies with a token like `8123456789:AAFG7-jJp...`.

- [ ] **Step 2: Save the token to `.env`**

User runs (replacing `<token>`):
```bash
sed -i '' "s|^TG_BOT_TOKEN=.*|TG_BOT_TOKEN=<token>|" ~/.openclaw/workspace/.env
chmod 600 ~/.openclaw/workspace/.env
```

- [ ] **Step 3: Verify token is set**

Run:
```bash
grep -c '^TG_BOT_TOKEN=.\+$' ~/.openclaw/workspace/.env
```

Expected: `1`. If `0`, the sed replacement didn't take — the user should manually edit the file.

- [ ] **Step 4: Optional — disable BotFather defaults for privacy**

In @BotFather chat: `/setjoingroups` → select bot → `Disable` (bot stays DM-only).

---

### Task 10: Configure OpenClaw to use the Telegram channel

**Files:**
- Already exists: `~/.openclaw/workspace/config/telegram.yaml` (from Task 7)

- [ ] **Step 1: Restart the OpenClaw daemon to pick up new env**

Run:
```bash
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load   ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

(Alternative if OpenClaw provides it: `openclaw gateway restart`.)

- [ ] **Step 2: Verify daemon picked up `TG_BOT_TOKEN`**

Run:
```bash
openclaw gateway status
```

Expected: telegram channel listed as `ready` or `connected`. If `not configured`, the env var didn't propagate — check the launchd plist references the workspace `.env` (it should by default after `openclaw onboard`).

- [ ] **Step 3: Verify bot is reachable**

Run:
```bash
TOKEN=$(grep '^TG_BOT_TOKEN=' ~/.openclaw/workspace/.env | cut -d= -f2)
curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | head -c 300
```

Expected: JSON `{"ok":true,"result":{"id":...,"is_bot":true,"username":"oc_content_..."}}`.

If `"ok":false` — token is wrong or Telegram is unreachable.

---

### Task 11: Pair the bot to the user

**Files:**
- Modify: `~/.openclaw/workspace/config/telegram.yaml` (set `paired_user_id`)

- [ ] **Step 1: User opens Telegram, finds their bot by username, sends `/start`**

Bot replies with a pairing code (OpenClaw's built-in pairing flow per `dmPolicy: pairing`).

- [ ] **Step 2: From the laptop terminal, approve the pairing**

User runs (replacing `<code>` with the code from step 1):
```bash
openclaw pairing approve telegram <code>
```

Expected: `Pairing approved for user <user_id>`.

- [ ] **Step 3: Persist the paired user ID**

Read the user ID from the previous command's output and write it to `telegram.yaml`:

```bash
USER_ID=<user_id_from_step_2>
sed -i '' "s|^paired_user_id:.*|paired_user_id: ${USER_ID}|" ~/.openclaw/workspace/config/telegram.yaml
```

Verify:
```bash
grep paired_user_id ~/.openclaw/workspace/config/telegram.yaml
```
Expected: `paired_user_id: 123456789` (a numeric ID, not `null`).

- [ ] **Step 4: Sanity-check pairing by sending a test message via API**

Run:
```bash
TOKEN=$(grep '^TG_BOT_TOKEN=' ~/.openclaw/workspace/.env | cut -d= -f2)
USER_ID=$(grep paired_user_id ~/.openclaw/workspace/config/telegram.yaml | awk '{print $2}')
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${USER_ID}" \
  -d "text=Pairing complete. Plan A foundation deploying..."
```

Expected: `{"ok":true,"result":{...}}` AND user receives the message in Telegram.

---

## Phase 4 — `provider-router` Skill (TDD)

### Task 12: Scaffold the skill package

**Files:**
- Create: `~/.openclaw/workspace/skills/provider-router/SKILL.md`
- Create: `~/.openclaw/workspace/skills/provider-router/package.json`
- Create: `~/.openclaw/workspace/skills/provider-router/.gitignore`
- Create: `~/.openclaw/workspace/skills/provider-router/lib/load-config.js`

- [ ] **Step 1: Create skill directory tree**

Run:
```bash
mkdir -p ~/.openclaw/workspace/skills/provider-router/{providers,lib,tests}
cd ~/.openclaw/workspace/skills/provider-router
```

- [ ] **Step 2: Create `SKILL.md`** (description for OpenClaw's skill discovery)

Write to `~/.openclaw/workspace/skills/provider-router/SKILL.md`:

```markdown
---
name: provider-router
description: Route LLM completion calls to providers (Ollama, Anthropic, ...) based on the current mode and task class. Supports retry, fallback-down-the-tier, and per-day spend caps.
---

# provider-router

The single entrypoint for any LLM call in this workspace. Skills MUST go through this router, never call providers directly.

## Usage from another skill

```js
import { complete } from "../provider-router/router.js";

const { text, tokensIn, tokensOut, providerUsed, latencyMs } = await complete({
  taskClass: "write",          // bulk-classify | extract | reason | write
  prompt: "Write a 60s YouTube short script about ...",
  maxTokens: 800,
  temperature: 0.7
});
```

## CLI usage (for manual testing)

```
openclaw skills run provider-router --task-class write --prompt "say hello"
```

## Modes

`local` (default) — Ollama for everything. `hybrid` — Ollama for cheap classes, Anthropic for `reason`/`write`. `premium` — Anthropic for everything.

Modes mutate `current_mode` in `~/.openclaw/workspace/config/providers.yaml`. Persisted across daemon restarts. Switched via the `/mode` Telegram command (added in Plan B).

## Spend cap

Hard cap (default $1/day, configurable in `providers.yaml`). When hit, the router auto-reverts to `local` for the rest of the day.

## Adding a provider

1. Create `providers/<name>.js` exporting `{ name, complete, health }`.
2. Add a `providers.<name>` entry to `providers.yaml`.
3. Reference it from one or more `modes.<mode>.<task-class>` entries.

No router code changes needed.
```

- [ ] **Step 3: Create `package.json`**

Write to `~/.openclaw/workspace/skills/provider-router/package.json`:

```json
{
  "name": "provider-router",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "nock": "^13.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 4: Create `.gitignore`** (don't commit `node_modules/` from this skill)

Write to `~/.openclaw/workspace/skills/provider-router/.gitignore`:

```
node_modules/
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router
npm install
```

Expected: `node_modules/` populated, no errors. Vitest, nock, anthropic-sdk, js-yaml all present.

- [ ] **Step 6: Create `lib/load-config.js`** (small helper used by router and tests)

Write to `~/.openclaw/workspace/skills/provider-router/lib/load-config.js`:

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export const CONFIG_PATH = join(
  homedir(),
  ".openclaw",
  "workspace",
  "config",
  "providers.yaml"
);

export function loadConfig(path = CONFIG_PATH) {
  return yaml.load(readFileSync(path, "utf8"));
}
```

- [ ] **Step 7: Commit the scaffold**

Run from the project repo (`~/Desktop/openclaw`):
```bash
cd ~/Desktop/openclaw
# These files live OUTSIDE the repo by design (in ~/.openclaw/workspace/),
# so we commit only the spec/plan in this repo. The skill code is created
# in-place. To keep a portable copy in version control, we sync it here:
mkdir -p workspace-mirror/skills/provider-router
cp -R ~/.openclaw/workspace/skills/provider-router/{SKILL.md,package.json,lib} workspace-mirror/skills/provider-router/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): scaffold skill package + SKILL.md + load-config helper"
```

> **Decision recorded inline:** We mirror the workspace into the repo at `workspace-mirror/` for version-controllability. The live workspace stays at `~/.openclaw/workspace/` because that's where OpenClaw expects it. A small sync script can be added later if mirroring is annoying. (Skipping it for Plan A — manual sync each commit is fine for one developer.)

---

### Task 13: Implement Ollama adapter (TDD)

**Files:**
- Create: `~/.openclaw/workspace/skills/provider-router/providers/ollama.js`
- Create: `~/.openclaw/workspace/skills/provider-router/tests/ollama.test.js`

- [ ] **Step 1: Write the failing test**

Write to `~/.openclaw/workspace/skills/provider-router/tests/ollama.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import ollamaAdapter from "../providers/ollama.js";

describe("ollama adapter", () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  test("complete() POSTs to /api/chat and returns text + token counts", async () => {
    nock("http://127.0.0.1:11434")
      .post("/api/chat", body =>
        body.model === "qwen2.5:14b" &&
        body.messages?.[0]?.content === "say hello"
      )
      .reply(200, {
        model: "qwen2.5:14b",
        message: { role: "assistant", content: "Hello." },
        prompt_eval_count: 4,
        eval_count: 3,
      });

    const result = await ollamaAdapter.complete({
      taskClass: "write",
      prompt: "say hello",
      model: "qwen2.5:14b",
      baseUrl: "http://127.0.0.1:11434",
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(result.text).toBe("Hello.");
    expect(result.tokensIn).toBe(4);
    expect(result.tokensOut).toBe(3);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("complete() throws on HTTP 5xx", async () => {
    nock("http://127.0.0.1:11434").post("/api/chat").reply(500, "boom");
    await expect(
      ollamaAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "qwen2.5:14b",
        baseUrl: "http://127.0.0.1:11434",
      })
    ).rejects.toThrow(/500|boom/i);
  });

  test("health() returns ok:true when /api/tags responds", async () => {
    nock("http://127.0.0.1:11434").get("/api/tags").reply(200, { models: [] });
    const h = await ollamaAdapter.health({ baseUrl: "http://127.0.0.1:11434" });
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
  });

  test("health() returns ok:false when unreachable", async () => {
    nock("http://127.0.0.1:11434").get("/api/tags").replyWithError("ECONNREFUSED");
    const h = await ollamaAdapter.health({ baseUrl: "http://127.0.0.1:11434" });
    expect(h.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/ollama.test.js
```

Expected: FAIL with "Cannot find module '../providers/ollama.js'" or similar import error.

- [ ] **Step 3: Implement the Ollama adapter**

Write to `~/.openclaw/workspace/skills/provider-router/providers/ollama.js`:

```js
const adapter = {
  name: "ollama",

  async complete({
    taskClass,
    prompt,
    model,
    baseUrl,
    maxTokens = 1024,
    temperature = 0.7,
  }) {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    return {
      text: json?.message?.content ?? "",
      tokensIn: json?.prompt_eval_count ?? 0,
      tokensOut: json?.eval_count ?? 0,
      latencyMs: Date.now() - started,
    };
  },

  async health({ baseUrl }) {
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      return { ok: res.ok, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  },
};

export default adapter;
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/ollama.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Smoke-test against real local Ollama**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && node -e "
import('./providers/ollama.js').then(async ({default: o}) => {
  const r = await o.complete({
    taskClass: 'write',
    prompt: 'reply with the single word: ready',
    model: 'qwen2.5:14b',
    baseUrl: 'http://127.0.0.1:11434',
    maxTokens: 10,
  });
  console.log(JSON.stringify(r, null, 2));
});
"
```

Expected: JSON output with `text` containing "ready" (or close), `tokensIn > 0`, `tokensOut > 0`, `latencyMs` in the range of seconds (~3000-30000ms depending on model warm-up state).

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
mkdir -p workspace-mirror/skills/provider-router/{providers,tests}
cp ~/.openclaw/workspace/skills/provider-router/providers/ollama.js workspace-mirror/skills/provider-router/providers/
cp ~/.openclaw/workspace/skills/provider-router/tests/ollama.test.js workspace-mirror/skills/provider-router/tests/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): add Ollama adapter (TDD, 4 tests)"
```

---

### Task 14: Implement Anthropic adapter (TDD)

**Files:**
- Create: `~/.openclaw/workspace/skills/provider-router/providers/anthropic.js`
- Create: `~/.openclaw/workspace/skills/provider-router/tests/anthropic.test.js`

- [ ] **Step 1: Write the failing test**

Write to `~/.openclaw/workspace/skills/provider-router/tests/anthropic.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import anthropicAdapter from "../providers/anthropic.js";

describe("anthropic adapter", () => {
  beforeEach(() => {
    nock.cleanAll();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });
  afterEach(() => {
    nock.cleanAll();
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("complete() POSTs to /v1/messages and returns text + token counts", async () => {
    nock("https://api.anthropic.com")
      .post("/v1/messages", body =>
        body.model === "claude-sonnet-4-6" &&
        body.messages?.[0]?.content === "say hello"
      )
      .reply(200, {
        id: "msg_test",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello there." }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });

    const result = await anthropicAdapter.complete({
      taskClass: "write",
      prompt: "say hello",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(result.text).toBe("Hello there.");
    expect(result.tokensIn).toBe(5);
    expect(result.tokensOut).toBe(3);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("complete() throws clearly on missing API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      anthropicAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test("complete() throws on HTTP 401 with auth-fail message", async () => {
    nock("https://api.anthropic.com")
      .post("/v1/messages")
      .reply(401, { error: { type: "authentication_error", message: "invalid x-api-key" } });
    await expect(
      anthropicAdapter.complete({
        taskClass: "write",
        prompt: "x",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      })
    ).rejects.toThrow(/401|auth/i);
  });

  test("health() returns ok:true on a tiny test call (mocked 200)", async () => {
    nock("https://api.anthropic.com")
      .post("/v1/messages")
      .reply(200, {
        id: "msg_h",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const h = await anthropicAdapter.health({
      apiKeyEnv: "ANTHROPIC_API_KEY",
      probeModel: "claude-haiku-4-5",
    });
    expect(h.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/anthropic.test.js
```

Expected: FAIL with "Cannot find module '../providers/anthropic.js'".

- [ ] **Step 3: Implement the Anthropic adapter**

Write to `~/.openclaw/workspace/skills/provider-router/providers/anthropic.js`:

```js
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const adapter = {
  name: "anthropic",

  async complete({
    taskClass,
    prompt,
    model,
    apiKeyEnv,
    maxTokens = 1024,
    temperature = 0.7,
  }) {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} is not set in environment`);
    }

    const started = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const text = (json?.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    return {
      text,
      tokensIn: json?.usage?.input_tokens ?? 0,
      tokensOut: json?.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  },

  async health({ apiKeyEnv, probeModel = "claude-haiku-4-5" }) {
    const started = Date.now();
    try {
      await this.complete({
        taskClass: "bulk-classify",
        prompt: "ok",
        model: probeModel,
        apiKeyEnv,
        maxTokens: 1,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  },
};

export default adapter;
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/anthropic.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
cp ~/.openclaw/workspace/skills/provider-router/providers/anthropic.js workspace-mirror/skills/provider-router/providers/
cp ~/.openclaw/workspace/skills/provider-router/tests/anthropic.test.js workspace-mirror/skills/provider-router/tests/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): add Anthropic adapter (TDD, 4 tests)"
```

---

### Task 15: Implement the router with mode/task-class routing (TDD)

**Files:**
- Create: `~/.openclaw/workspace/skills/provider-router/router.js`
- Create: `~/.openclaw/workspace/skills/provider-router/tests/router.test.js`

- [ ] **Step 1: Write the failing test**

Write to `~/.openclaw/workspace/skills/provider-router/tests/router.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: local
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
    models: { fast: llama3.1:8b, quality: qwen2.5:14b }
  anthropic:
    adapter: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models: { cheap: claude-haiku-4-5, quality: claude-sonnet-4-6 }
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
`;

let tmp, configPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "router-"));
  configPath = join(tmp, "providers.yaml");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("router.complete", () => {
  test("local mode + write task → calls ollama with quality model", async () => {
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "hi", tokensIn: 4, tokensOut: 1, latencyMs: 12 }) };
    const anthropic = { name: "anthropic", complete: vi.fn() };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    const result = await router.complete({ taskClass: "write", prompt: "x" });

    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(ollama.complete.mock.calls[0][0]).toMatchObject({
      model: "qwen2.5:14b",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(result.text).toBe("hi");
    expect(result.providerUsed).toBe("ollama:qwen2.5:14b");
  });

  test("hybrid mode + write task → calls anthropic with quality model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const ollama = { name: "ollama", complete: vi.fn() };
    const anthropic = { name: "anthropic", complete: vi.fn().mockResolvedValue({
      text: "claude said hi", tokensIn: 5, tokensOut: 3, latencyMs: 800 }) };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    const result = await router.complete({ taskClass: "write", prompt: "x" });

    expect(anthropic.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete.mock.calls[0][0]).toMatchObject({
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(result.providerUsed).toBe("anthropic:claude-sonnet-4-6");
  });

  test("hybrid mode + bulk-classify task → calls ollama:fast (8b model)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "ok", tokensIn: 2, tokensOut: 1, latencyMs: 100 }) };
    const anthropic = { name: "anthropic", complete: vi.fn() };

    const router = createRouter({
      configPath,
      adapters: { ollama, anthropic },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    await router.complete({ taskClass: "bulk-classify", prompt: "x" });

    expect(ollama.complete.mock.calls[0][0].model).toBe("llama3.1:8b");
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  test("setMode persists current_mode to config file", async () => {
    const router = createRouter({
      configPath,
      adapters: { ollama: { name: "ollama", complete: vi.fn() }, anthropic: { name: "anthropic", complete: vi.fn() } },
      logPath: join(tmp, "router.jsonl"),
    });
    await router.setMode("hybrid");
    const fresh = createRouter({
      configPath,
      adapters: { ollama: { name: "ollama", complete: vi.fn() }, anthropic: { name: "anthropic", complete: vi.fn() } },
      logPath: join(tmp, "router.jsonl"),
    });
    expect(fresh.getMode()).toBe("hybrid");
  });

  test("unknown mode is rejected", async () => {
    const router = createRouter({
      configPath,
      adapters: { ollama: {complete:vi.fn()}, anthropic: {complete:vi.fn()} },
      logPath: join(tmp, "router.jsonl"),
    });
    await expect(router.setMode("nonsense")).rejects.toThrow(/unknown mode/i);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/router.test.js
```

Expected: FAIL with "Cannot find module '../router.js'" or "createRouter is not a function".

- [ ] **Step 3: Implement the router**

Write to `~/.openclaw/workspace/skills/provider-router/router.js`:

```js
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import yaml from "js-yaml";

const TASK_CLASSES = new Set(["bulk-classify", "extract", "reason", "write"]);

export function createRouter({ configPath, adapters, logPath }) {
  let config = loadAndValidate(configPath);

  function loadAndValidate(path) {
    const c = yaml.load(readFileSync(path, "utf8"));
    if (!c?.modes?.[c.current_mode]) {
      throw new Error(`current_mode "${c?.current_mode}" not found in modes`);
    }
    return c;
  }

  function persist() {
    writeFileSync(configPath, yaml.dump(config));
  }

  function resolveTarget(taskClass) {
    if (!TASK_CLASSES.has(taskClass)) {
      throw new Error(`unknown taskClass: ${taskClass}`);
    }
    const target = config.modes[config.current_mode][taskClass];
    if (!target) {
      throw new Error(
        `no provider mapped for taskClass=${taskClass} in mode=${config.current_mode}`
      );
    }
    const [providerName, modelKey] = target.split(":");
    const providerCfg = config.providers[providerName];
    if (!providerCfg) throw new Error(`unknown provider: ${providerName}`);
    const modelName = providerCfg.models?.[modelKey];
    if (!modelName) {
      throw new Error(`unknown model key "${modelKey}" for provider ${providerName}`);
    }
    return { providerName, providerCfg, modelKey, modelName };
  }

  async function complete({ taskClass, prompt, maxTokens, temperature }) {
    const { providerName, providerCfg, modelName } = resolveTarget(taskClass);
    const adapter = adapters[providerName];
    if (!adapter) throw new Error(`no adapter registered for ${providerName}`);

    const adapterArgs = {
      taskClass,
      prompt,
      model: modelName,
      maxTokens,
      temperature,
      ...(providerCfg.base_url ? { baseUrl: providerCfg.base_url } : {}),
      ...(providerCfg.api_key_env ? { apiKeyEnv: providerCfg.api_key_env } : {}),
    };

    const ts = new Date().toISOString();
    let result, ok = true, errMsg = null;
    try {
      result = await adapter.complete(adapterArgs);
    } catch (e) {
      ok = false;
      errMsg = String(e?.message ?? e);
      logCall({ ts, providerName, modelName, taskClass, ok, errMsg });
      throw e;
    }

    const providerUsed = `${providerName}:${modelName}`;
    logCall({
      ts, providerName, modelName, taskClass, ok,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
    });
    return { ...result, providerUsed };
  }

  function logCall(entry) {
    if (!logPath) return;
    appendFileSync(logPath, JSON.stringify({ ...entry, kind: "call" }) + "\n");
  }

  return {
    complete,
    getMode: () => config.current_mode,
    async setMode(mode) {
      if (!config.modes[mode]) throw new Error(`unknown mode: ${mode}`);
      config.current_mode = mode;
      persist();
    },
    getConfig: () => structuredClone(config),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/router.test.js
```

Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
cp ~/.openclaw/workspace/skills/provider-router/router.js workspace-mirror/skills/provider-router/
cp ~/.openclaw/workspace/skills/provider-router/tests/router.test.js workspace-mirror/skills/provider-router/tests/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): add router with mode + task-class routing (TDD, 5 tests)"
```

---

### Task 16: Add spend tracking + daily cap (TDD)

**Files:**
- Create: `~/.openclaw/workspace/skills/provider-router/spend.js`
- Create: `~/.openclaw/workspace/skills/provider-router/tests/spend.test.js`
- Modify: `~/.openclaw/workspace/skills/provider-router/router.js` (integrate spend module)

- [ ] **Step 1: Write the failing test**

Write to `~/.openclaw/workspace/skills/provider-router/tests/spend.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";
import { computeCost, todaySpendUsd } from "../spend.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: hybrid
spend:
  daily_cap_usd: 0.001
  cost_per_million_tokens:
    "anthropic:claude-haiku-4-5":   { in: 0.25, out: 1.25 }
    "anthropic:claude-sonnet-4-6":  { in: 3.00, out: 15.00 }
    "ollama:*":                     { in: 0.00, out: 0.00 }
providers:
  ollama:
    adapter: ollama
    base_url: http://127.0.0.1:11434
    models: { fast: llama3.1:8b, quality: qwen2.5:14b }
  anthropic:
    adapter: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models: { cheap: claude-haiku-4-5, quality: claude-sonnet-4-6 }
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
`;

let tmp, configPath, logPath;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  tmp = mkdtempSync(join(tmpdir(), "spend-"));
  configPath = join(tmp, "providers.yaml");
  logPath = join(tmp, "router.jsonl");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("computeCost", () => {
  test("Sonnet: 1M in + 1M out = $3 + $15 = $18", () => {
    const cfg = { "anthropic:claude-sonnet-4-6": { in: 3, out: 15 } };
    expect(computeCost("anthropic:claude-sonnet-4-6", 1_000_000, 1_000_000, cfg))
      .toBeCloseTo(18, 6);
  });

  test("Ollama wildcard maps to $0", () => {
    const cfg = { "ollama:*": { in: 0, out: 0 } };
    expect(computeCost("ollama:qwen2.5:14b", 100_000, 100_000, cfg)).toBe(0);
  });
});

describe("router with spend cap", () => {
  test("calls log cost; cap enforcement reverts to local on cap-hit", async () => {
    const ollama = { name: "ollama", complete: vi.fn().mockResolvedValue({
      text: "local", tokensIn: 1, tokensOut: 1, latencyMs: 1 }) };
    const anthropic = { name: "anthropic", complete: vi.fn().mockResolvedValue({
      text: "anthropic", tokensIn: 1_000_000, tokensOut: 1_000_000, latencyMs: 1 }) };

    const router = createRouter({
      configPath, adapters: { ollama, anthropic }, logPath,
    });

    // First call uses anthropic (hybrid + write) and immediately exceeds
    // the $0.001 cap (cost = $18).
    await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(1);

    // Second call: cap is exceeded, router should auto-revert to local.
    await router.complete({ taskClass: "write", prompt: "y" });
    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete).toHaveBeenCalledTimes(1); // unchanged

    // Mode in config file should now reflect the auto-revert.
    expect(router.getMode()).toBe("local");
  });

  test("todaySpendUsd reads router.jsonl and sums today's costs", async () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(logPath, [
      JSON.stringify({ ts: `${today}T01:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-sonnet-4-6", tokensIn: 100_000, tokensOut: 100_000 }),
      JSON.stringify({ ts: `${today}T02:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-haiku-4-5", tokensIn: 100_000, tokensOut: 100_000 }),
      JSON.stringify({ ts: `2020-01-01T00:00:00Z`, kind: "call", ok: true, providerName: "anthropic", modelName: "claude-sonnet-4-6", tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ].join("\n"));
    const costs = {
      "anthropic:claude-sonnet-4-6": { in: 3, out: 15 },
      "anthropic:claude-haiku-4-5":  { in: 0.25, out: 1.25 },
    };
    const total = todaySpendUsd(logPath, costs);
    // Sonnet: 0.1*3 + 0.1*15 = 0.3 + 1.5 = 1.80
    // Haiku:  0.1*0.25 + 0.1*1.25 = 0.025 + 0.125 = 0.15
    // Total: 1.95
    expect(total).toBeCloseTo(1.95, 4);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/spend.test.js
```

Expected: FAIL — `computeCost`, `todaySpendUsd` not exported.

- [ ] **Step 3: Implement `spend.js`**

Write to `~/.openclaw/workspace/skills/provider-router/spend.js`:

```js
import { existsSync, readFileSync } from "node:fs";

export function computeCost(providerModel, tokensIn, tokensOut, costCfg) {
  // Try exact match first, then wildcard "<provider>:*".
  const provider = providerModel.split(":")[0];
  const exact = costCfg?.[providerModel];
  const wild = costCfg?.[`${provider}:*`];
  const rate = exact ?? wild;
  if (!rate) return 0;
  return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
}

export function todaySpendUsd(logPath, costCfg) {
  if (!existsSync(logPath)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let total = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.kind !== "call" || !entry.ok) continue;
    if (!entry.ts?.startsWith(today)) continue;
    const pm = `${entry.providerName}:${entry.modelName}`;
    total += computeCost(pm, entry.tokensIn ?? 0, entry.tokensOut ?? 0, costCfg);
  }
  return total;
}
```

- [ ] **Step 4: Modify `router.js` to enforce the cap**

Edit `~/.openclaw/workspace/skills/provider-router/router.js` — add this near the top (after `import yaml from "js-yaml";`):

```js
import { todaySpendUsd } from "./spend.js";
```

Then inside `createRouter`, change the `complete` function to check the cap **before** dispatch:

```js
  async function complete({ taskClass, prompt, maxTokens, temperature }) {
    // Cap enforcement: if today's spend already >= cap, force local mode for this call.
    const cap = config.spend?.daily_cap_usd ?? Infinity;
    const spent = todaySpendUsd(logPath, config.spend?.cost_per_million_tokens ?? {});
    if (spent >= cap && config.current_mode !== "local") {
      config.current_mode = "local";
      persist();
    }

    const { providerName, providerCfg, modelName } = resolveTarget(taskClass);
    // ... (rest unchanged)
```

(The full `complete` body stays as it was; only the cap-check prelude is added.)

- [ ] **Step 5: Run the test, verify it passes**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/spend.test.js
```

Expected: 4 passing tests (2 in `computeCost`, 2 in `router with spend cap`).

- [ ] **Step 6: Run ALL tests to make sure router changes didn't break anything**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test
```

Expected: all tests pass (4 ollama + 4 anthropic + 5 router + 4 spend = 17 tests).

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
cp ~/.openclaw/workspace/skills/provider-router/spend.js workspace-mirror/skills/provider-router/
cp ~/.openclaw/workspace/skills/provider-router/router.js workspace-mirror/skills/provider-router/
cp ~/.openclaw/workspace/skills/provider-router/tests/spend.test.js workspace-mirror/skills/provider-router/tests/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): add spend tracking + daily cap auto-revert (TDD, 4 tests)"
```

---

### Task 17: Add fallback semantics (retry once, fall back DOWN the tier on hard fail)

**Files:**
- Modify: `~/.openclaw/workspace/skills/provider-router/router.js`
- Create: `~/.openclaw/workspace/skills/provider-router/tests/fallback.test.js`

- [ ] **Step 1: Write the failing test**

Write to `~/.openclaw/workspace/skills/provider-router/tests/fallback.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../router.js";

const FIXTURE_YAML = `
default_mode: local
current_mode: hybrid
spend:
  daily_cap_usd: 100
  cost_per_million_tokens:
    "anthropic:claude-haiku-4-5":   { in: 0.25, out: 1.25 }
    "anthropic:claude-sonnet-4-6":  { in: 3.00, out: 15.00 }
    "ollama:*":                     { in: 0.00, out: 0.00 }
providers:
  ollama:
    adapter: ollama
    base_url: http://127.0.0.1:11434
    models: { fast: llama3.1:8b, quality: qwen2.5:14b }
  anthropic:
    adapter: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models: { cheap: claude-haiku-4-5, quality: claude-sonnet-4-6 }
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
`;

let tmp, configPath, logPath;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  tmp = mkdtempSync(join(tmpdir(), "fb-"));
  configPath = join(tmp, "providers.yaml");
  logPath = join(tmp, "router.jsonl");
  writeFileSync(configPath, FIXTURE_YAML);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("router fallback", () => {
  test("transient error → retry once → succeed: anthropic called twice, no fallback", async () => {
    let n = 0;
    const anthropic = {
      name: "anthropic",
      complete: vi.fn(async () => {
        if (++n === 1) throw new Error("anthropic HTTP 503: transient");
        return { text: "second-try", tokensIn: 1, tokensOut: 1, latencyMs: 5 };
      }),
    };
    const ollama = { name: "ollama", complete: vi.fn() };

    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(2);
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(r.text).toBe("second-try");
    expect(r.providerUsed).toBe("anthropic:claude-sonnet-4-6");
  });

  test("hard fail after retry → falls back DOWN tier (anthropic→ollama)", async () => {
    const anthropic = {
      name: "anthropic",
      complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 500: dead")),
    };
    const ollama = {
      name: "ollama",
      complete: vi.fn().mockResolvedValue({ text: "local-fallback", tokensIn: 1, tokensOut: 1, latencyMs: 10 }),
    };

    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(2);  // primary + 1 retry
    expect(ollama.complete).toHaveBeenCalledTimes(1);     // fallback
    expect(r.text).toBe("local-fallback");
    expect(r.providerUsed).toBe("ollama:qwen2.5:14b");
  });

  test("if local tier also fails, error propagates", async () => {
    const anthropic = { name: "anthropic", complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 500")) };
    const ollama = { name: "ollama", complete: vi.fn().mockRejectedValue(new Error("ollama HTTP 500")) };
    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    await expect(router.complete({ taskClass: "write", prompt: "x" })).rejects.toThrow();
  });

  test("auth error (401) → no retry → falls back immediately", async () => {
    const anthropic = {
      name: "anthropic",
      complete: vi.fn().mockRejectedValue(new Error("anthropic HTTP 401: invalid x-api-key")),
    };
    const ollama = {
      name: "ollama",
      complete: vi.fn().mockResolvedValue({ text: "local", tokensIn: 1, tokensOut: 1, latencyMs: 1 }),
    };
    const router = createRouter({ configPath, adapters: { ollama, anthropic }, logPath });
    const r = await router.complete({ taskClass: "write", prompt: "x" });
    expect(anthropic.complete).toHaveBeenCalledTimes(1);  // no retry on 401
    expect(ollama.complete).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("local");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/fallback.test.js
```

Expected: FAIL — current router has no retry/fallback logic; first error propagates immediately.

- [ ] **Step 3: Modify `router.js` to add retry + fallback**

Add this helper function inside `createRouter` (above `complete`):

```js
  function isRetryable(err) {
    const m = String(err?.message ?? "");
    // 5xx, 429, network — yes. 4xx (esp 401/403/400) — no.
    if (/HTTP (5\d\d|429)/.test(m)) return true;
    if (/HTTP 4\d\d/.test(m)) return false;
    if (/ECONN|timeout|ETIMEDOUT|fetch failed/i.test(m)) return true;
    return false;
  }

  function fallbackTarget(taskClass) {
    // Fall back DOWN the tier: anthropic → ollama. Never the reverse.
    // For MVP: hard-coded mapping. Later: model an ordered tier list per task class.
    const { providerName } = resolveTarget(taskClass);
    if (providerName === "ollama") return null;             // already at floor
    if (providerName === "anthropic") {
      const ollamaModelKey = config.modes.local[taskClass].split(":")[1]; // e.g. "quality"
      return {
        providerName: "ollama",
        modelName: config.providers.ollama.models[ollamaModelKey],
      };
    }
    return null;
  }
```

Then change the body of `complete` to use these. Replace the existing try/catch block with:

```js
  async function complete({ taskClass, prompt, maxTokens, temperature }) {
    const cap = config.spend?.daily_cap_usd ?? Infinity;
    const spent = todaySpendUsd(logPath, config.spend?.cost_per_million_tokens ?? {});
    if (spent >= cap && config.current_mode !== "local") {
      config.current_mode = "local";
      persist();
    }

    const { providerName, providerCfg, modelName } = resolveTarget(taskClass);
    const adapter = adapters[providerName];
    if (!adapter) throw new Error(`no adapter registered for ${providerName}`);

    const adapterArgs = {
      taskClass,
      prompt,
      model: modelName,
      maxTokens,
      temperature,
      ...(providerCfg.base_url ? { baseUrl: providerCfg.base_url } : {}),
      ...(providerCfg.api_key_env ? { apiKeyEnv: providerCfg.api_key_env } : {}),
    };

    const ts = new Date().toISOString();
    let result, lastErr;

    // Primary attempt + 1 retry on retryable errors.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await adapter.complete(adapterArgs);
        const providerUsed = `${providerName}:${modelName}`;
        logCall({ ts, providerName, modelName, taskClass, ok: true,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: result.latencyMs });
        return { ...result, providerUsed };
      } catch (e) {
        lastErr = e;
        logCall({ ts: new Date().toISOString(), providerName, modelName, taskClass, ok: false, errMsg: String(e?.message ?? e) });
        if (attempt === 0 && isRetryable(e)) continue;
        break;
      }
    }

    // Both attempts failed. Try fallback DOWN the tier.
    const fb = fallbackTarget(taskClass);
    if (fb) {
      const fbAdapter = adapters[fb.providerName];
      const fbProviderCfg = config.providers[fb.providerName];
      const fbArgs = {
        taskClass, prompt, model: fb.modelName, maxTokens, temperature,
        ...(fbProviderCfg.base_url ? { baseUrl: fbProviderCfg.base_url } : {}),
        ...(fbProviderCfg.api_key_env ? { apiKeyEnv: fbProviderCfg.api_key_env } : {}),
      };
      const fbTs = new Date().toISOString();
      try {
        const fbResult = await fbAdapter.complete(fbArgs);
        const providerUsed = `${fb.providerName}:${fb.modelName}`;
        logCall({ ts: fbTs, providerName: fb.providerName, modelName: fb.modelName,
          taskClass, ok: true, fallback: true,
          tokensIn: fbResult.tokensIn, tokensOut: fbResult.tokensOut, latencyMs: fbResult.latencyMs });
        return { ...fbResult, providerUsed };
      } catch (e) {
        logCall({ ts: new Date().toISOString(), providerName: fb.providerName, modelName: fb.modelName,
          taskClass, ok: false, fallback: true, errMsg: String(e?.message ?? e) });
        throw e;
      }
    }

    throw lastErr;
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test -- tests/fallback.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Run ALL tests to confirm no regressions**

Run:
```bash
cd ~/.openclaw/workspace/skills/provider-router && npm test
```

Expected: all tests pass (4 ollama + 4 anthropic + 5 router + 4 spend + 4 fallback = 21 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
cp ~/.openclaw/workspace/skills/provider-router/router.js workspace-mirror/skills/provider-router/
cp ~/.openclaw/workspace/skills/provider-router/tests/fallback.test.js workspace-mirror/skills/provider-router/tests/
git add workspace-mirror/skills/provider-router/
git commit -m "feat(provider-router): add retry + fallback-down-tier semantics (TDD, 4 tests)"
```

---

## Phase 5 — End-to-End Manual Verification

### Task 18: Manual smoke test in local mode

**Files:** none

- [ ] **Step 1: Write a small driver script for manual testing**

Write to `~/.openclaw/workspace/skills/provider-router/bin/run.js`:

```js
#!/usr/bin/env node
import { createRouter } from "../router.js";
import ollama from "../providers/ollama.js";
import anthropic from "../providers/anthropic.js";
import { CONFIG_PATH } from "../lib/load-config.js";
import { join } from "node:path";
import { homedir } from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const router = createRouter({
  configPath: CONFIG_PATH,
  adapters: { ollama, anthropic },
  logPath: join(homedir(), "openclaw-drafts", "logs", "router.jsonl"),
});

const result = await router.complete({
  taskClass: args["task-class"] ?? "write",
  prompt: args.prompt ?? "say hello",
  maxTokens: args["max-tokens"] ? Number(args["max-tokens"]) : 200,
});

console.log(JSON.stringify({ ...result, mode: router.getMode() }, null, 2));
```

Make it executable:
```bash
chmod +x ~/.openclaw/workspace/skills/provider-router/bin/run.js
```

- [ ] **Step 2: Run in local mode**

Run:
```bash
~/.openclaw/workspace/skills/provider-router/bin/run.js \
  --task-class write \
  --prompt "Reply with the single word: ready"
```

Expected:
- JSON output with `text` containing "ready" (or close)
- `providerUsed: "ollama:qwen2.5:14b"`
- `mode: "local"`
- `tokensIn`, `tokensOut > 0`
- `latencyMs` in the seconds range

- [ ] **Step 3: Inspect the spend log**

Run:
```bash
tail -1 ~/openclaw-drafts/logs/router.jsonl | jq .
```

Expected: a JSON line with `kind:"call"`, `ok:true`, `providerName:"ollama"`, `modelName:"qwen2.5:14b"`, plus token counts.

---

### Task 19: Manual smoke test in hybrid mode (only if user has an Anthropic API key)

**Files:** `~/.openclaw/workspace/.env` (set `ANTHROPIC_API_KEY`)

- [ ] **Step 1: User sets `ANTHROPIC_API_KEY`**

User runs (replacing `<key>`):
```bash
sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=<key>|" ~/.openclaw/workspace/.env
chmod 600 ~/.openclaw/workspace/.env
```

- [ ] **Step 2: Switch to hybrid mode (programmatically — `/mode` Telegram command lands in Plan B)**

Run a quick script:
```bash
node -e "
import('./router.js').then(async ({createRouter}) => {
  const ollama = await import('./providers/ollama.js').then(m=>m.default);
  const anthropic = await import('./providers/anthropic.js').then(m=>m.default);
  const { CONFIG_PATH } = await import('./lib/load-config.js');
  const r = createRouter({
    configPath: CONFIG_PATH,
    adapters: { ollama, anthropic },
    logPath: process.env.HOME + '/openclaw-drafts/logs/router.jsonl',
  });
  await r.setMode('hybrid');
  console.log('mode=', r.getMode());
});
" --experimental-vm-modules
```

Expected: `mode= hybrid`. Verify by checking `current_mode: hybrid` in `~/.openclaw/workspace/config/providers.yaml`.

- [ ] **Step 3: Re-run the smoke test, expect Anthropic to handle the call**

Run:
```bash
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' ~/.openclaw/workspace/.env | cut -d= -f2) \
  ~/.openclaw/workspace/skills/provider-router/bin/run.js \
  --task-class write \
  --prompt "Reply with the single word: ready"
```

Expected:
- `providerUsed: "anthropic:claude-sonnet-4-6"`
- `mode: "hybrid"`
- A short response from Claude

- [ ] **Step 4: Tail the log and confirm cost is non-zero**

Run:
```bash
tail -1 ~/openclaw-drafts/logs/router.jsonl | jq .
```

Expected: providerName `"anthropic"`, modelName `"claude-sonnet-4-6"`, non-zero token counts.

- [ ] **Step 5: Switch back to local mode**

Run:
```bash
node -e "
import('./router.js').then(async ({createRouter}) => {
  const ollama = await import('./providers/ollama.js').then(m=>m.default);
  const anthropic = await import('./providers/anthropic.js').then(m=>m.default);
  const { CONFIG_PATH } = await import('./lib/load-config.js');
  const r = createRouter({
    configPath: CONFIG_PATH,
    adapters: { ollama, anthropic },
    logPath: process.env.HOME + '/openclaw-drafts/logs/router.jsonl',
  });
  await r.setMode('local');
  console.log('mode=', r.getMode());
});
"
```

Expected: `mode= local`.

---

### Task 20: Final commit + push branch

- [ ] **Step 1: Mirror the bin script into the repo + add a top-level README explaining the mirror layout**

Run:
```bash
cd ~/Desktop/openclaw
mkdir -p workspace-mirror/skills/provider-router/bin
cp ~/.openclaw/workspace/skills/provider-router/bin/run.js workspace-mirror/skills/provider-router/bin/

cat > workspace-mirror/README.md <<'EOF'
# workspace-mirror/

Version-controlled mirror of `~/.openclaw/workspace/` (skills + configs, NOT secrets or state).

The live workspace stays at `~/.openclaw/workspace/` because OpenClaw expects it there.
This mirror exists so the agent code is in version control, reviewable, portable.

To restore from this mirror onto a fresh laptop:

  rsync -a workspace-mirror/ ~/.openclaw/workspace/
  # then re-create ~/.openclaw/workspace/.env from your password manager

Plan A populated:
  - skills/provider-router/   (full)

Plans B/C/D will populate:
  - skills/{approval,archive,research,whitelist-scan,transcribe,clip-extract,
            slideshow-draft,quotecard-draft,orchestrator,report}/

Configs (config/*.yaml) and AGENTS.md/SOUL.md/TOOLS.md should also be mirrored
manually after edits. (A `bin/sync-from-workspace.sh` script is on the roadmap.)
EOF

git add workspace-mirror/
git commit -m "docs(workspace-mirror): explain version-controlled mirror layout"
```

- [ ] **Step 2: Push the branch and open the PR (per user's git workflow memory)**

Run:
```bash
git push -u origin design/openclaw-content-agent-mvp
gh pr create \
  --title "Design + Plan A: OpenClaw Content Agent MVP foundation" \
  --body "$(cat <<'EOF'
## Summary

- Adds the full MVP design spec under `docs/superpowers/specs/`
- Adds Plan A (Foundation) implementation plan under `docs/superpowers/plans/`
- Plan A scope: infra setup, OpenClaw daemon, Telegram pairing, and the `provider-router` skill (Ollama default, Anthropic optional, mode-based routing, spend tracking, retry + fallback-down-tier)

## Plans B/C/D (deferred to follow-on PRs)

- B — approval + archive skills + `/mode` Telegram command
- C — research, whitelist-scan, transcribe, clip-extract, slideshow-draft, quotecard-draft skills
- D — orchestrator + report + cron wiring + full daily-loop e2e

## Test plan

- [ ] Plan A walkthrough completes Tasks 1-20 end-to-end on M1 16GB laptop
- [ ] All 21 vitest tests pass: `cd workspace-mirror/skills/provider-router && npm install && npm test`
- [ ] Smoke test (Task 18) returns "ready" via `ollama:qwen2.5:14b`
- [ ] (Optional) Smoke test in hybrid mode (Task 19) returns response via `anthropic:claude-sonnet-4-6`
- [ ] Spend log (`~/openclaw-drafts/logs/router.jsonl`) has correct entries
EOF
)"
```

Expected: PR URL printed; visible on GitHub.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-04-16-openclaw-content-agent-design.md`):

- §1 Goal/scope — covered (Plan A scope is foundation; Plans B/C/D explicitly deferred)
- §2 Daily loop — N/A in Plan A (Plan D)
- §3.1 Component diagram — daemon + router skill installed (Tasks 4, 12-17)
- §3.2 Skill catalog — `provider-router` fully implemented; others deferred to B/C/D ✓
- §3.3 External deps — Ollama, OpenClaw installed (Tasks 3, 4); FFmpeg/whisper-cpp/yt-dlp/Pillow deferred to Plan C
- §4 Provider abstraction — fully covered (Tasks 12-17). Routing matrix, retry, fallback-down-tier, spend cap, persistence — all implemented and tested ✓
- §5 Draft schema — N/A in Plan A (no drafts produced; Plan B)
- §6 Telegram protocol — pairing only (Tasks 9-11); messaging + state machine deferred to Plan B ✓
- §7 Storage — directory tree created (Task 5), all 5 config files created (Task 7), `.env` set up (Task 6) ✓
- §8 Failure modes — Ollama-down, Anthropic-down, retry, fallback, spend cap, auth-failure all tested in Tasks 16-17 ✓
- §9 Security — `.env` chmod 0600 (Task 6), `dmPolicy: pairing` (Tasks 7, 11), no public ports (default OpenClaw config) ✓
- §10 Roadmap — out of scope for any implementation plan (just a beads epic list)

**Placeholder scan:** No "TBD"/"TODO"/"implement later" markers remain. The "stub" `AGENTS.md`/`SOUL.md`/`TOOLS.md` (Task 8) are explicitly marked as Plan A stubs that get expanded in Plans B/C, with the actual minimal content provided so they exist on disk.

**Type consistency:**
- `complete({ taskClass, prompt, model, baseUrl?, apiKeyEnv?, maxTokens?, temperature? })` — same shape across `ollama.js`, `anthropic.js`, router dispatch ✓
- `{ text, tokensIn, tokensOut, latencyMs }` return shape — same across both adapters ✓
- Router adds `providerUsed` to that — only in router output, never required of adapters ✓
- `health({ baseUrl?, apiKeyEnv?, probeModel? })` — both adapters export it ✓
- `createRouter({ configPath, adapters, logPath })` — same signature in all 5 test files ✓
- `setMode` / `getMode` / `getConfig` — referenced consistently ✓

No drift detected.

---

## Plan A Done — What Plans B/C/D Will Cover

To be filed as beads epics M1, M2, M3 alongside this plan:

**M1 (Plan B) — Approval pipeline (~12-15 tasks):**
- `approval` skill (Telegram message templates, inline-keyboard callbacks, force_reply for MODIFY/REJECT)
- `archive` skill (move drafts between status folders, redeliver Template B on APPROVE)
- State persistence in `pending/<id>/state.json`
- `/mode`, `/spend`, `/status`, `/whoami`, `/help` slash commands wired in `approval`
- Quiet-hours batching
- E2E test: hand-craft a fake Draft on disk → trigger `approval` → DM appears → tap Approve → archived + redelivered

**M2 (Plan C) — Three content modes (~30-40 tasks across 6 skills):**
- `research` (RSS + browser web-search, niche filtering)
- `whitelist-scan` (yt-dlp polling, dedup)
- `transcribe` (Whisper.cpp wrapper)
- `clip-extract` (LLM moment-detection, FFmpeg vertical cut + burned captions)
- `slideshow-draft` (LLM script, Pexels stock matching, storyboard JSON output)
- `quotecard-draft` (LLM quote extraction, Pillow render)
- Each skill: TDD tests + manual smoke test producing one real Draft on disk
- Add 5-10 verified clip-permitted sources to `sources.yaml`

**M3 (Plan D) — Orchestration (~10-12 tasks):**
- `orchestrator` skill (mode selection rule from spec §3.2)
- `report` skill (nightly digest)
- Wire `cron.yaml` (3 jobs: 09:00, 13:00, 23:00 + Sunday 04:00 prune)
- E2E daily-loop dry-run: trigger manually, observe 3 drafts produced, approve each, observe redelivery
- Documentation: README on operating the bot day-to-day

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-plan-a-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because Plan A spans many small independent tasks (install, configure, TDD cycles) and a clean per-task subagent context avoids drift.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster wall-clock but my context fills up with shell output from installs.

**Which approach?**
