# M1: Approval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approval pipeline — approval + archive skills, Telegram polling daemon, and slash commands — so that a hand-crafted draft on disk can be sent for review via Telegram, and the user can approve/reject/modify it with inline buttons.

**Architecture:** Four npm modules under `~/.openclaw/workspace/skills/`: `shared` (telegram-client, draft-store, constants), `approval` (sends Template A), `archive` (moves folders, sends Template B), `poller` (long-polling loop, callback dispatch, slash commands). All Telegram I/O goes through direct Bot API fetch calls. Draft state lives on disk in `~/openclaw-drafts/pending/<id>/`. Each module uses vitest with `vi.stubGlobal('fetch', vi.fn())` for Telegram mocks and `fs.mkdtemp` for file system tests.

**Tech Stack:** Node.js 22 (ESM), vitest, js-yaml, native fetch, Telegram Bot API

**Spec:** `docs/superpowers/specs/2026-04-16-m1-approval-pipeline-design.md`

**Important conventions (from M0):**
- All skills live at `~/.openclaw/workspace/skills/<name>/`
- Tests use `vi.stubGlobal('fetch', vi.fn())` — nock doesn't work with Node 22 native fetch
- `package.json` uses `"type": "module"` (ESM)
- PATH needs `/opt/homebrew/bin` for npm/node: `export PATH="/opt/homebrew/bin:$PATH"`
- Config files at `~/.openclaw/workspace/config/` (providers.yaml, telegram.yaml)
- Draft state tree at `~/openclaw-drafts/` (pending, approved, rejected, superseded)

---

## File Structure

```
~/.openclaw/workspace/skills/
├── shared/
│   ├── package.json
│   ├── constants.js        # status enums, callback prefixes, template functions
│   ├── telegram-client.js  # thin fetch wrapper for Telegram Bot API
│   ├── draft-store.js      # read/write/move draft.json + state.json
│   └── tests/
│       ├── constants.test.js
│       ├── telegram-client.test.js
│       └── draft-store.test.js
├── approval/
│   ├── package.json
│   ├── SKILL.md
│   ├── approval.js         # send Template A with inline keyboard
│   └── tests/
│       └── approval.test.js
├── archive/
│   ├── package.json
│   ├── SKILL.md
│   ├── archive.js          # move folders, send Template B
│   └── tests/
│       └── archive.test.js
└── poller/
    ├── package.json
    ├── SKILL.md
    ├── poller.js            # core polling loop + dispatch
    ├── bin/
    │   └── poll.js          # CLI entry point
    ├── commands/
    │   ├── mode.js
    │   ├── status.js
    │   ├── queue.js
    │   ├── spend.js
    │   ├── whoami.js
    │   └── help.js
    └── tests/
        ├── poller.test.js
        └── commands.test.js
```

---

### Task 1: shared/constants.js

**Files:**
- Create: `~/.openclaw/workspace/skills/shared/package.json`
- Create: `~/.openclaw/workspace/skills/shared/constants.js`
- Create: `~/.openclaw/workspace/skills/shared/tests/constants.test.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "shared",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": {
    "./constants": "./constants.js",
    "./telegram-client": "./telegram-client.js",
    "./draft-store": "./draft-store.js"
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

- [ ] **Step 2: Install dependencies**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npm install`
Expected: `node_modules/` created with vitest

- [ ] **Step 3: Write failing test for constants**

Create `~/.openclaw/workspace/skills/shared/tests/constants.test.js`:

```js
import { describe, test, expect } from "vitest";
import {
  STATUSES,
  CALLBACK_PREFIXES,
  formatTemplateA,
  formatTemplateB,
} from "../constants.js";

describe("constants", () => {
  test("STATUSES contains all valid status values", () => {
    expect(STATUSES).toEqual({
      PENDING: "pending",
      APPROVED: "approved",
      REJECTED: "rejected",
      MODIFYING: "modifying",
      SUPERSEDED: "superseded",
    });
  });

  test("CALLBACK_PREFIXES use single-char keys", () => {
    expect(CALLBACK_PREFIXES).toEqual({
      APPROVE: "a:",
      MODIFY: "m:",
      REJECT: "r:",
    });
  });

  test("formatTemplateA renders full draft with source and media", () => {
    const draft = {
      id: "2026-04-16-clip-001",
      mode: "clip",
      topic: "AI agents",
      caption: "Sam Altman explains why...",
      hashtags: ["#aiagents", "#lexfridman"],
      media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
      source: {
        title: "Lex Fridman #999",
        license: "permission-granted",
      },
    };
    const text = formatTemplateA(draft);
    expect(text).toContain("🆕 Draft 2026-04-16-clip-001");
    expect(text).toContain("CLIP mode");
    expect(text).toContain("Source: Lex Fridman #999 (permission-granted)");
    expect(text).toContain("AI agents");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
    expect(text).toContain("🎬 Media: video, 47s");
  });

  test("formatTemplateA omits source and media when absent", () => {
    const draft = {
      id: "2026-04-16-quote-001",
      mode: "quotecard",
      topic: "Productivity tips",
      caption: "Focus is a superpower.",
      hashtags: ["#productivity"],
      media: [],
      source: null,
    };
    const text = formatTemplateA(draft);
    expect(text).toContain("🆕 Draft 2026-04-16-quote-001");
    expect(text).toContain("QUOTECARD mode");
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("🎬 Media:");
  });

  test("formatTemplateB renders approved package with media path", () => {
    const draft = {
      id: "2026-04-16-clip-001",
      caption: "Sam Altman explains why...",
      hashtags: ["#aiagents", "#lexfridman"],
      media: [{ path: "media/0.mp4", type: "video" }],
    };
    const destDir = "~/openclaw-drafts/approved/2026-04-16/2026-04-16-clip-001";
    const text = formatTemplateB(draft, destDir);
    expect(text).toContain("✅ READY TO POST");
    expect(text).toContain("═══ COPY THIS ═══");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
    expect(text).toContain("═════════════════");
    expect(text).toContain("🎬 Media:");
    expect(text).toContain("Saved to:");
  });

  test("formatTemplateB omits media line when no media", () => {
    const draft = {
      id: "2026-04-16-quote-001",
      caption: "Focus is a superpower.",
      hashtags: ["#productivity"],
      media: [],
    };
    const destDir = "~/openclaw-drafts/approved/2026-04-16/2026-04-16-quote-001";
    const text = formatTemplateB(draft, destDir);
    expect(text).not.toContain("🎬 Media:");
    expect(text).toContain("Saved to:");
  });

  test("callback_data stays under 64 bytes for max-length ID", () => {
    const longId = "a".repeat(56);
    const data = `${CALLBACK_PREFIXES.APPROVE}${longId}`;
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/constants.test.js`
Expected: FAIL — `constants.js` does not exist

- [ ] **Step 5: Implement constants.js**

Create `~/.openclaw/workspace/skills/shared/constants.js`:

