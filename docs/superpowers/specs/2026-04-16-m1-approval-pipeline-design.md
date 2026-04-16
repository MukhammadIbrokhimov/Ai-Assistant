# M1: Approval Pipeline — Design Spec

**Date:** 2026-04-16
**Milestone:** openclaw-qr9
**Depends on:** M0 (Foundation) — complete
**Blocks:** M2 (Content Generation)

---

## 1. Scope

### In scope (M1)

- `approval` skill — send Template A to Telegram, create pending state
- `archive` skill — move draft folders by status, send Template B on approve
- `poller` — long-polling daemon, callback dispatch, slash commands
- `shared` — telegram-client, draft-store, constants (local npm package)
- Slash commands: `/mode`, `/status`, `/queue`, `/spend`, `/help`, `/whoami`
- Draft JSON schema as the contract between skills
- End-to-end: hand-craft draft on disk → trigger approval → tap Approve → archived + Template B delivered

### Deferred

- Quiet hours & batched notifications (M3)
- `/pause`, `/resume`, `/quiet`, `/run daily-loop`, `/run scan-whitelist`, `/sources`, `/providers` commands (M2/M3)
- `/queue clear` (bulk reject with confirmation)
- `/start` pairing handshake — pairing is a gateway responsibility; M1 assumes `paired_user_id` is already set in `telegram.yaml`
- `force_reply` on modify (M1 supports only one draft in `modifying` state at a time — see §5.3)
- Timeout handling (30-min modify, 5-min reject)
- File-lock on `pending/` directory
- Reject reason collection (reply with reason text)
- Launchd daemonization of the poller
- Media file attachment in Telegram messages (Templates reference media paths; actual `sendVideo`/`sendPhoto` calls are deferred)

---

## 2. Architecture

### 2.1 Module structure

```
~/.openclaw/workspace/skills/
├── approval/
│   ├── SKILL.md
│   ├── approval.js        # send draft for review (Template A + inline keyboard)
│   ├── package.json
│   └── tests/
├── archive/
│   ├── SKILL.md
│   ├── archive.js         # move folders by status, send Template B
│   ├── package.json
│   └── tests/
├── poller/
│   ├── SKILL.md
│   ├── poller.js          # long-polling loop, callback dispatch
│   ├── commands/           # one file per slash command handler
│   │   ├── mode.js
│   │   ├── status.js
│   │   ├── queue.js
│   │   ├── spend.js
│   │   ├── help.js
│   │   └── whoami.js
│   ├── bin/poll.js         # entry point: node bin/poll.js
│   ├── package.json
│   └── tests/
└── shared/
    ├── telegram-client.js  # thin fetch wrapper for Bot API
    ├── draft-store.js      # read/write/move draft.json + state.json
    ├── constants.js        # callback_data prefixes, status enums, templates
    ├── package.json
    └── tests/
```

### 2.2 Dependency graph

```
approval  ──→ shared
archive   ──→ shared
poller    ──→ shared, approval, archive, provider-router
```

Each skill depends on `shared` via `"shared": "file:../shared"` in `package.json`. The poller imports `archive` directly to call `archive.process(draftId)` after state transitions.

### 2.3 Data flow

1. Approval skill writes draft to `pending/<id>/`, sends Template A to Telegram
2. Poller catches button tap via `getUpdates`, updates `state.json`, calls archive
3. Archive moves folder to `approved/YYYY-MM-DD/<id>/` or `rejected/YYYY-MM-DD/<id>/`, sends Template B (if approved)
4. Modify flow: poller catches text reply, calls provider-router (`taskClass: "write"`) to regenerate, creates new draft with `parent_id`, sets old to `superseded`, sends new draft through approval

---

## 3. Telegram Integration

### 3.1 Approach

Direct Telegram Bot API calls via `fetch`. No OpenClaw abstractions — the gateway handles pairing/auth, skills handle message I/O.

### 3.2 Polling

Long-polling via `getUpdates` with 30s timeout. Single-user bot, no webhook infrastructure needed.

The poller is a standalone Node.js process (`node bin/poll.js`). For M1 it runs manually; daemonization is deferred.

### 3.3 telegram-client.js

Thin wrapper (~80 lines). Reads `TG_BOT_TOKEN` from env.

```js
sendMessage(chatId, text, opts)           // opts: parse_mode, reply_markup
editMessageText(chatId, messageId, text, opts)
answerCallbackQuery(callbackQueryId, text)
getUpdates(offset, timeout)               // long-polling
```

All methods call `https://api.telegram.org/bot${token}/methodName` via `fetch`. Returns parsed JSON. Throws on non-ok responses.

---

## 4. Draft Schema

### 4.1 draft.json

Written to `~/openclaw-drafts/pending/<draft-id>/draft.json`:

