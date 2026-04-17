# M3: Orchestration & Scheduling — Design

**Date:** 2026-04-17
**Status:** Approved, ready for writing-plans
**Parent spec:** [2026-04-16-openclaw-content-agent-design.md](2026-04-16-openclaw-content-agent-design.md)
**Predecessor:** [2026-04-16-m2-content-generation-design.md](2026-04-16-m2-content-generation-design.md)
**Beads issue:** openclaw-c8y
**Branch:** `feat/plan-d-orchestration-scheduling` (to be created)

---

## 1. Goal & Scope

### Goal

Ship the orchestrator skill, the report skill, and the cron provisioning step so the M2 pipeline runs unattended on a daily schedule. The orchestrator is the **join** between `research` (topic discovery), the whitelist/transcript cache, and the three draft-producing skills. The report is the end-of-day mirror.

### Deltas from parent spec

| Change | Why |
|---|---|
| **Scheduling mechanism: `openclaw cron` via a provisioning script**, not hand-installed launchd plists. | The parent spec assumed OpenClaw's built-in cron would consume `cron.yaml`. OpenClaw ships a Gateway-backed scheduler CLI (`openclaw cron add/list/rm/runs`), but it is managed imperatively — not by watching a yaml. Resolution: `scripts/install-cron.mjs` reads `cron.yaml` and idempotently syncs it into OpenClaw's scheduler. `cron.yaml` stays the committed source of truth. |
| **Topic↔episode matching: hybrid (keyword prefilter → LLM)**, not raw LLM and not pure keyword. | Pure LLM is overkill for ≤5 topics × ~10 episodes; pure keyword misses paraphrase. Hybrid caps the LLM prompt to 3 candidates (cheap + robust). Fallback to keyword top-1 when LLM fails. |
| **Quiet-hours: per-job policy**, not blanket defer. | Content drafts produced during quiet-hours get their DM deferred to an 08:00 digest (content work is time-sensitive; delivery isn't). The nightly report is exempt — its whole purpose is end-of-day reflection, so it fires at 23:00 regardless of quiet-hours. |
| **Failure-handling: best-effort with one transient retry**, not all-or-nothing. | One Pexels 429 shouldn't kill the whole day. Each mode is independently `try/catch`'d; the loop records which modes were skipped and why, and the nightly report surfaces it. |
| **Topic dedupe: not tracked at orchestrator.** | `research` already ranks by freshness; if a topic is still top-ranked on day 2, that's a signal it's genuinely hot. Avoids a state file that needs manual invalidation when the user wants to re-post. |
| **Cron job count: 6, not 4.** | Parent spec listed 4 (daily-loop, scan, report, cache-prune). M2 added `source-discovery-pull` (Sundays 10:00). M3 adds `morning-flush` (08:00 daily) to drain the quiet-queue. |
| **Orchestrator is batch, not long-running.** | Each cron firing invokes `orchestrator --job=<phase>` as a fresh process; it reads state from disk, does work, exits. Matches M1/M2 skill idioms. Keeps memory discipline on a 16GB laptop and leaves scheduling fully to OpenClaw cron. |

### In scope for M3

- `skills/orchestrator/` — phases: `daily-loop`, `flush-quiet-queue`, `source-discovery-pull`
- `skills/report/` — phase: `nightly`, plus digest renderer reused by `flush-quiet-queue`
- `shared/quiet-queue.js` — append-only JSONL storage with lockfile for concurrent safety
- `scripts/install-cron.mjs` — idempotent provisioner that diffs `config/cron.yaml` against `openclaw cron list` and applies add/update/remove
- `config/cron.yaml` filled in with 6 jobs
- Extended `bin/smoke-run.js` (`--orchestrator` flag) to dry-run the daily loop end-to-end
- Per-skill Vitest tests + README smoke instructions (matching M1/M2 pattern)

### Out of scope for M3

- Adaptive mode selection (LLM-chosen mode per topic) — tuning epic, not MVP
- Topic dedupe / used-topic persistence — see rationale above
- Watchdog liveness pinging (Healthchecks.io) — E12, separate epic
- Launchd plist authoring — OpenClaw's daemon is already launchd-managed; cron jobs live inside the daemon
- Morning-digest interactive-modify from inside the digest — clicking `[Review →]` re-sends the normal M1 Template-A; the digest itself is a summary, not a compact approval UI
- Real publishing (E3/E4/E5)
- Slideshow video assembly (E2)

---

## 2. Skill Catalog

### 2.1 `skills/orchestrator/`

- **Responsibility:** Fan research → mode selection → topic↔episode matching → draft skill invocation → approval dispatch. One process per cron firing.
- **Entry points:**
  - Programmatic: `import { runDailyLoop, flushQuietQueue, runSourceDiscoveryPull } from 'orchestrator'`
  - CLI: `bin/orchestrator.js --job=daily-loop|flush-quiet-queue|source-discovery-pull [--sandbox] [--dry-run]`
- **Contract of `runDailyLoop({ clock, providerRouter, skills, approval, logger, paths })`:**
  - `clock` — injected `Date` source (enables test-time freezing)
  - `providerRouter` — from Plan A; used for topic↔episode match call
  - `skills` — object `{ research, clipExtract, slideshowDraft, quotecardDraft }` (injected for DI; default is the real skill imports)
  - `approval` — from M1; orchestrator calls `approval.sendForApproval` or queues via `quiet-queue.append`
  - `logger` — M1/M2 JSONL logger
  - `paths` — `{ workspace, drafts }` so sandbox mode can redirect
  - Returns `{ drafts: [{mode, draft_id?, ok, reason?}], durationMs, produced: N, skipped: [...] }`
- **Phases:**
  - `daily-loop` — described in §3
  - `flush-quiet-queue` — read `~/openclaw-drafts/state/quiet-queue.jsonl`, render morning-digest, send one Telegram DM with per-draft `[Review →]` buttons, truncate on success
  - `source-discovery-pull` — for each niche in `niches.yaml`, call `sourceDiscovery.pull(niche)` (M2 programmatic API); one failure per niche doesn't block others

### 2.2 `skills/report/`

- **Responsibility:** Render last-24h digest. Reused by both `nightly` (standalone DM) and by `flush-quiet-queue` (which uses the same renderer for its morning summary header).
- **Entry points:**
  - Programmatic: `import { renderDigest, sendNightlyReport } from 'report'`
  - CLI: `bin/report.js --job=nightly [--sandbox]`
- **Inputs (read-only):**
  - `~/openclaw-drafts/{pending,approved,rejected}/*` — filter by `created_at ≥ now-24h`
  - `~/openclaw-drafts/logs/router.jsonl` — filter by `ts ≥ now-24h` → spend + provider mix
  - `~/openclaw-drafts/logs/rejections.jsonl` — filter by `ts ≥ now-24h` → top rejection reason
- **Output:** one Telegram message, no buttons. If zero activity: one line *"Quiet day — no drafts produced."* Never silent.

### 2.3 `shared/quiet-queue.js`

- **API:**
  - `append({draft_id, created_at, mode, topic})` — opens `wx+` lockfile, writes JSONL line, closes
  - `drain()` — read-all, rename JSONL to `.processing.jsonl` atomically, returns `[entries]`. Caller decides when to delete. On caller success → delete `.processing.jsonl`. On caller failure → caller renames back. Prevents data loss if flush-digest-send fails midway.
  - `peek()` — read-only length/list (for report/`/status` inspection)
- **Storage:** `~/openclaw-drafts/state/quiet-queue.jsonl`
- **Concurrency:** `fs.open(lockfile, 'wx+')` per spec §2.8 pattern from `sources-store.js`.

### 2.4 `scripts/install-cron.mjs`

- Not a skill — a one-shot provisioning script under `scripts/`.
- **Invocation:** `node scripts/install-cron.mjs [--dry-run]`
- **Behavior:**
  1. Parse `~/.openclaw/workspace/config/cron.yaml` into desired state
  2. Invoke `openclaw cron list --json` via `execFile` (argv-array form, no shell) → parse current state
  3. Diff by `--name`: add missing, update changed (schedule or message), remove stale (jobs present in OpenClaw but not in yaml, only within `openclaw-managed-*` name prefix to avoid clobbering unrelated cron jobs)
  4. `--dry-run` prints the `openclaw cron add/rm/edit` invocations that would run; no process spawned
- **Naming convention:** each job's `name:` in cron.yaml gets prefixed `openclaw-managed-` when registered with OpenClaw cron, so the install script knows which jobs it owns
- **Safety note:** all shell-outs use Node's `child_process.execFile` with argv arrays — never a single command string through `exec`. User-controlled strings from `cron.yaml` (descriptions, messages) are passed as separate argv tokens, not string-interpolated into a shell line.

### 2.5 Supporting changes to existing code

- **`bin/smoke-run.js` (from M2):** add `--orchestrator` flag that invokes `runDailyLoop({ ..., paths: { drafts: '/tmp/openclaw-smoke' } })` instead of the current hardcoded pipe. Keeps M2's `--sandbox`/`--live` flags compatible.
- **`config/cron.yaml`:** fill in the 6 jobs (§4).
- **`approval/approval.js`:** no API change required. The quiet-hours decision is made in the orchestrator (§3 step 5) — it either calls `approval.sendForApproval(draft_id)` (unchanged M1 signature) or calls `quietQueue.append(...)`. The `report` skill sends its own Telegram DM directly via the shared Telegram client; it never routes through `approval/`, so the nightly-at-23:00 report fires regardless of quiet-hours without needing a bypass flag.

### 2.6 File layout per new skill

```
skills/orchestrator/
├── package.json               (type: module, vitest, engines.node: >=22)
├── index.js                   (exports runDailyLoop, flushQuietQueue, runSourceDiscoveryPull)
├── daily-loop.js              (the core; ~200 lines)
├── topic-episode-match.js     (hybrid matcher; ~80 lines)
├── bin/orchestrator.js        (#!/usr/bin/env node CLI; --job dispatcher)
├── orchestrator.test.js       (unit; DI all skills)
├── daily-loop.test.js
├── topic-episode-match.test.js
└── README.md

skills/report/
├── package.json
├── index.js                   (exports renderDigest, sendNightlyReport)
├── digest-data.js             (fs+logs readers; ~60 lines)
├── digest-render.js           (pure text formatter; ~50 lines)
├── bin/report.js              (CLI)
├── report.test.js             (unit; fixture fs + fixture logs)
└── README.md

shared/ (additions)
├── quiet-queue.js
└── quiet-queue.test.js

scripts/
└── install-cron.mjs
```

---

## 3. Daily-Loop Algorithm

```
runDailyLoop({ clock, providerRouter, skills, approval, logger, paths }):

  1. LOAD STATE
     - providers.yaml, niches.yaml, sources.yaml, telegram.yaml
     - today_drafts_by_mode = scan(paths.drafts/{pending,approved,rejected})
                                .filter(d => sameDay(d.created_at, clock.now()))
                                .groupBy('mode')
     - modes_needed = ['clip','slideshow','quotecard'].filter(m => !today_drafts_by_mode[m])
     - If modes_needed is empty: log 'all modes already produced today'; return clean

  2. RESEARCH
     - topics = []
     - for each niche in niches.yaml:
         try: topics.push(...await skills.research.run(niche))
         catch: log; continue
     - topics.sort((a,b) => b.score - a.score)
     - If topics is empty: log 'no topics today', DM optional; return clean

  3. MODE SELECTION
     - assignments = {}              // mode -> topic
     - topics_used = new Set()
     - If 'clip' in modes_needed:
         match = await matchTopicToEpisode(topics, cached_transcripts, providerRouter)
         if match: assignments.clip = match.topic; topics_used.add(match.topic.url)
     - For m in ['slideshow','quotecard'] ∩ modes_needed:
         pick = topics.find(t => !topics_used.has(t.url))
         if pick: assignments[m] = pick; topics_used.add(pick.url)
     - (It's valid for assignments to have 0, 1, 2, or 3 entries)

  4. GENERATE DRAFTS (per mode, isolated try/catch)
     - results = []
     - for (mode, topic) in assignments:
         ctx = (mode === 'clip') ? { transcript_path, source_metadata } : { niche: topic.niche }
         try:
           draft = await skills[mode].generate(topic, ctx)
           results.push({ mode, draft_id: draft.id, ok: true })
         catch err:
           if isTransient(err):
             await sleep(2000)
             try:
               draft = await skills[mode].generate(topic, ctx)
               results.push({ mode, draft_id: draft.id, ok: true })
             catch retryErr:
               results.push({ mode, ok: false, reason: retryErr.message })
               logger.errorjsonl(retryErr, { mode, phase: 'daily-loop' })
           else:
             results.push({ mode, ok: false, reason: err.message })
             logger.errorjsonl(err, { mode, phase: 'daily-loop' })

  5. APPROVAL DISPATCH
     - in_quiet = isInQuietHours(clock.now(), telegram.yaml.quiet_hours)
     - for r in results.filter(r => r.ok):
         if in_quiet:
           quietQueue.append({ draft_id: r.draft_id, ... })
         else:
           await approval.sendForApproval(r.draft_id)  // M1 flow

  6. SUMMARY
     - produced = results.filter(r => r.ok).length
     - skipped = results.filter(r => !r.ok).map(r => ({ mode: r.mode, reason: r.reason }))
              + modes_needed.filter(m => !assignments[m]).map(m => ({ mode: m, reason: 'not_selected' }))
     - logger.jsonl({ event: 'daily_loop_complete', produced, skipped, spend_today })
     - If skipped.length > 0: send summary DM ("2/3 produced; clip skipped (no matching episode)")
     - Silent on fully-successful days
```

### 3.1 Topic↔episode matching (`topic-episode-match.js`)

```
matchTopicToEpisode(topics, transcripts, router):
  // transcripts = [{ source_id, episode_id, title, duration_s, transcribed_at, summary_snippet }]
  // summary_snippet = transcript.segments.slice(0, 20).map(s => s.text).join(' ') // ~1-2 min of dialogue

  // Filter to last 7 days of transcripts (prioritize freshness)
  recent = transcripts.filter(t => daysSince(t.transcribed_at) <= 7)
  if recent.empty: return null

  // For each topic, score top-3 candidates by Jaccard(topic_keywords, episode_title+summary keywords)
  for topic in topics:
    keywords_topic = tokenize(topic.headline).stem().removeStopwords()
    candidates = recent.map(ep => {
      keywords_ep = tokenize(ep.title + ' ' + ep.summary_snippet).stem().removeStopwords()
      return { ep, score: jaccard(keywords_topic, keywords_ep) }
    }).sort(byScoreDesc).slice(0, 3)

    if candidates[0].score === 0: continue // nothing matches — try next topic

    // LLM reason over the 3
    try:
      resp = await router.complete({
        taskClass: 'reason',
        prompt: renderMatchPrompt(topic, candidates),
        schema: { best_episode_id: 'string', confidence: 'number', reasoning: 'string' }
      })
      if resp.confidence >= 0.5:
        pick = candidates.find(c => c.ep.episode_id === resp.best_episode_id)
        if pick: return { topic, episode: pick.ep, confidence: resp.confidence, via: 'llm' }
    catch:
      // fall through to keyword top-1
      pass

    // Keyword-only fallback: accept top candidate if score above threshold
    if candidates[0].score >= 0.15:
      return { topic, episode: candidates[0].ep, confidence: candidates[0].score, via: 'keyword' }

  return null  // no topic matched any episode with minimum confidence
```

The Jaccard threshold `0.15` is tunable; it's an implementation detail, not a design constant.

### 3.2 Quiet-hours check

```
isInQuietHours(now, quiet_hours):
  // quiet_hours = { start: "22:00", end: "08:00", timezone: "auto" }
  tz = resolveTimezone(quiet_hours.timezone)  // "auto" → system TZ
  local_hhmm = formatHHMM(now, tz)
  if quiet_hours.start > quiet_hours.end:   // wraps past midnight, e.g. 22:00-08:00
    return local_hhmm >= quiet_hours.start || local_hhmm < quiet_hours.end
  else:                                     // doesn't wrap, e.g. 12:00-14:00
    return local_hhmm >= quiet_hours.start && local_hhmm < quiet_hours.end
```

Lives in `shared/time.js` (new file, ~20 lines + tests).

---

## 4. Cron Catalog (`config/cron.yaml` final content)

```yaml
jobs:
  - name: daily-loop
    schedule: "0 9 * * *"
    skill: orchestrator
    args: { job: daily-loop }
    description: "Daily content-generation loop: research → 3 drafts → approval"

  - name: morning-flush
    schedule: "0 8 * * *"
    skill: orchestrator
    args: { job: flush-quiet-queue }
    description: "Drain overnight quiet-queue; send morning digest"

  - name: scan-whitelist
    schedule: "0 13 * * *"
    skill: whitelist-scan
    description: "Poll sources.yaml for new episodes; download audio+video; transcribe"

  - name: nightly-report
    schedule: "0 23 * * *"
    skill: report
    args: { job: nightly }
    description: "End-of-day digest: produced / approved / rejected / spend"

  - name: source-discovery-pull
    schedule: "0 10 * * 0"
    skill: orchestrator
    args: { job: source-discovery-pull }
    description: "Weekly candidate-channel discovery across niches"

  - name: cache-prune
    schedule: "0 4 * * 0"
    skill: archive
    args: { job: prune-cache, retain_days: 7 }
    description: "Prune audio/video/transcript caches older than N days"
```

**`archive` prune job:** the `archive` skill from M1 gets a small `bin/archive.js --job=prune-cache` phase added (~30 lines). Removes `audio-cache/*`, `video-cache/*`, `transcript-cache/*`, `pexels-cache/*` entries older than `retain_days`. Not a design concern — it's an incremental extension of an existing skill, listed here for completeness.

### 4.1 `scripts/install-cron.mjs` behavior

```
install-cron.mjs:
  desired = parseYaml('~/.openclaw/workspace/config/cron.yaml').jobs
  actual  = JSON.parse(runOpenClaw(['cron','list','--json']))
             .filter(j => j.name.startsWith('openclaw-managed-'))

  for d in desired:
    managed_name = 'openclaw-managed-' + d.name
    existing = actual.find(a => a.name === managed_name)
    cmd_argv = buildSkillInvocation(d.skill, d.args)  // returns ['node', '/abs/path/bin.js', '--job=X']
    if not existing:
      runOrPrint(['openclaw','cron','add',
                  '--name', managed_name,
                  '--cron', d.schedule,
                  '--message', JSON.stringify(cmd_argv),
                  '--description', d.description])
    else if existing.schedule !== d.schedule || existing.message !== JSON.stringify(cmd_argv):
      runOrPrint(['openclaw','cron','edit',
                  '--name', managed_name,
                  '--cron', d.schedule,
                  '--message', JSON.stringify(cmd_argv)])

  for a in actual:
    if not desired.find(d => 'openclaw-managed-' + d.name === a.name):
      runOrPrint(['openclaw','cron','rm','--name', a.name])
```

All `runOrPrint(argv)` calls use Node's `child_process.execFile(argv[0], argv.slice(1))` — never a shell string. `--dry-run` mode prints each argv array instead of spawning.

`buildSkillInvocation(skill, args)` returns an argv array like:
```
['node', '~/.openclaw/workspace/skills/orchestrator/bin/orchestrator.js', '--job=daily-loop']
```

This argv is serialized as JSON into OpenClaw cron's `--message` and unpacked on trigger.

**Alternative invocation path (considered, rejected):** using `openclaw agent` with an LLM prompt. Rejected because the agent path adds LLM-driven indirection to something that should be deterministic batch execution.

---

## 5. Build Order

```
Phase 1 — Shared (sequential, ~45 min):
  ├─ shared/quiet-queue.js + tests (lockfile + drain semantics)
  └─ shared/time.js + tests (isInQuietHours)

Phase 2 — Parallel skills (2 subagents concurrently, ~2.5 hrs):
  ├─ skills/report/ (renderDigest + sendNightlyReport, pure fs+logs readers)
  └─ skills/orchestrator/ daily-loop + topic-episode-match + CLI

Phase 3 — Provisioning + integration (sequential, ~1.5 hrs):
  ├─ archive skill: add --job=prune-cache phase
  ├─ config/cron.yaml: fill in 6 jobs
  ├─ scripts/install-cron.mjs + tests
  ├─ approval.sendForApproval({bypassQuietHours}) extension
  └─ bin/smoke-run.js: add --orchestrator flag, route through runDailyLoop()

Phase 4 — E2E validation (primary agent, ~1 hr):
  ├─ run node scripts/install-cron.mjs --dry-run; eyeball output
  ├─ run node scripts/install-cron.mjs (real); verify openclaw cron list
  ├─ manually trigger: openclaw cron run openclaw-managed-daily-loop
  ├─ verify 3 sandbox drafts appear; no real Telegram
  ├─ at real scheduled time (or via --at=+1m debug cron), verify live firing
  └─ verify quiet-queue flush: seed fake quiet entries, run morning-flush
```

### Wall-clock estimate

| Phase | Time | Notes |
|---|---|---|
| 1. Shared | ~45 min | Small, focused, must be right for downstream tests |
| 2. Parallel skills | ~2.5 hrs | 2 subagents; orchestrator is bigger than report |
| 3. Provisioning | ~1.5 hrs | install-cron.mjs has the subtle diff logic; needs good tests |
| 4. E2E | ~1 hr | Includes actually scheduling and observing one real fire |
| **Total active work** | **~5.5-6 hrs** | one long session or two shorter ones |

---

## 6. Test Strategy

### 6.1 Unit tests (TDD — write first)

**`orchestrator.test.js` cases:**
- happy path: 3 drafts produced, all sent for approval
- early exit: all modes already produced today
- research empty: exits clean, no skill invocations
- clip skipped (no matching episode): slideshow + quotecard still produced
- slideshow transient fail: retries, recovers → 3 drafts
- slideshow hard fail: skipped; clip + quotecard still produced
- all three fail: produced=0, summary DM sent
- quiet-hours: approvals routed to quiet-queue instead of sendForApproval
- topic dedupe across modes: no topic used twice in one loop
- sandbox mode: all fs writes land under `/tmp/...`
- drift detection: clock.now() - scheduled_ts > 2h → DM sent before proceeding

**`topic-episode-match.test.js`:**
- perfect keyword match (same words) — LLM confirms → `via: 'llm'`
- paraphrase match — keyword low, LLM catches — `via: 'llm'`
- LLM failure — keyword top-1 above threshold — `via: 'keyword'`
- LLM failure + keyword below threshold — returns null
- no recent transcripts — returns null

**`report.test.js`:**
- 3 drafts (1 approved / 1 modified / 1 rejected) in fixture fs → renders expected string
- quiet day (0 activity) → "Quiet day" line
- missing some log files → omits those lines, doesn't crash

**`quiet-queue.test.js`:**
- append + peek + drain round-trip
- concurrent appends (parallel `append` calls via `Promise.all`) → no lost entries
- drain-then-crash: `.processing.jsonl` remains, recoverable on next call
- drain-then-success: `.processing.jsonl` deleted

**`install-cron.test.js`:**
- add missing
- update on schedule change
- update on message change
- remove stale (not in yaml but managed prefix)
- ignore unmanaged (no `openclaw-managed-` prefix)
- `--dry-run` prints, no process spawned

**`shared/time.test.js`:**
- quiet hours wrapping midnight (22:00-08:00): inside at 23:30, inside at 03:00, outside at 09:00
- quiet hours not wrapping (12:00-14:00): inside at 13:00, outside at 11:00 and 15:00
- timezone: `auto` resolves to system TZ via `Intl.DateTimeFormat().resolvedOptions().timeZone`

### 6.2 Integration — extended `bin/smoke-run.js`

- `node bin/smoke-run.js --orchestrator --sandbox` — runs `runDailyLoop()` end-to-end against `/tmp/openclaw-smoke/`, real research + LLM calls if `OPENCLAW_LIVE=1` set, no Telegram. Expected: 2-3 drafts in `/tmp/openclaw-smoke/pending/`, one summary log line.
- `node bin/smoke-run.js --orchestrator --live` — same but `~/openclaw-drafts/` + real Telegram. Drafts get `smoke-` prefix per M2 convention.

### 6.3 Manual smoke (documented in each skill's README)

Per-skill `README.md` smoke-test section matching M1/M2 conventions. Each describes exact CLI invocation, expected outputs, verification steps.

---

## 7. Pinned Defaults

| Decision | Default | Config key |
|---|---|---|
| Clip confidence threshold (topic↔episode LLM) | 0.5 | hardcoded |
| Keyword-fallback Jaccard threshold | 0.15 | hardcoded |
| Transcript freshness window for match candidates | 7 days | hardcoded |
| Transient-retry delay | 2s | hardcoded |
| Transient-retry count | 1 | hardcoded |
| Cron-drift threshold (alert user) | 2h | hardcoded |
| Quiet-hours window | 22:00-08:00 local | `telegram.yaml` |
| Morning-flush time | 08:00 | `cron.yaml` |
| Nightly report time | 23:00 | `cron.yaml` |
| Source-discovery pull cron | Sundays 10:00 | `cron.yaml` |
| Cache-prune cron | Sundays 04:00 | `cron.yaml` |
| Cache retention | 7 days | `cron.yaml` args |
| OpenClaw cron job name prefix | `openclaw-managed-` | hardcoded in install-cron.mjs |

### LLM task-class map (for spend tracking — additions to M2)

| Skill | Call | Task class |
|---|---|---|
| orchestrator | topic↔episode match | `reason` |

Report skill makes zero LLM calls — it's pure fs+log aggregation.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **OpenClaw cron scheduler is paused / Gateway was down at trigger** | `openclaw cron runs` is inspectable; nightly report pulls run-history and flags any missed trigger in the digest. Re-running a missed job is a manual `openclaw cron run <name>` — not automated in M3 (the complexity of safe catch-up isn't worth it for a personal bot). |
| **Cron fires while laptop was asleep** | OpenClaw's cron catch-up policy handles the trigger when the laptop wakes. Orchestrator computes drift (`now - scheduled_ts`); if >2h, DMs user before running. |
| **`install-cron.mjs` clobbers unrelated cron jobs** | Name prefix `openclaw-managed-` scopes all operations. Unmanaged jobs (user's own cron jobs) are invisible to the diff. Verified in `install-cron.test.js`. |
| **`install-cron.mjs` run twice at once** | Not a real concern — it's a one-shot provisioning CLI, not daemonized. No locking added. |
| **Topic↔episode LLM returns hallucinated episode_id** | `pick = candidates.find(c => c.ep.episode_id === resp.best_episode_id)` returns `undefined` if LLM picked one not in the candidate set → fall through to keyword fallback. Silent validation. |
| **Quiet-queue corruption mid-flush** | `drain()` renames JSONL to `.processing.jsonl` atomically before returning entries. If the send fails, caller renames back via an explicit `quietQueue.putBack(entries)` API. If the caller itself crashes, `.processing.jsonl` remains on disk and is picked up on next flush (entries appear to be late but not lost). |
| **Daily-loop runs and produces drafts, but `/status` shows daemon not running** (user rebooted laptop between 09:00 fire and 09:05 check) | OpenClaw cron persists run history; `openclaw cron runs openclaw-managed-daily-loop` shows the successful fire. Orchestrator writes one `agent.jsonl` line per complete run. |
| **Spend cap hit between draft 2 and draft 3** | provider-router already auto-downgrades to `local` (Plan A behavior). Orchestrator sees a normal return from the subsequent skill calls; the drafts are produced in local mode and labeled accordingly via `provider_used` field on the Draft. |
| **Research succeeds but all draft skills fail** | Summary log records `produced=0, skipped=[3 entries]`. DM sent. Next day's loop is independent. Report nightly aggregates the failure. |
| **Topic↔episode match fails every day for a week** (no new Lex transcripts + all topics are about things Lex doesn't cover) | Clip skipped → only 2 drafts produced/day. Nightly report line *"clip mode skipped: no matching episode"* appears repeatedly — user's signal to either widen `sources.yaml` or invoke `/sources propose <url>`. Not an orchestrator bug. |
| **Morning-flush fires at 08:00, Telegram unreachable, queue not truncated** | Queue remains intact. Next manual `bin/orchestrator.js --job=flush-quiet-queue` or next 08:00 fire retries. Duplicate DM possible if partial send before Telegram disconnect — acceptable for a personal bot. |
| **Cron-yaml edit pushed without running `install-cron.mjs`** | Documented in `scripts/install-cron.mjs` README: "run this after editing cron.yaml". Could be auto-wired via a git pre-commit hook in the future, out of scope for M3. |
| **OpenClaw CLI not on PATH for the daemon user** | `install-cron.mjs` resolves an absolute path to the `openclaw` binary via a PATH lookup at script start; errors if not found with a clear remediation message. Installed cron-job argv arrays use absolute `node` and script paths. |
| **Shell injection via cron.yaml descriptions** | All subprocess calls use argv arrays with `child_process.execFile` — no shell interpolation. Malicious description text in cron.yaml cannot escape into a shell command because no shell is invoked. |

---

## 9. Success Criteria

M3 terminates when:

1. `skills/orchestrator/` and `skills/report/` have passing Vitest suites (all cases in §6.1)
2. `shared/quiet-queue.js` and `shared/time.js` have passing tests
3. `scripts/install-cron.mjs` has passing tests (diff logic)
4. `config/cron.yaml` has 6 jobs filled in per §4
5. Running `node scripts/install-cron.mjs` on a clean system registers 6 cron jobs visible in `openclaw cron list`
6. Manually triggering `openclaw cron run openclaw-managed-daily-loop` produces ≥1 draft (2-3 depending on available topics + transcripts) and a summary log line
7. `bin/smoke-run.js --orchestrator --sandbox` produces 2-3 drafts in `/tmp/openclaw-smoke/pending/` and exits 0
8. One real end-to-end run observed: daily-loop fires on schedule (or via `openclaw cron run`), drafts appear in Telegram with working approve/modify/reject buttons, nightly report DM arrives at 23:00
9. M3 branch merged to main via PR

---

## 10. Handoff

M3 is the final MVP milestone per the parent spec's scope. After M3 ships, the roadmap pivots to follow-on epics (E1–E12 in parent spec §10), unblocked by the working pipeline.

**Immediate post-M3 candidates (bd-tracked):**

- **E1 (openclaw-0wa)** — local SDXL/Flux image gen. Useful once the approval loop is proven — replaces Pexels for slideshow and gives us control over visual on-topic-ness (M2 revealed Pexels returns off-topic matches too often).
- **E2 (openclaw-77s)** — FFmpeg slideshow video assembly. Needed before real IG/YT/TikTok publishing; currently slideshow only emits storyboard JSON.
- **E12 (openclaw-636)** — Healthchecks.io watchdog. Low-effort; high-value as soon as the bot runs unattended.
- **Brand voice draft (`SOUL.md`)** — parent spec §12 open question. Can ship separately from M3; pure content work.

**Not blocking M3 but worth doing during:**

- Cache a Lex Fridman fixture episode so the full clip path can be smoke-tested end-to-end. Until then `bin/smoke-run.js --orchestrator` will test clip mode only as far as "no matching episode → skip", not the full produce-a-real-clip path.

---

## 11. Open Questions / Deferred

- **Cron-drift safe catch-up** — should a wake-from-sleep trigger auto-rerun a missed daily-loop, or only DM and wait for `[Yes/Skip]`? Parent spec §8 says the latter. M3 keeps it simple: log the drift, DM if >2h, proceed. Interactive catch-up is a follow-on.
- **Digest deduplication** — if user manually runs `bin/report.js --job=nightly` at 22:58, then cron fires at 23:00, they get two reports. Minor annoyance; fix if it becomes a problem.
- **Morning-flush digest layout** — current design renders one message with N `[Review →]` buttons. If N > 10, Telegram may clip / the digest may be hard to scan. Acceptable for steady state (≤3 quiet drafts/night); revisit if user reports clutter.

---

## Approval Record

Design brainstormed 2026-04-17 after M2 merged to main. User confirmed each decision:

- Cron scheduling via `openclaw cron` + `install-cron.mjs` provisioner — confirmed (option A)
- Topic↔episode matching: hybrid (keyword prefilter → LLM top-3) — confirmed (option C)
- Quiet-hours: per-job policy (content defers, nightly report exempt) — confirmed (option C)
- Failure handling: best-effort + one transient retry, no topic dedupe — confirmed
- Architecture sections (orchestrator batch, report, quiet-queue, provisioning) — confirmed
- Daily-loop data flow — confirmed
- Error handling + testing strategy — confirmed

Next step: invoke `superpowers:writing-plans` to produce the implementation plan that feeds into beads epics + tasks.