```js
export const STATUSES = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  MODIFYING: "modifying",
  SUPERSEDED: "superseded",
};

export const CALLBACK_PREFIXES = {
  APPROVE: "a:",
  MODIFY: "m:",
  REJECT: "r:",
};

export function formatTemplateA(draft) {
  const lines = [];
  lines.push(`🆕 Draft ${draft.id}  •  ${draft.mode.toUpperCase()} mode`);
  if (draft.source) {
    lines.push(`Source: ${draft.source.title} (${draft.source.license})`);
  }
  lines.push(`Topic: ${draft.topic}`);
  lines.push("");
  lines.push("📝 Caption preview:");
  lines.push(`"${draft.caption}"`);
  lines.push("");
  lines.push(draft.hashtags.join(" "));
  if (draft.media && draft.media.length > 0) {
    const m = draft.media[0];
    const parts = [m.type];
    if (m.duration_s) parts.push(`${m.duration_s}s`);
    lines.push("");
    lines.push(`🎬 Media: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatTemplateB(draft, destDir) {
  const lines = [];
  lines.push(`✅ READY TO POST  •  Draft ${draft.id}`);
  lines.push("");
  lines.push("═══ COPY THIS ═══");
  lines.push(draft.caption);
  lines.push("");
  lines.push(draft.hashtags.join(" "));
  lines.push("═════════════════");
  if (draft.media && draft.media.length > 0) {
    lines.push("");
    lines.push(`🎬 Media: ${destDir}/media/`);
  }
  lines.push("");
  lines.push(`Saved to: ${destDir}/`);
  return lines.join("\n");
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/constants.test.js`
Expected: 7 tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(shared): add constants module — statuses, callback prefixes, template formatters"
```

---

### Task 2: shared/telegram-client.js

**Files:**
- Create: `~/.openclaw/workspace/skills/shared/telegram-client.js`
- Create: `~/.openclaw/workspace/skills/shared/tests/telegram-client.test.js`

- [ ] **Step 1: Write failing test**

Create `~/.openclaw/workspace/skills/shared/tests/telegram-client.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createTelegramClient } from "../telegram-client.js";

describe("telegram-client", () => {
  let originalFetch;
  const TOKEN = "123:ABC";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchOk(result) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result }),
    });
  }

  function mockFetchError(description) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, description }),
    });
  }

  test("sendMessage posts correct URL and body", async () => {
    mockFetchOk({ message_id: 42 });
    const client = createTelegramClient(TOKEN);
    const result = await client.sendMessage(123, "hello", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(123);
    expect(body.text).toBe("hello");
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(result.message_id).toBe(42);
  });

  test("editMessageText posts correct URL and body", async () => {
    mockFetchOk(true);
    const client = createTelegramClient(TOKEN);
    await client.editMessageText(123, 42, "edited");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/editMessageText");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(123);
    expect(body.message_id).toBe(42);
    expect(body.text).toBe("edited");
  });

  test("answerCallbackQuery posts correct URL and body", async () => {
    mockFetchOk(true);
    const client = createTelegramClient(TOKEN);
    await client.answerCallbackQuery("cbq-1", "Done!");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/answerCallbackQuery");
    const body = JSON.parse(opts.body);
    expect(body.callback_query_id).toBe("cbq-1");
    expect(body.text).toBe("Done!");
  });

  test("getUpdates posts correct URL with offset and timeout", async () => {
    mockFetchOk([]);
    const client = createTelegramClient(TOKEN);
    await client.getUpdates(5, 30);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/getUpdates");
    const body = JSON.parse(opts.body);
    expect(body.offset).toBe(5);
    expect(body.timeout).toBe(30);
    expect(body.allowed_updates).toEqual(["message", "callback_query"]);
  });

  test("throws on Telegram API error response", async () => {
    mockFetchError("Bad Request: chat not found");
    const client = createTelegramClient(TOKEN);
    await expect(client.sendMessage(999, "hi")).rejects.toThrow(
      /Bad Request: chat not found/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/telegram-client.test.js`
Expected: FAIL — `telegram-client.js` does not exist

- [ ] **Step 3: Implement telegram-client.js**

Create `~/.openclaw/workspace/skills/shared/telegram-client.js`:

```js
export function createTelegramClient(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`Telegram ${method}: ${json.description || "unknown error"}`);
    }
    return json.result;
  }

  return {
    async sendMessage(chatId, text, opts = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text,
        ...opts,
      });
    },

    async editMessageText(chatId, messageId, text, opts = {}) {
      return call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...opts,
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      return call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      });
    },

    async getUpdates(offset, timeout) {
      return call("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/telegram-client.test.js`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(shared): add telegram-client — fetch wrapper for Bot API"
```

---

### Task 3: shared/draft-store.js

**Files:**
- Create: `~/.openclaw/workspace/skills/shared/draft-store.js`
- Create: `~/.openclaw/workspace/skills/shared/tests/draft-store.test.js`

- [ ] **Step 1: Write failing test**

Create `~/.openclaw/workspace/skills/shared/tests/draft-store.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "../draft-store.js";

let tmp, store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "drafts-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, draft, state) {
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  if (state) {
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  }
}