```json
{
  "id": "2026-04-16-clip-lex-altman-001",
  "created_at": "2026-04-16T09:01:23Z",
  "mode": "clip",
  "topic": "AI agents replacing junior devs",
  "niche": "ai",
  "caption": "Sam Altman explains why...",
  "hashtags": ["#aiagents", "#lexfridman"],
  "media": [{"path": "media/0.mp4", "type": "video", "duration_s": 47}],
  "source": {
    "url": "https://youtu.be/...",
    "title": "Lex Fridman #999 — Sam Altman",
    "creator": "Lex Fridman",
    "license": "permission-granted",
    "attribution_required": true,
    "clip_range": [1830, 1877]
  },
  "provider_used": "ollama:qwen2.5:14b",
  "tokens_in": 0,
  "tokens_out": 0,
  "status": "pending",
  "parent_id": null
}
```

`source` is null for slideshow/quotecard modes. `media` may be empty for quotecards (image generated separately). `prompt.txt` (optional, written alongside `draft.json` by content-generation skills in M2) stores the exact LLM prompt used for debugging.

### 4.2 state.json

Tracks Telegram-side state, lives alongside `draft.json`:

```json
{
  "status": "pending",
  "telegram_message_id": 12345,
  "telegram_chat_id": 5349931800,
  "sent_at": "2026-04-16T09:02:00Z",
  "resolved_at": null,
  "reject_reason": null
}
```

**Status values:** `pending` → `approved` | `rejected` | `modifying` | `superseded`

**Authority:** `state.json` is the authoritative source of truth for status during the approval lifecycle. `draft.json.status` is updated as a snapshot when the draft is finalized/archived (so archived drafts are self-contained without needing state.json).

**M1 constraint:** Only one draft may be in `modifying` state at a time. The poller finds it by scanning all `pending/*/state.json` for `status: "modifying"`. Multi-draft-modifying support (with `force_reply` correlation) is deferred.

### 4.3 State transitions

| Action | Actor | state.json change | File system change |
|---|---|---|---|
| Draft created | approval skill | creates state.json with `status: pending` | writes to `pending/<id>/` |
| User taps Approve | poller | `status: approved`, sets `resolved_at` | — |
| User taps Reject | poller | `status: rejected`, sets `resolved_at` | — |
| User taps Modify | poller | `status: modifying` | — |
| User sends modify text | poller | old draft `status: superseded` | old draft stays in `pending/` with superseded status |
| Archive runs | archive skill | — | moves folder to `approved/` or `rejected/YYYY-MM-DD/` |
| Re-delivery | archive skill | — | sends Template B |

---

## 5. Message Templates

### 5.1 Template A — Draft pending approval

```
🆕 Draft {id}  •  {MODE} mode
Source: {source.title} ({source.license})       ← omitted if source is null
Topic: {topic}

📝 Caption preview:
"{caption}"

{hashtags}

🎬 Media: {media[0].type}, {media[0].duration_s}s   ← omitted if media is empty

[✅ Approve]  [✏️ Modify]  [❌ Reject]
```