describe("draft-store", () => {
  test("readDraft returns parsed draft.json and state.json", () => {
    const draft = { id: "test-001", caption: "hello" };
    const state = { status: "pending", telegram_message_id: 42 };
    writeDraft("test-001", draft, state);
    const result = store.readDraft("test-001");
    expect(result.draft.id).toBe("test-001");
    expect(result.state.status).toBe("pending");
  });

  test("readDraft returns null state when state.json missing", () => {
    const draft = { id: "test-002", caption: "hello" };
    writeDraft("test-002", draft);
    const result = store.readDraft("test-002");
    expect(result.draft.id).toBe("test-002");
    expect(result.state).toBeNull();
  });

  test("writeState creates state.json in pending dir", () => {
    const draft = { id: "test-003" };
    writeDraft("test-003", draft);
    const state = {
      status: "pending",
      telegram_message_id: 99,
      telegram_chat_id: 555,
      sent_at: "2026-04-16T09:00:00Z",
      resolved_at: null,
      reject_reason: null,
    };
    store.writeState("test-003", state);
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "test-003", "state.json"), "utf8")
    );
    expect(raw.telegram_message_id).toBe(99);
  });

  test("updateState merges partial updates into state.json", () => {
    const draft = { id: "test-004" };
    const state = { status: "pending", telegram_message_id: 1, resolved_at: null };
    writeDraft("test-004", draft, state);
    store.updateState("test-004", {
      status: "approved",
      resolved_at: "2026-04-16T10:00:00Z",
    });
    const updated = store.readDraft("test-004").state;
    expect(updated.status).toBe("approved");
    expect(updated.resolved_at).toBe("2026-04-16T10:00:00Z");
    expect(updated.telegram_message_id).toBe(1);
  });

  test("moveToApproved moves folder to approved/YYYY-MM-DD/<id>/", () => {
    const draft = { id: "test-005", status: "pending" };
    const state = { status: "approved" };
    writeDraft("test-005", draft, state);
    const dest = store.moveToApproved("test-005", "2026-04-16");
    expect(existsSync(join(tmp, "approved", "2026-04-16", "test-005", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-005"))).toBe(false);
    expect(dest).toContain("approved/2026-04-16/test-005");
  });

  test("moveToRejected moves folder to rejected/YYYY-MM-DD/<id>/", () => {
    const draft = { id: "test-006", status: "pending" };
    const state = { status: "rejected" };
    writeDraft("test-006", draft, state);
    const dest = store.moveToRejected("test-006", "2026-04-16");
    expect(existsSync(join(tmp, "rejected", "2026-04-16", "test-006", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-006"))).toBe(false);
  });

  test("moveToApproved creates date subdirectory if missing", () => {
    const draft = { id: "test-007" };
    const state = { status: "approved" };
    writeDraft("test-007", draft, state);
    store.moveToApproved("test-007", "2026-05-01");
    expect(existsSync(join(tmp, "approved", "2026-05-01", "test-007"))).toBe(true);
  });

  test("listPending returns all draft IDs in pending/ (excludes superseded)", () => {
    writeDraft("d-001", { id: "d-001" }, { status: "pending" });
    writeDraft("d-002", { id: "d-002" }, { status: "modifying" });
    writeDraft("d-003", { id: "d-003" }, { status: "superseded" });
    const ids = store.listPending();
    expect(ids).toContain("d-001");
    expect(ids).toContain("d-002");
    expect(ids).not.toContain("d-003");
  });

  test("findModifying returns the one draft in modifying state", () => {
    writeDraft("d-010", { id: "d-010" }, { status: "pending" });
    writeDraft("d-011", { id: "d-011" }, { status: "modifying" });
    expect(store.findModifying()).toBe("d-011");
  });

  test("findModifying returns null when no draft is modifying", () => {
    writeDraft("d-020", { id: "d-020" }, { status: "pending" });
    expect(store.findModifying()).toBeNull();
  });

  test("updateDraftStatus updates the status field in draft.json", () => {
    writeDraft("test-008", { id: "test-008", status: "pending" });
    store.updateDraftStatus("test-008", "approved");
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "test-008", "draft.json"), "utf8")
    );
    expect(raw.status).toBe("approved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/draft-store.test.js`
Expected: FAIL — `draft-store.js` does not exist

- [ ] **Step 3: Implement draft-store.js**

Create `~/.openclaw/workspace/skills/shared/draft-store.js`:

```js
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export function createDraftStore(basePath) {
  const pendingDir = join(basePath, "pending");
  const approvedDir = join(basePath, "approved");
  const rejectedDir = join(basePath, "rejected");

  function draftDir(id) {
    return join(pendingDir, id);
  }

  function readDraft(id) {
    const dir = draftDir(id);
    const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
    let state = null;
    const statePath = join(dir, "state.json");
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    }
    return { draft, state };
  }

  function writeState(id, state) {
    const dir = draftDir(id);
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  }

  function updateState(id, partial) {
    const { state } = readDraft(id);
    const merged = { ...state, ...partial };
    writeState(id, merged);
  }

  function updateDraftStatus(id, status) {
    const dir = draftDir(id);
    const draftPath = join(dir, "draft.json");
    const draft = JSON.parse(readFileSync(draftPath, "utf8"));
    draft.status = status;
    writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  }

  function moveTo(targetBase, id, dateStr) {
    const src = draftDir(id);
    const dateDir = join(targetBase, dateStr);
    mkdirSync(dateDir, { recursive: true });
    const dest = join(dateDir, id);
    renameSync(src, dest);
    return dest;
  }

  function moveToApproved(id, dateStr) {
    return moveTo(approvedDir, id, dateStr);
  }

  function moveToRejected(id, dateStr) {
    return moveTo(rejectedDir, id, dateStr);
  }

  function listPending() {
    if (!existsSync(pendingDir)) return [];
    const entries = readdirSync(pendingDir, { withFileTypes: true });
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = join(pendingDir, entry.name, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.status === "superseded") continue;
      }
      ids.push(entry.name);
    }
    return ids;
  }

  function findModifying() {
    if (!existsSync(pendingDir)) return null;
    const entries = readdirSync(pendingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = join(pendingDir, entry.name, "state.json");
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.status === "modifying") return entry.name;
    }
    return null;
  }

  return {
    readDraft,
    writeState,
    updateState,
    updateDraftStatus,
    moveToApproved,
    moveToRejected,
    listPending,
    findModifying,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npx vitest run tests/draft-store.test.js`
Expected: 10 tests PASS

- [ ] **Step 5: Run all shared tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npm test`
Expected: All 22 tests PASS (7 constants + 5 telegram-client + 10 draft-store)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(shared): add draft-store — read, write, move drafts on disk"
```

---

### Task 4: approval skill

**Files:**
- Create: `~/.openclaw/workspace/skills/approval/package.json`
- Create: `~/.openclaw/workspace/skills/approval/SKILL.md`
- Create: `~/.openclaw/workspace/skills/approval/approval.js`
- Create: `~/.openclaw/workspace/skills/approval/tests/approval.test.js`

- [ ] **Step 1: Create package.json and SKILL.md**

`package.json`:
```json
{
  "name": "approval",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "shared": "file:../shared"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

`SKILL.md`:
```markdown
# Approval Skill

Sends a draft to Telegram for human review with inline keyboard buttons (Approve/Modify/Reject). Creates `state.json` to track the Telegram message.

## Usage

```js
import { sendForApproval } from "./approval.js";
await sendForApproval(draftId, { telegramClient, draftStore, chatId });
```
```

- [ ] **Step 2: Install dependencies**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/approval && npm install`

- [ ] **Step 3: Write failing test**

Create `~/.openclaw/workspace/skills/approval/tests/approval.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { CALLBACK_PREFIXES } from "shared/constants";
import { sendForApproval } from "../approval.js";

let tmp, store;
const CHAT_ID = 5349931800;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "approval-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, overrides = {}) {
  const draft = {
    id,
    created_at: "2026-04-16T09:00:00Z",
    mode: "clip",
    topic: "AI agents",
    niche: "ai",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: {
      url: "https://youtu.be/...",
      title: "Lex Fridman #999",
      creator: "Lex Fridman",
      license: "permission-granted",
      attribution_required: true,
      clip_range: [1830, 1877],
    },
    provider_used: "ollama:qwen2.5:14b",
    tokens_in: 0,
    tokens_out: 0,
    status: "pending",
    parent_id: null,
    ...overrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  return draft;
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

describe("sendForApproval", () => {
  test("sends Template A with inline keyboard and creates state.json", async () => {
    writeDraft("test-001");
    const client = mockTelegramClient();
    await sendForApproval("test-001", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = client.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("🆕 Draft test-001");
    expect(text).toContain("Source: Lex Fridman #999");
    expect(text).toContain("🎬 Media: video, 47s");

    const keyboard = opts.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toHaveLength(3);
    expect(keyboard[0][0].callback_data).toBe("a:test-001");
    expect(keyboard[0][1].callback_data).toBe("m:test-001");
    expect(keyboard[0][2].callback_data).toBe("r:test-001");

    const state = store.readDraft("test-001").state;
    expect(state.status).toBe("pending");
    expect(state.telegram_message_id).toBe(42);
    expect(state.telegram_chat_id).toBe(CHAT_ID);
  });

  test("handles draft with no source and no media", async () => {
    writeDraft("test-002", { source: null, media: [] });
    const client = mockTelegramClient();
    await sendForApproval("test-002", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const [, text] = client.sendMessage.mock.calls[0];
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("🎬 Media:");
  });

  test("handles draft with all fields populated", async () => {
    writeDraft("test-003");
    const client = mockTelegramClient();
    await sendForApproval("test-003", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const state = store.readDraft("test-003").state;
    expect(state.status).toBe("pending");
    expect(state.sent_at).toBeDefined();
  });

  test("throws on missing draft", async () => {
    const client = mockTelegramClient();
    await expect(
      sendForApproval("nonexistent", {
        telegramClient: client,
        draftStore: store,
        chatId: CHAT_ID,
      })
    ).rejects.toThrow();
  });

  test("callback_data for each button stays under 64 bytes", async () => {
    const longId = "2026-04-16-clip-lex-fridman-sam-altman-interview-001";
    writeDraft(longId);
    const client = mockTelegramClient();
    await sendForApproval(longId, {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    const keyboard = client.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    for (const btn of keyboard[0]) {
      expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  test("returns the telegram message_id for tracking", async () => {
    writeDraft("test-004");
    const client = mockTelegramClient();
    const result = await sendForApproval("test-004", {
      telegramClient: client,
      draftStore: store,
      chatId: CHAT_ID,
    });
    expect(result.messageId).toBe(42);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/approval && npx vitest run`
Expected: FAIL — `approval.js` does not exist

- [ ] **Step 5: Implement approval.js**

Create `~/.openclaw/workspace/skills/approval/approval.js`:

```js
import { formatTemplateA, CALLBACK_PREFIXES } from "shared/constants";

export async function sendForApproval(draftId, { telegramClient, draftStore, chatId }) {
  const { draft } = draftStore.readDraft(draftId);
  const text = formatTemplateA(draft);

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `${CALLBACK_PREFIXES.APPROVE}${draftId}` },
        { text: "✏️ Modify", callback_data: `${CALLBACK_PREFIXES.MODIFY}${draftId}` },
        { text: "❌ Reject", callback_data: `${CALLBACK_PREFIXES.REJECT}${draftId}` },
      ],
    ],
  };

  const result = await telegramClient.sendMessage(chatId, text, {
    reply_markup: keyboard,
  });

  draftStore.writeState(draftId, {
    status: "pending",
    telegram_message_id: result.message_id,
    telegram_chat_id: chatId,
    sent_at: new Date().toISOString(),
    resolved_at: null,
    reject_reason: null,
  });

  return { messageId: result.message_id };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/approval && npx vitest run`
Expected: 6 tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(approval): send Template A with inline keyboard, create state.json"
```

---

### Task 5: archive skill

**Files:**
- Create: `~/.openclaw/workspace/skills/archive/package.json`
- Create: `~/.openclaw/workspace/skills/archive/SKILL.md`
- Create: `~/.openclaw/workspace/skills/archive/archive.js`
- Create: `~/.openclaw/workspace/skills/archive/tests/archive.test.js`

- [ ] **Step 1: Create package.json and SKILL.md**

`package.json`:
```json
{
  "name": "archive",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "shared": "file:../shared"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

`SKILL.md`:
```markdown
# Archive Skill

Moves draft folders by approval status and sends Template B on approve.

## Usage

```js
import { archiveDraft } from "./archive.js";
await archiveDraft(draftId, { draftStore, telegramClient });
```
```

- [ ] **Step 2: Install dependencies**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/archive && npm install`

- [ ] **Step 3: Write failing test**

Create `~/.openclaw/workspace/skills/archive/tests/archive.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { archiveDraft } from "../archive.js";

let tmp, store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "archive-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, draftOverrides = {}, stateOverrides = {}) {
  const draft = {
    id,
    mode: "clip",
    topic: "AI agents",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: null,
    status: "pending",
    ...draftOverrides,
  };
  const state = {
    status: "pending",
    telegram_message_id: 42,
    telegram_chat_id: 5349931800,
    sent_at: "2026-04-16T09:00:00Z",
    resolved_at: null,
    reject_reason: null,
    ...stateOverrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return { draft, state };
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

describe("archiveDraft", () => {
  test("moves approved draft to approved/YYYY-MM-DD/<id>/", async () => {
    writeDraft("test-001", {}, { status: "approved", resolved_at: "2026-04-16T10:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-001", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "approved", "2026-04-16", "test-001", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-001"))).toBe(false);
  });

  test("moves rejected draft to rejected/YYYY-MM-DD/<id>/", async () => {
    writeDraft("test-002", {}, { status: "rejected", resolved_at: "2026-04-16T11:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-002", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "rejected", "2026-04-16", "test-002", "draft.json"))).toBe(true);
    expect(existsSync(join(tmp, "pending", "test-002"))).toBe(false);
  });

  test("sends Template B on approve", async () => {
    writeDraft("test-003", {}, { status: "approved", resolved_at: "2026-04-16T12:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-003", { draftStore: store, telegramClient: client });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = client.sendMessage.mock.calls[0];
    expect(chatId).toBe(5349931800);
    expect(text).toContain("✅ READY TO POST");
    expect(text).toContain("═══ COPY THIS ═══");
    expect(text).toContain("Sam Altman explains why...");
    expect(text).toContain("#aiagents #lexfridman");
  });

  test("does not send Template B on reject", async () => {
    writeDraft("test-004", {}, { status: "rejected", resolved_at: "2026-04-16T12:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-004", { draftStore: store, telegramClient: client });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test("updates draft.json status after move", async () => {
    writeDraft("test-005", {}, { status: "approved", resolved_at: "2026-04-16T13:00:00Z" });
    const client = mockTelegramClient();
    await archiveDraft("test-005", { draftStore: store, telegramClient: client });
    const raw = JSON.parse(
      readFileSync(join(tmp, "approved", "2026-04-16", "test-005", "draft.json"), "utf8")
    );
    expect(raw.status).toBe("approved");
  });

  test("no-ops if draft is still pending", async () => {
    writeDraft("test-006");
    const client = mockTelegramClient();
    await archiveDraft("test-006", { draftStore: store, telegramClient: client });
    expect(existsSync(join(tmp, "pending", "test-006"))).toBe(true);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/archive && npx vitest run`
Expected: FAIL — `archive.js` does not exist

- [ ] **Step 5: Implement archive.js**

Create `~/.openclaw/workspace/skills/archive/archive.js`:

```js
import { formatTemplateB } from "shared/constants";

export async function archiveDraft(draftId, { draftStore, telegramClient }) {
  const { draft, state } = draftStore.readDraft(draftId);

  if (state.status === "approved") {
    const dateStr = state.resolved_at.slice(0, 10);
    draftStore.updateDraftStatus(draftId, "approved");
    const dest = draftStore.moveToApproved(draftId, dateStr);
    const text = formatTemplateB(draft, dest.replace(/^.*?(~)/, "~"));
    await telegramClient.sendMessage(state.telegram_chat_id, text);
  } else if (state.status === "rejected") {
    const dateStr = state.resolved_at.slice(0, 10);
    draftStore.updateDraftStatus(draftId, "rejected");
    draftStore.moveToRejected(draftId, dateStr);
  }
  // Other statuses (pending, modifying, superseded) — no-op
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/archive && npx vitest run`
Expected: 6 tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(archive): move drafts by status, send Template B on approve"
```

---

### Task 6: poller — core loop and callback dispatch

**Files:**
- Create: `~/.openclaw/workspace/skills/poller/package.json`
- Create: `~/.openclaw/workspace/skills/poller/SKILL.md`
- Create: `~/.openclaw/workspace/skills/poller/poller.js`
- Create: `~/.openclaw/workspace/skills/poller/tests/poller.test.js`

- [ ] **Step 1: Create package.json and SKILL.md**

`package.json`:
```json
{
  "name": "poller",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "shared": "file:../shared",
    "approval": "file:../approval",
    "archive": "file:../archive",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

`SKILL.md`:
```markdown
# Poller Skill

Long-polling daemon that listens for Telegram updates, dispatches callback queries (approve/modify/reject), handles slash commands, and processes modify replies.

## Usage

```bash
node bin/poll.js
```
```

- [ ] **Step 2: Install dependencies**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npm install`

- [ ] **Step 3: Write failing test for core poller**

Create `~/.openclaw/workspace/skills/poller/tests/poller.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { CALLBACK_PREFIXES, STATUSES } from "shared/constants";
import {
  handleCallback,
  handleModifyReply,
  isFromPairedUser,
} from "../poller.js";

let tmp, store;
const PAIRED_USER_ID = 5349931800;
const CHAT_ID = 5349931800;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "poller-"));
  mkdirSync(join(tmp, "pending"));
  mkdirSync(join(tmp, "approved"));
  mkdirSync(join(tmp, "rejected"));
  store = createDraftStore(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeDraft(id, stateOverrides = {}) {
  const draft = {
    id,
    mode: "clip",
    topic: "AI agents",
    caption: "Sam Altman explains why...",
    hashtags: ["#aiagents", "#lexfridman"],
    media: [{ path: "media/0.mp4", type: "video", duration_s: 47 }],
    source: null,
    status: "pending",
    parent_id: null,
  };
  const state = {
    status: "pending",
    telegram_message_id: 42,
    telegram_chat_id: CHAT_ID,
    sent_at: "2026-04-16T09:00:00Z",
    resolved_at: null,
    reject_reason: null,
    ...stateOverrides,
  };
  const dir = join(tmp, "pending", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function mockTelegramClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    getUpdates: vi.fn().mockResolvedValue([]),
  };
}

function mockArchive() {
  return { archiveDraft: vi.fn().mockResolvedValue(undefined) };
}

describe("isFromPairedUser", () => {
  test("returns true for message from paired user", () => {
    const update = { message: { from: { id: PAIRED_USER_ID }, text: "hi" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(true);
  });

  test("returns true for callback_query from paired user", () => {
    const update = { callback_query: { from: { id: PAIRED_USER_ID }, data: "a:x" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(true);
  });

  test("returns false for message from other user", () => {
    const update = { message: { from: { id: 999 }, text: "hi" } };
    expect(isFromPairedUser(update, PAIRED_USER_ID)).toBe(false);
  });
});

describe("handleCallback", () => {
  test("approve: updates state, edits message, calls archive", async () => {
    writeDraft("d-001");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-1",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.APPROVE}d-001`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", "Approved!");
    expect(client.editMessageText).toHaveBeenCalledTimes(1);
    const editText = client.editMessageText.mock.calls[0][2];
    expect(editText).toContain("✅ Approved");

    const { state } = store.readDraft("d-001");
    expect(state.status).toBe("approved");
    expect(state.resolved_at).toBeDefined();

    expect(archive.archiveDraft).toHaveBeenCalledWith("d-001", {
      draftStore: store,
      telegramClient: client,
    });
  });

  test("reject: updates state, edits message, calls archive", async () => {
    writeDraft("d-002");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-2",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.REJECT}d-002`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-2", "Rejected");
    const { state } = store.readDraft("d-002");
    expect(state.status).toBe("rejected");
    expect(archive.archiveDraft).toHaveBeenCalledWith("d-002", {
      draftStore: store,
      telegramClient: client,
    });
  });

  test("modify: updates state, edits message, does NOT call archive", async () => {
    writeDraft("d-003");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-3",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.MODIFY}d-003`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith("cbq-3", "Send your changes");
    const editText = client.editMessageText.mock.calls[0][2];
    expect(editText).toContain("✏️ Awaiting changes");
    const { state } = store.readDraft("d-003");
    expect(state.status).toBe("modifying");
    expect(archive.archiveDraft).not.toHaveBeenCalled();
  });

  test("modify rejected when another draft is already modifying", async () => {
    writeDraft("d-004", { status: "modifying" });
    writeDraft("d-005");
    const client = mockTelegramClient();
    const archive = mockArchive();
    const cbq = {
      id: "cbq-4",
      from: { id: PAIRED_USER_ID },
      message: { chat: { id: CHAT_ID }, message_id: 42 },
      data: `${CALLBACK_PREFIXES.MODIFY}d-005`,
    };
    await handleCallback(cbq, { telegramClient: client, draftStore: store, archive });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq-4",
      expect.stringContaining("Another draft")
    );
    const { state } = store.readDraft("d-005");
    expect(state.status).toBe("pending");
  });
});

describe("handleModifyReply", () => {
  test("routes text to modifying draft when one exists", async () => {
    writeDraft("d-010", { status: "modifying" });
    const client = mockTelegramClient();
    const mockRouter = {
      complete: vi.fn().mockResolvedValue({
        text: "Revised caption here",
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 100,
        providerUsed: "ollama:qwen2.5:14b",
      }),
    };
    const mockApproval = {
      sendForApproval: vi.fn().mockResolvedValue({ messageId: 200 }),
    };
    const message = {
      from: { id: PAIRED_USER_ID },
      chat: { id: CHAT_ID },
      text: "Make it shorter",
    };
    await handleModifyReply(message, {
      telegramClient: client,
      draftStore: store,
      router: mockRouter,
      approval: mockApproval,
    });

    // Old draft should be superseded
    const { state: oldState } = store.readDraft("d-010");
    expect(oldState.status).toBe("superseded");

    // Router should have been called with the write task class
    expect(mockRouter.complete).toHaveBeenCalledTimes(1);
    const routerArgs = mockRouter.complete.mock.calls[0][0];
    expect(routerArgs.taskClass).toBe("write");
    expect(routerArgs.prompt).toContain("Make it shorter");
    expect(routerArgs.prompt).toContain("Sam Altman explains why...");

    // New draft should have been sent for approval
    expect(mockApproval.sendForApproval).toHaveBeenCalledTimes(1);
  });

  test("ignores text when no draft is modifying", async () => {
    writeDraft("d-020");
    const client = mockTelegramClient();
    const mockRouter = { complete: vi.fn() };
    const mockApproval = { sendForApproval: vi.fn() };
    const message = {
      from: { id: PAIRED_USER_ID },
      chat: { id: CHAT_ID },
      text: "random text",
    };
    await handleModifyReply(message, {
      telegramClient: client,
      draftStore: store,
      router: mockRouter,
      approval: mockApproval,
    });
    expect(mockRouter.complete).not.toHaveBeenCalled();
    expect(mockApproval.sendForApproval).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npx vitest run tests/poller.test.js`
Expected: FAIL — `poller.js` does not exist

- [ ] **Step 5: Add writeDraft to draft-store (needed for modify flow)**

Add to `~/.openclaw/workspace/skills/shared/draft-store.js` — add this method inside `createDraftStore` before the return:

```js
  function writeDraft(id, draftData) {
    const dir = join(pendingDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "draft.json"), JSON.stringify(draftData, null, 2));
  }
```

And update the return statement to include `writeDraft`:

```js
  return {
    readDraft,
    writeDraft,
    writeState,
    updateState,
    updateDraftStatus,
    moveToApproved,
    moveToRejected,
    listPending,
    findModifying,
  };
```

- [ ] **Step 5a: Add test for writeDraft in draft-store**

Add to `~/.openclaw/workspace/skills/shared/tests/draft-store.test.js`:

```js
  test("writeDraft creates draft.json in pending/<id>/", () => {
    const draftData = { id: "new-001", caption: "new draft" };
    store.writeDraft("new-001", draftData);
    const raw = JSON.parse(
      readFileSync(join(tmp, "pending", "new-001", "draft.json"), "utf8")
    );
    expect(raw.id).toBe("new-001");
    expect(raw.caption).toBe("new draft");
  });
```

- [ ] **Step 5b: Run shared tests to verify writeDraft works**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/shared && npm test`
Expected: All 23 tests PASS (11 draft-store now)

- [ ] **Step 5c: Implement poller.js**

Create `~/.openclaw/workspace/skills/poller/poller.js`:

```js
import { CALLBACK_PREFIXES, STATUSES } from "shared/constants";

export function isFromPairedUser(update, pairedUserId) {
  const from = update.callback_query?.from || update.message?.from;
  return from?.id === pairedUserId;
}

function parseCallbackData(data) {
  if (data.startsWith(CALLBACK_PREFIXES.APPROVE)) {
    return { action: "approve", draftId: data.slice(2) };
  }
  if (data.startsWith(CALLBACK_PREFIXES.MODIFY)) {
    return { action: "modify", draftId: data.slice(2) };
  }
  if (data.startsWith(CALLBACK_PREFIXES.REJECT)) {
    return { action: "reject", draftId: data.slice(2) };
  }
  return null;
}

export async function handleCallback(cbq, { telegramClient, draftStore, archive }) {
  const parsed = parseCallbackData(cbq.data);
  if (!parsed) return;

  const { action, draftId } = parsed;
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  const { draft } = draftStore.readDraft(draftId);
  const now = new Date().toISOString();

  if (action === "approve") {
    await telegramClient.answerCallbackQuery(cbq.id, "Approved!");
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n✅ Approved → posting queue`
    );
    draftStore.updateState(draftId, { status: STATUSES.APPROVED, resolved_at: now });
    await archive.archiveDraft(draftId, { draftStore, telegramClient });
  } else if (action === "reject") {
    await telegramClient.answerCallbackQuery(cbq.id, "Rejected");
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n❌ Rejected`
    );
    draftStore.updateState(draftId, { status: STATUSES.REJECTED, resolved_at: now });
    await archive.archiveDraft(draftId, { draftStore, telegramClient });
  } else if (action === "modify") {
    const existing = draftStore.findModifying();
    if (existing) {
      await telegramClient.answerCallbackQuery(
        cbq.id,
        "Another draft is being modified. Finish or /cancel that first."
      );
      return;
    }
    await telegramClient.answerCallbackQuery(cbq.id, "Send your changes");
    await telegramClient.editMessageText(
      chatId,
      messageId,
      `~${draft.caption}~\n\n✏️ Awaiting changes...`
    );
    draftStore.updateState(draftId, { status: STATUSES.MODIFYING });
  }
}

export async function handleModifyReply(message, { telegramClient, draftStore, router, approval }) {
  const modifyingId = draftStore.findModifying();
  if (!modifyingId) return;

  const { draft: oldDraft } = draftStore.readDraft(modifyingId);
  const chatId = message.chat.id;
  const feedback = message.text;

  const prompt = [
    `Original caption: "${oldDraft.caption}"`,
    `Topic: ${oldDraft.topic}`,
    `Hashtags: ${oldDraft.hashtags.join(" ")}`,
    "",
    `User feedback: ${feedback}`,
    "",
    "Rewrite the caption incorporating the feedback.",
  ].join("\n");

  const result = await router.complete({ taskClass: "write", prompt });

  // Supersede old draft
  draftStore.updateState(modifyingId, { status: STATUSES.SUPERSEDED });

  // Create new draft
  const newId = `${modifyingId}-mod-${Date.now()}`;
  const newDraft = {
    ...oldDraft,
    id: newId,
    caption: result.text,
    created_at: new Date().toISOString(),
    provider_used: result.providerUsed,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    status: "pending",
    parent_id: modifyingId,
  };
  draftStore.writeDraft(newId, newDraft);

  // Send new draft for approval
  await approval.sendForApproval(newId, { telegramClient, draftStore, chatId });
}

export function createPollLoop({ telegramClient, draftStore, archive, approval, router, pairedUserId, commands }) {
  let running = true;
  let offset = 0;
  let backoff = 1000;

  function stop() {
    running = false;
  }

  async function run() {
    while (running) {
      try {
        const updates = await telegramClient.getUpdates(offset, 30);
        backoff = 1000;
        for (const update of updates) {
          offset = update.update_id + 1;
          if (!isFromPairedUser(update, pairedUserId)) continue;

          try {
            if (update.callback_query) {
              await handleCallback(update.callback_query, {
                telegramClient,
                draftStore,
                archive,
              });
            } else if (update.message?.text?.startsWith("/")) {
              const text = update.message.text;
              const chatId = update.message.chat.id;
              const spaceIdx = text.indexOf(" ");
              const name = (spaceIdx === -1 ? text : text.slice(0, spaceIdx))
                .slice(1)
                .toLowerCase();
              const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
              const handler = commands[name];
              if (handler) {
                await handler(chatId, args, telegramClient);
              } else {
                await telegramClient.sendMessage(
                  chatId,
                  "Unknown command. Try /help"
                );
              }
            } else if (update.message?.text) {
              await handleModifyReply(update.message, {
                telegramClient,
                draftStore,
                router,
                approval,
              });
            }
          } catch (err) {
            console.error(`Error handling update ${update.update_id}:`, err);
          }
        }
      } catch (err) {
        console.error(`getUpdates failed, retrying in ${backoff}ms:`, err);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  return { run, stop };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npx vitest run tests/poller.test.js`
Expected: 7 tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(poller): core loop, callback dispatch, modify flow"
```

---

### Task 7: poller — slash commands

**Files:**
- Create: `~/.openclaw/workspace/skills/poller/commands/mode.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/status.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/queue.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/spend.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/whoami.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/help.js`
- Create: `~/.openclaw/workspace/skills/poller/commands/cancel.js`
- Create: `~/.openclaw/workspace/skills/poller/tests/commands.test.js`

- [ ] **Step 1: Write failing tests for all 7 commands**

Create `~/.openclaw/workspace/skills/poller/tests/commands.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { createModeCommand } from "../commands/mode.js";
import { createStatusCommand } from "../commands/status.js";
import { createQueueCommand } from "../commands/queue.js";
import { createSpendCommand } from "../commands/spend.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { helpCommand } from "../commands/help.js";
import { createCancelCommand } from "../commands/cancel.js";

let tmp;
const CHAT_ID = 5349931800;

function mockClient() {
  return { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cmds-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("/mode", () => {
  test("no args returns current mode", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("local");
  });

  test("with valid arg switches mode", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "hybrid", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("hybrid");
  });

  test("hybrid without API key refuses", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    delete process.env.ANTHROPIC_API_KEY;
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "hybrid", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("ANTHROPIC_API_KEY");
  });
});

describe("/status", () => {
  test("reports pending count and service status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "pending", "d-001"));
    writeFileSync(join(tmp, "pending", "d-001", "state.json"), '{"status":"pending"}');
    const store = createDraftStore(tmp);
    const cmd = createStatusCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("1");
    globalThis.fetch = originalFetch;
  });
});

describe("/queue", () => {
  test("lists pending drafts", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "pending", "d-001"));
    writeFileSync(
      join(tmp, "pending", "d-001", "draft.json"),
      '{"id":"d-001","mode":"clip","topic":"AI"}'
    );
    writeFileSync(join(tmp, "pending", "d-001", "state.json"), '{"status":"pending"}');
    const store = createDraftStore(tmp);
    const cmd = createQueueCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("d-001");
    expect(text).toContain("pending");
  });

  test("filters out superseded drafts", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "pending", "d-old"));
    writeFileSync(
      join(tmp, "pending", "d-old", "draft.json"),
      '{"id":"d-old","mode":"clip","topic":"old"}'
    );
    writeFileSync(join(tmp, "pending", "d-old", "state.json"), '{"status":"superseded"}');
    const store = createDraftStore(tmp);
    const cmd = createQueueCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).not.toContain("d-old");
    expect(text).toContain("No pending drafts");
  });
});

describe("/spend", () => {
  test("reports today spend and MTD", async () => {
    const logPath = join(tmp, "router.jsonl");
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      logPath,
      `{"kind":"call","ok":true,"ts":"${today}T09:00:00Z","providerName":"ollama","modelName":"qwen2.5:14b","tokensIn":100,"tokensOut":50}\n`
    );
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      'spend:\n  daily_cap_usd: 1.00\n  cost_per_million_tokens:\n    "ollama:*": { in: 0.00, out: 0.00 }\n'
    );
    const cmd = createSpendCommand(logPath, configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("$");
    expect(text).toContain("cap");
  });
});

describe("/whoami", () => {
  test("reports user ID", async () => {
    const cmd = createWhoamiCommand(5349931800);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("5349931800");
  });
});

describe("/help", () => {
  test("lists all commands", async () => {
    const client = mockClient();
    await helpCommand(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("/mode");
    expect(text).toContain("/status");
    expect(text).toContain("/queue");
    expect(text).toContain("/spend");
    expect(text).toContain("/whoami");
    expect(text).toContain("/help");
    expect(text).toContain("/cancel");
  });
});

describe("/cancel", () => {
  test("cancels modifying draft and restores to pending", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "pending", "d-mod"));
    writeFileSync(
      join(tmp, "pending", "d-mod", "draft.json"),
      '{"id":"d-mod","mode":"clip","topic":"test"}'
    );
    writeFileSync(
      join(tmp, "pending", "d-mod", "state.json"),
      '{"status":"modifying","telegram_message_id":42}'
    );
    const store = createDraftStore(tmp);
    const cmd = createCancelCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("cancelled");
    const state = JSON.parse(
      readFileSync(join(tmp, "pending", "d-mod", "state.json"), "utf8")
    );
    expect(state.status).toBe("pending");
  });

  test("reports nothing to cancel when no draft is modifying", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    const store = createDraftStore(tmp);
    const cmd = createCancelCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("Nothing to cancel");
  });
});
```

Add `readFileSync` to the test imports at the top:

```js
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npx vitest run tests/commands.test.js`
Expected: FAIL — command files do not exist

- [ ] **Step 3: Implement all 6 command files**

Create `~/.openclaw/workspace/skills/poller/commands/mode.js`:

```js
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const VALID_MODES = ["local", "hybrid", "premium"];

export function createModeCommand(configPath) {
  return async function modeCommand(chatId, args, client) {
    const config = yaml.load(readFileSync(configPath, "utf8"));

    if (!args) {
      await client.sendMessage(chatId, `Current mode: ${config.current_mode}`);
      return;
    }

    const mode = args.toLowerCase().trim();
    if (!VALID_MODES.includes(mode)) {
      await client.sendMessage(chatId, `Invalid mode. Choose: ${VALID_MODES.join(", ")}`);
      return;
    }

    if ((mode === "hybrid" || mode === "premium") && !process.env.ANTHROPIC_API_KEY) {
      await client.sendMessage(
        chatId,
        `Cannot switch to ${mode}: ANTHROPIC_API_KEY not set.\nAdd it to ~/.openclaw/workspace/.env and restart.`
      );
      return;
    }

    config.current_mode = mode;
    writeFileSync(configPath, yaml.dump(config));
    await client.sendMessage(chatId, `Mode switched to: ${mode}`);
  };
}
```

Create `~/.openclaw/workspace/skills/poller/commands/status.js`:

```js
export function createStatusCommand(draftStore) {
  return async function statusCommand(chatId, args, client) {
    let gatewayOk = false;
    let ollamaOk = false;

    try {
      const res = await fetch("http://127.0.0.1:18789/health");
      gatewayOk = res.ok;
    } catch { /* unreachable */ }

    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags");
      ollamaOk = res.ok;
    } catch { /* unreachable */ }

    const pending = draftStore.listPending();
    const lines = [
      `Gateway: ${gatewayOk ? "✅ up" : "❌ down"}`,
      `Ollama: ${ollamaOk ? "✅ up" : "❌ down"}`,
      `Pending drafts: ${pending.length}`,
    ];
    await client.sendMessage(chatId, lines.join("\n"));
  };
}
```

Create `~/.openclaw/workspace/skills/poller/commands/queue.js`:

```js
export function createQueueCommand(draftStore) {
  return async function queueCommand(chatId, args, client) {
    const ids = draftStore.listPending();
    if (ids.length === 0) {
      await client.sendMessage(chatId, "No pending drafts.");
      return;
    }
    const lines = ids.map((id) => {
      const { draft, state } = draftStore.readDraft(id);
      return `• ${id} [${state?.status || "unknown"}] — ${draft?.mode || "?"}: ${draft?.topic || ""}`;
    });
    await client.sendMessage(chatId, `Pending drafts (${ids.length}):\n${lines.join("\n")}`);
  };
}
```

Create `~/.openclaw/workspace/skills/poller/commands/spend.js`:

```js
import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

export function createSpendCommand(logPath, configPath) {
  return async function spendCommand(chatId, args, client) {
    const config = yaml.load(readFileSync(configPath, "utf8"));
    const cap = config?.spend?.daily_cap_usd ?? 1.0;
    const costCfg = config?.spend?.cost_per_million_tokens ?? {};

    let todayTotal = 0;
    let mtdTotal = 0;
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.kind !== "call" || !entry.ok) continue;
        const pm = `${entry.providerName}:${entry.modelName}`;
        const provider = entry.providerName;
        const rate = costCfg[pm] || costCfg[`${provider}:*`];
        if (!rate) continue;
        const cost =
          ((entry.tokensIn || 0) / 1_000_000) * rate.in +
          ((entry.tokensOut || 0) / 1_000_000) * rate.out;
        if (entry.ts?.startsWith(today)) todayTotal += cost;
        if (entry.ts?.startsWith(month)) mtdTotal += cost;
      }
    }

    await client.sendMessage(
      chatId,
      `Today: $${todayTotal.toFixed(4)} / cap $${cap.toFixed(2)}\nMTD: $${mtdTotal.toFixed(4)}`
    );
  };
}
```

Create `~/.openclaw/workspace/skills/poller/commands/whoami.js`:

```js
export function createWhoamiCommand(pairedUserId) {
  return async function whoamiCommand(chatId, args, client) {
    await client.sendMessage(
      chatId,
      `Paired user ID: ${pairedUserId}\nStatus: ✅ paired`
    );
  };
}
```

Create `~/.openclaw/workspace/skills/poller/commands/help.js`:

```js
const HELP_TEXT = [
  "Available commands:",
  "/mode [local|hybrid|premium] — View or change provider mode",
  "/status — Daemon health, pending drafts",
  "/queue — List pending drafts",
  "/spend [cap N] — View spend or set daily cap",
  "/cancel — Cancel current modify, restore draft to pending",
  "/whoami — Show paired user ID",
  "/help — This message",
].join("\n");