Inline keyboard `callback_data` format: `a:{draft-id}`, `m:{draft-id}`, `r:{draft-id}` (single-char prefixes to maximize headroom within Telegram's 64-byte limit).

Byte budget: prefix (2 bytes) + draft ID (up to 56 bytes) = 58 bytes max, leaving 6 bytes margin.

### 5.2 Template B — Approved package

```
✅ READY TO POST  •  Draft {id}

═══ COPY THIS ═══
{caption}

{hashtags}
═════════════════

🎬 Media: ~/openclaw-drafts/approved/{date}/{id}/media/   ← omitted if no media
Saved to: ~/openclaw-drafts/approved/{date}/{id}/
```

Media files are referenced by path only in M1. Actual Telegram `sendVideo`/`sendPhoto` attachment is deferred.

### 5.3 Callback behavior

**Approve:** `answerCallbackQuery` "Approved!" → edit message to strikethrough + "✅ Approved → posting queue" → update state.json → call archive → archive sends Template B.

**Reject:** `answerCallbackQuery` "Rejected" → edit message to strikethrough + "❌ Rejected" → update state.json → call archive. No reason collection in M1.

**Modify:** `answerCallbackQuery` "Send your changes" → edit message to strikethrough + "✏️ Awaiting changes..." → set `status: modifying`. Poller watches for next text message from paired user → calls provider-router to regenerate → creates new draft with `parent_id` → supersedes old (stays in `pending/` with `status: superseded`) → sends new through approval.

**M1 constraint:** Only one draft may be in `modifying` state at a time. If the user taps Modify on a second draft while one is already modifying, the poller replies "Another draft is being modified. Finish or /cancel that first." The `/cancel` command cancels the current modify and restores the draft to `pending`.

**Regeneration prompt:** `provider-router.complete({ taskClass: "write", prompt: "<original caption + topic context>\n\nUser feedback: <user's reply text>\n\nRewrite the caption incorporating the feedback." })`

---

## 6. Poller

### 6.1 Entry point

`node bin/poll.js`

### 6.2 Core loop

```js
let offset = 0;
let backoff = 1000; // ms, doubles on failure, caps at 60s
while (running) {
  try {
    const updates = await client.getUpdates(offset, 30);
    backoff = 1000; // reset on success
    for (const update of updates) {
      offset = update.update_id + 1;
      if (!isFromPairedUser(update)) continue;

      try {
        if (update.callback_query) {
          await handleCallback(update.callback_query);
        } else if (update.message?.text?.startsWith('/')) {
          await handleCommand(update.message);
        } else if (update.message?.text) {
          await handleModifyReply(update.message);
        }
      } catch (err) {
        console.error(`Error handling update ${update.update_id}:`, err);
        // Continue processing remaining updates
      }
    }
  } catch (err) {
    console.error(`getUpdates failed, retrying in ${backoff}ms:`, err);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
}
```

### 6.3 Error handling

- **`getUpdates` failure** (network down, Telegram outage): exponential backoff from 1s to 60s, retry indefinitely. Logged to stderr.
- **Callback/command handler failure**: logged, skipped, loop continues. State on disk may be partially updated — `/queue` shows current state so user can re-trigger.
- **`sendMessage`/`editMessage` failure during callback**: logged, state.json is still updated (worst case: user doesn't see the edit but state is correct). User can check via `/queue`.

### 6.4 User filtering

All updates not from `paired_user_id` (loaded from `telegram.yaml`) are silently dropped.

### 6.5 Graceful shutdown

Catches `SIGINT`/`SIGTERM`, sets `running = false`, loop exits after current `getUpdates` returns.

---

## 7. Slash Commands

Dispatched by the poller. Each handler: `(chatId, args, telegramClient) => Promise<void>`.

```js
const commands = { mode, spend, status, queue, whoami, help };
const handler = commands[name];
if (handler) await handler(chatId, args, client);
else await client.sendMessage(chatId, "Unknown command. Try /help");
```

| Command | Logic |
|---|---|
| `/mode` | No args → read providers.yaml, reply current mode. With arg → validate, update providers.yaml, confirm. If hybrid/premium and no ANTHROPIC_API_KEY → refuse with instructions. |
| `/spend` | Read provider-router's router.jsonl, compute today's total + MTD. `cap N` → update cap in providers.yaml. |
| `/status` | Ping gateway (localhost:18789) + Ollama (localhost:11434), count pending drafts, report last poll time. |
| `/queue` | List all drafts in `pending/` with status (filters out `superseded`). Empty → "No pending drafts." |
| `/whoami` | Reply with Telegram user ID and paired status. |
| `/help` | Static list of all commands with one-line descriptions. |

---

## 8. Testing

### 8.1 Unit tests (mocked, vitest)

**shared/ (~10 tests):**
- telegram-client: stub fetch, verify URL/body/headers for each method, error handling
- draft-store: temp dirs via `fs.mkdtemp`, verify read/write/move of draft.json and state.json, folder creation for `approved/YYYY-MM-DD/`

**approval/ (~6 tests):**
- Sends Template A with correct inline keyboard markup
- Creates state.json with pending status
- Handles draft with all fields populated
- Handles draft with minimal fields (no source, no media)
- Rejects invalid draft (missing required fields)
- Callback_data stays under 64-byte limit

**archive/ (~6 tests):**
- Moves approved draft to `approved/YYYY-MM-DD/<id>/`
- Moves rejected draft to `rejected/YYYY-MM-DD/<id>/`
- Sends Template B on approve
- Updates draft.json status field after move
- Handles missing media gracefully
- No-ops if draft already archived

**poller/ (~15 tests):**
- Dispatches callback query to correct handler
- Ignores updates from non-paired users
- Routes `/mode local` to mode handler
- Routes unknown `/foo` to help response
- Routes plain text to modify handler when draft is modifying
- Ignores plain text when no draft is modifying
- Rejects second modify when one is already in progress
- Modify: creates new draft with parent_id, supersedes old
- getUpdates failure triggers exponential backoff and retry
- Handler error does not crash the loop
- SIGINT sets running=false, loop exits cleanly
- Slash command handlers: one happy-path test each (6 tests)
- `/queue` filters out superseded drafts

**Total: ~37 unit tests.**

### 8.2 Manual E2E

1. Hand-craft draft in `~/openclaw-drafts/pending/test-001/`
2. Run approval skill → verify Template A in Telegram
3. Tap Approve → verify Template B, draft in `approved/`
4. Repeat for Reject and Modify flows

---

## 9. Future integration points

- **M2 content skills** write `draft.json` to `pending/` → approval picks them up
- **E3/E4/E5 publishing** plugs into archive's "on approve" step — replaces Template B with API calls to Instagram/YouTube/TikTok
- **E11 cross-posting** calls multiple publishing APIs from the same approve handler
- **M3 orchestrator** triggers approval skill after content generation, manages the daily loop