export async function helpCommand(chatId, args, client) {
  await client.sendMessage(chatId, HELP_TEXT);
}
```

Create `~/.openclaw/workspace/skills/poller/commands/cancel.js`:

```js
export function createCancelCommand(draftStore) {
  return async function cancelCommand(chatId, args, client) {
    const modifyingId = draftStore.findModifying();
    if (!modifyingId) {
      await client.sendMessage(chatId, "Nothing to cancel — no draft is being modified.");
      return;
    }
    draftStore.updateState(modifyingId, { status: "pending" });
    await client.sendMessage(chatId, `Modify cancelled for ${modifyingId}. Draft restored to pending.`);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npx vitest run tests/commands.test.js`
Expected: 10 tests PASS

- [ ] **Step 5: Run all poller tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && npm test`
Expected: All 17 tests PASS (7 poller + 10 commands)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(poller): add slash commands — /mode /status /queue /spend /whoami /help"
```

---

### Task 8: poller — bin/poll.js entry point

**Files:**
- Create: `~/.openclaw/workspace/skills/poller/bin/poll.js`

- [ ] **Step 1: Implement bin/poll.js**

Create `~/.openclaw/workspace/skills/poller/bin/poll.js`:

```js
#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { createTelegramClient } from "shared/telegram-client";
import { createDraftStore } from "shared/draft-store";
import { createPollLoop } from "../poller.js";
import { archiveDraft } from "archive/archive.js";
import { sendForApproval } from "approval/approval.js";
import { createModeCommand } from "../commands/mode.js";
import { createStatusCommand } from "../commands/status.js";
import { createQueueCommand } from "../commands/queue.js";
import { createSpendCommand } from "../commands/spend.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { helpCommand } from "../commands/help.js";
import { createCancelCommand } from "../commands/cancel.js";

// Paths
const workspacePath = join(homedir(), ".openclaw", "workspace");
const draftsPath = join(homedir(), "openclaw-drafts");
const configDir = join(workspacePath, "config");
const routerLogPath = join(workspacePath, "skills", "provider-router", "router.jsonl");
const providersPath = join(configDir, "providers.yaml");
const telegramPath = join(configDir, "telegram.yaml");

// Load config
const envPath = join(workspacePath, ".env");
const envContent = readFileSync(envPath, "utf8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const telegramConfig = yaml.load(readFileSync(telegramPath, "utf8"));
const token = process.env[telegramConfig.bot_token_env] || process.env.TG_BOT_TOKEN;
if (!token) {
  console.error("TG_BOT_TOKEN not set. Check .env file.");
  process.exit(1);
}

const pairedUserId = telegramConfig.paired_user_id;
if (!pairedUserId) {
  console.error("paired_user_id not set in telegram.yaml.");
  process.exit(1);
}

// Initialize
const telegramClient = createTelegramClient(token);
const draftStore = createDraftStore(draftsPath);

// Build command map
const commands = {
  mode: createModeCommand(providersPath),
  status: createStatusCommand(draftStore),
  queue: createQueueCommand(draftStore),
  spend: createSpendCommand(routerLogPath, providersPath),
  cancel: createCancelCommand(draftStore),
  whoami: createWhoamiCommand(pairedUserId),
  help: helpCommand,
};

// Note: router is not wired here yet for modify flow — would need to import
// and instantiate provider-router. For M1, modify flow works if provider-router
// is instantiated. This will be wired when testing the modify E2E.
const router = null;

const approval = { sendForApproval };
const archive = { archiveDraft };

const loop = createPollLoop({
  telegramClient,
  draftStore,
  archive,
  approval,
  router,
  pairedUserId,
  commands,
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  loop.stop();
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  loop.stop();
});

console.log(`Poller started. Listening for user ${pairedUserId}...`);
loop.run().then(() => {
  console.log("Poller stopped.");
  process.exit(0);
});
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x ~/.openclaw/workspace/skills/poller/bin/poll.js`

- [ ] **Step 3: Verify it starts (ctrl-c immediately)**

Run: `export PATH="/opt/homebrew/bin:$PATH" && cd ~/.openclaw/workspace/skills/poller && timeout 5 node bin/poll.js 2>&1 || true`
Expected: Should print "Poller started. Listening for user 5349931800..." then exit after timeout. If it errors, fix the error.

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(poller): add bin/poll.js CLI entry point"
```

---

### Task 9: Mirror workspace to repo and run all tests

**Files:**
- Modify: `~/Desktop/openclaw/workspace-mirror/`

- [ ] **Step 1: Mirror workspace skills to repo**

```bash
rsync -av --delete ~/.openclaw/workspace/skills/ ~/Desktop/openclaw/workspace-mirror/skills/ --exclude node_modules
```

- [ ] **Step 2: Run all test suites**

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd ~/.openclaw/workspace/skills/shared && npm test
cd ~/.openclaw/workspace/skills/approval && npm test
cd ~/.openclaw/workspace/skills/archive && npm test
cd ~/.openclaw/workspace/skills/poller && npm test
```

Expected: All ~39 tests PASS across 4 modules.

- [ ] **Step 3: Commit the mirror**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "mirror: sync workspace skills for M1 approval pipeline"
```

---

### Task 10: Manual E2E test

**No new files — this validates the full flow.**

- [ ] **Step 1: Create a test draft on disk**

```bash
mkdir -p ~/openclaw-drafts/pending/test-e2e-001
cat > ~/openclaw-drafts/pending/test-e2e-001/draft.json << 'EOF'
{
  "id": "test-e2e-001",
  "created_at": "2026-04-16T12:00:00Z",
  "mode": "quotecard",
  "topic": "Productivity tips",
  "niche": "make-money-with-ai",
  "caption": "Focus is a superpower. The ability to say no to everything except the one thing that matters is what separates the top 1% from everyone else.",
  "hashtags": ["#productivity", "#focus", "#success", "#mindset", "#growth"],
  "media": [],
  "source": null,
  "provider_used": "ollama:qwen2.5:14b",
  "tokens_in": 0,
  "tokens_out": 0,
  "status": "pending",
  "parent_id": null
}
EOF
```

- [ ] **Step 2: Send draft for approval via Node REPL**

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd ~/.openclaw/workspace/skills/poller
node -e "
import { readFileSync } from 'fs';
import { join, homedir } from 'path';
import yaml from 'js-yaml';
import { createTelegramClient } from 'shared/telegram-client';
import { createDraftStore } from 'shared/draft-store';
import { sendForApproval } from 'approval/approval.js';

const envContent = readFileSync(join(process.env.HOME, '.openclaw/workspace/.env'), 'utf8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}
const token = process.env.TG_BOT_TOKEN;
const client = createTelegramClient(token);
const store = createDraftStore(join(process.env.HOME, 'openclaw-drafts'));
const result = await sendForApproval('test-e2e-001', { telegramClient: client, draftStore: store, chatId: 5349931800 });
console.log('Message sent, ID:', result.messageId);
"
```

Expected: Template A message appears in Telegram with Approve/Modify/Reject buttons.

- [ ] **Step 3: Start the poller and test Approve**

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd ~/.openclaw/workspace/skills/poller
node bin/poll.js
# In Telegram: tap ✅ Approve
# Expected: message edited to "✅ Approved → posting queue", Template B sent, draft moved to approved/
```

Verify: `ls ~/openclaw-drafts/approved/2026-04-16/test-e2e-001/`

- [ ] **Step 4: Test Reject flow (create another test draft, repeat)**

- [ ] **Step 5: Test slash commands**

In Telegram while poller is running:
- `/status` — should show gateway/ollama status + pending count
- `/mode` — should show "local"
- `/queue` — should list pending drafts (or "No pending drafts" if all resolved)
- `/spend` — should show today's spend
- `/whoami` — should show user ID
- `/help` — should list all commands

- [ ] **Step 6: Commit any fixes from E2E testing**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "fix: address issues found during E2E testing"
```

---

### Task 11: Final push

- [ ] **Step 1: Run all tests one final time**

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd ~/.openclaw/workspace/skills/shared && npm test && \
cd ~/.openclaw/workspace/skills/approval && npm test && \
cd ~/.openclaw/workspace/skills/archive && npm test && \
cd ~/.openclaw/workspace/skills/poller && npm test
```

Expected: All tests PASS.

- [ ] **Step 2: Final mirror sync**

```bash
rsync -av --delete ~/.openclaw/workspace/skills/ ~/Desktop/openclaw/workspace-mirror/skills/ --exclude node_modules
```

- [ ] **Step 3: Commit and push**

```bash
cd ~/Desktop/openclaw
git add -A
git commit -m "feat(m1): complete M1 approval pipeline — approval, archive, poller, shared"
git push -u origin feat/plan-b-approval-pipeline
```

- [ ] **Step 4: Close beads issue**

```bash
bd close openclaw-qr9
bd dolt push
```
