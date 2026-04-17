# M3 Orchestration & Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `orchestrator` and `report` skills, `shared/quiet-queue.js` + `shared/jsonl-logger.js`, `scripts/install-cron.mjs`, and `config/cron.yaml` wiring so the M2 content pipeline runs unattended on a daily schedule via OpenClaw cron.

**Architecture:** Batch skills invoked per cron firing (`orchestrator --job=<phase>` and `report --job=nightly`). OpenClaw's Gateway-backed cron scheduler consumes jobs installed by a one-shot provisioner that reads `config/cron.yaml`. Daily-loop: research → hybrid topic↔episode match → generate 3 drafts (one per mode, distinct topics) → approval or quiet-queue. Morning flush at 08:00 drains overnight drafts; nightly report at 23:00 summarises the day.

**Tech Stack:** Node 22 ESM, Vitest, js-yaml, `child_process.execFile` from `node:child_process` (argv array form — never the single-string `exec` helper). All file-system state under `~/openclaw-drafts/`, all config under `~/.openclaw/workspace/config/`. Dependency injection throughout for testability.

---

## Conventions (read once before starting)

- **Skills live at:** `~/Desktop/openclaw/workspace-mirror/skills/<name>/` (source of truth for edits). After editing, primary agent rsyncs to `~/.openclaw/workspace/skills/<name>/`. Subagents write to the mirror only; they do not invoke Bash or shell tools.
- **Package shape:** every skill is a local npm package with `package.json` including `"type": "module"`, `"private": true`, `{vitest}` as devDep, and `"shared": "file:../shared"` as a dep when needed.
- **Tests live at:** `<skill>/tests/<name>.test.js` for shared, or `<skill>/<name>.test.js` co-located for other skills. Use `describe`/`it`/`expect` from Vitest.
- **Mocking:** all externals (fs, fetch, child_process, timers) are dependency-injected. No global mocks. Test fixtures in `/tmp/test-<uuid>/` (use `fs.mkdtempSync`) with cleanup in `afterEach`.
- **No shell interpolation:** subprocess calls use `execFile(cmd, [args...])` from `node:child_process`. Never use the single-string shell variant.
- **Draft IDs** created by this plan's code follow M2's convention: `2026-04-17-<mode>-<slug>-<rand>` (example: `2026-04-17-clip-altman-0x1a`).
- **Git flow:** commit after each task. Branch is `feat/plan-d-orchestration-scheduling` (already created). Never push to main; PR only. No `Co-Authored-By: Claude` lines.
- **Spec reference:** `docs/superpowers/specs/2026-04-17-m3-orchestration-scheduling-design.md`. Section references below (e.g., §2.3) are into that spec.

---

## File Structure

```
workspace-mirror/
├── bin/
│   └── smoke-run.js                     (modify: add --orchestrator flag)
├── config/
│   └── cron.yaml                        (modify: fill in 6 jobs)
├── scripts/                             (NEW dir)
│   ├── install-cron.mjs                 (NEW)
│   ├── install-cron.test.mjs            (NEW)
│   └── package.json                     (NEW)
└── skills/
    ├── shared/
    │   ├── package.json                 (modify: add exports)
    │   ├── quiet-queue.js               (NEW)
    │   ├── jsonl-logger.js              (NEW)
    │   └── tests/
    │       ├── quiet-queue.test.js      (NEW)
    │       └── jsonl-logger.test.js     (NEW)
    ├── archive/
    │   ├── archive.js                   (modify: export pruneCache)
    │   ├── bin/archive.js               (NEW — CLI phase dispatcher)
    │   └── archive.test.js              (modify: add pruneCache cases)
    ├── orchestrator/                    (NEW skill)
    │   ├── package.json                 (NEW)
    │   ├── index.js                     (NEW)
    │   ├── daily-loop.js                (NEW)
    │   ├── topic-episode-match.js       (NEW)
    │   ├── time.js                      (NEW)
    │   ├── flush-quiet-queue.js         (NEW)
    │   ├── source-discovery-pull.js     (NEW)
    │   ├── bin/orchestrator.js          (NEW)
    │   ├── daily-loop.test.js           (NEW)
    │   ├── topic-episode-match.test.js  (NEW)
    │   ├── time.test.js                 (NEW)
    │   ├── flush-quiet-queue.test.js    (NEW)
    │   ├── source-discovery-pull.test.js(NEW)
    │   └── README.md                    (NEW)
    └── report/                          (NEW skill)
        ├── package.json                 (NEW)
        ├── index.js                     (NEW)
        ├── digest-data.js               (NEW)
        ├── digest-render.js             (NEW)
        ├── bin/report.js                (NEW)
        ├── digest-data.test.js          (NEW)
        ├── digest-render.test.js        (NEW)
        └── README.md                    (NEW)
```

**Responsibility map:**
- `shared/quiet-queue.js` — append-only JSONL store with lockfile; `append/drain/commitDrain/putBack/peek`
- `shared/jsonl-logger.js` — simple append-line logger; `createLogger(path)` returns `{jsonl, errorjsonl}`
- `skills/orchestrator/time.js` — `isInQuietHours(now, quietHours)` — pure function, ~20 lines
- `skills/orchestrator/topic-episode-match.js` — Jaccard prefilter + LLM reasoning match; returns `{topic, episode, confidence, via}` or null
- `skills/orchestrator/daily-loop.js` — the 6-step main loop described in spec §3
- `skills/orchestrator/flush-quiet-queue.js` — reads `quiet-queue.jsonl`, sends one morning digest DM
- `skills/orchestrator/source-discovery-pull.js` — iterates niches.yaml, calls `sourceDiscovery.runPull(niche)` per niche
- `skills/orchestrator/index.js` — barrel; exports `runDailyLoop`, `flushQuietQueue`, `runSourceDiscoveryPull`
- `skills/orchestrator/bin/orchestrator.js` — CLI dispatcher on `--job=<phase>`
- `skills/report/digest-data.js` — read-only scanners of drafts folder + log files
- `skills/report/digest-render.js` — pure string formatter
- `skills/report/index.js` — `renderDigest`, `sendNightlyReport`
- `skills/archive/archive.js` — extended with `pruneCache(opts)` using explicit subdir allow-list
- `scripts/install-cron.mjs` — idempotent provisioner of OpenClaw cron jobs

---

# Phase 1 — Shared infrastructure

## Task 1: `shared/jsonl-logger.js` — append-line logger

**Files:**
- Create: `workspace-mirror/skills/shared/jsonl-logger.js`
- Create: `workspace-mirror/skills/shared/tests/jsonl-logger.test.js`
- Modify: `workspace-mirror/skills/shared/package.json`

- [ ] **Step 1: Write the failing test**

Create `workspace-mirror/skills/shared/tests/jsonl-logger.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../jsonl-logger.js";

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "jsonl-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("createLogger", () => {
  it("appends one JSON line per jsonl() call", () => {
    const log = createLogger(join(tmp, "a.jsonl"));
    log.jsonl({ event: "x", n: 1 });
    log.jsonl({ event: "y", n: 2 });
    const lines = readFileSync(join(tmp, "a.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "x", n: 1 });
    expect(JSON.parse(lines[1])).toMatchObject({ event: "y", n: 2 });
  });

  it("creates parent directory if missing", () => {
    const p = join(tmp, "nested/deep/log.jsonl");
    const log = createLogger(p);
    log.jsonl({ ok: true });
    expect(existsSync(p)).toBe(true);
  });

  it("errorjsonl serializes message + stack + context", () => {
    const log = createLogger(join(tmp, "e.jsonl"));
    const err = new Error("boom");
    log.errorjsonl(err, { skill: "test", phase: "init" });
    const line = JSON.parse(readFileSync(join(tmp, "e.jsonl"), "utf8").trim());
    expect(line.message).toBe("boom");
    expect(line.stack).toMatch(/Error: boom/);
    expect(line.skill).toBe("test");
    expect(line.phase).toBe("init");
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Verify test fails**

Primary agent runs:
```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/jsonl-logger.test.js
```
Expected: FAIL — "Cannot find module '../jsonl-logger.js'".

- [ ] **Step 3: Write the implementation**

Create `workspace-mirror/skills/shared/jsonl-logger.js`:

```js
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createLogger(path) {
  function ensureDir() {
    mkdirSync(dirname(path), { recursive: true });
  }

  function jsonl(obj) {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
    appendFileSync(path, line);
  }

  function errorjsonl(err, context = {}) {
    jsonl({
      level: "error",
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
      ...context,
    });
  }

  return { jsonl, errorjsonl };
}
```

- [ ] **Step 4: Verify test passes**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/jsonl-logger.test.js
```
Expected: PASS — 3 passed.

- [ ] **Step 5: Add to shared/package.json exports**

Modify `workspace-mirror/skills/shared/package.json` — the exports block becomes:

```json
  "exports": {
    "./constants": "./constants.js",
    "./telegram-client": "./telegram-client.js",
    "./draft-store": "./draft-store.js",
    "./schemas": "./schemas.js",
    "./sources-store": "./sources-store.js",
    "./jsonl-logger": "./jsonl-logger.js",
    "./quiet-queue": "./quiet-queue.js"
  },
```

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/shared/jsonl-logger.js workspace-mirror/skills/shared/tests/jsonl-logger.test.js workspace-mirror/skills/shared/package.json
git commit -m "feat(shared): add jsonl-logger with ts-prefixed append-line writes"
```

---

## Task 2: `shared/quiet-queue.js` — append + peek

**Files:**
- Create: `workspace-mirror/skills/shared/quiet-queue.js`
- Create: `workspace-mirror/skills/shared/tests/quiet-queue.test.js`

- [ ] **Step 1: Write the failing tests**

Create `workspace-mirror/skills/shared/tests/quiet-queue.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuietQueue } from "../quiet-queue.js";

let tmp;
let qq;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qq-"));
  qq = createQuietQueue({ path: join(tmp, "quiet-queue.jsonl") });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("append + peek", () => {
  it("append writes a JSONL line", () => {
    qq.append({ draft_id: "2026-04-17-clip-001", created_at: "2026-04-17T03:00:00Z", mode: "clip", topic: "AI agents" });
    const content = readFileSync(join(tmp, "quiet-queue.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(content.trim());
    expect(parsed.draft_id).toBe("2026-04-17-clip-001");
  });

  it("two appends produce two lines", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const lines = readFileSync(join(tmp, "quiet-queue.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).draft_id).toBe("a");
    expect(JSON.parse(lines[1]).draft_id).toBe("b");
  });

  it("peek returns all appended entries without lock", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const entries = qq.peek();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.draft_id)).toEqual(["a", "b"]);
  });

  it("peek on missing file returns empty array", () => {
    const entries = qq.peek();
    expect(entries).toEqual([]);
  });

  it("append requires draft_id", () => {
    expect(() => qq.append({ created_at: "t", mode: "clip", topic: "x" })).toThrow(/draft_id/);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `workspace-mirror/skills/shared/quiet-queue.js`:

```js
import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

export function createQuietQueue({ path }) {
  const lockPath = path + ".lock";
  const processingPath = path + ".processing";

  function withLock(fn) {
    let fd = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          const holderPid = Number(readFileSync(lockPath, "utf8").trim());
          if (!isPidAlive(holderPid)) { unlinkSync(lockPath); continue; }
        } catch { try { unlinkSync(lockPath); } catch {} continue; }
        const end = Date.now() + 20;
        while (Date.now() < end) {}
      }
    }
    if (fd === null) throw new Error(`quiet-queue: lock timeout on ${lockPath}`);
    try { return fn(); }
    finally { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
  }

  function readLines(p) {
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => JSON.parse(line));
  }

  function append(entry) {
    if (!entry?.draft_id) throw new Error("quiet-queue.append: draft_id required");
    return withLock(() => {
      appendFileSync(path, JSON.stringify(entry) + "\n");
    });
  }

  function peek() {
    return readLines(path);
  }

  return { append, peek };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/shared/quiet-queue.js workspace-mirror/skills/shared/tests/quiet-queue.test.js
git commit -m "feat(shared): quiet-queue append/peek with pid-lockfile"
```

---

## Task 3: `shared/quiet-queue.js` — drain + orphan recovery

**Files:**
- Modify: `workspace-mirror/skills/shared/quiet-queue.js`
- Modify: `workspace-mirror/skills/shared/tests/quiet-queue.test.js`

- [ ] **Step 1: Write failing tests**

Append to `workspace-mirror/skills/shared/tests/quiet-queue.test.js`:

```js
describe("drain", () => {
  it("drain returns all entries and moves file to .processing", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const entries = qq.drain();
    expect(entries.map(e => e.draft_id)).toEqual(["a", "b"]);
    expect(existsSync(join(tmp, "quiet-queue.jsonl"))).toBe(false);
    expect(existsSync(join(tmp, "quiet-queue.jsonl.processing"))).toBe(true);
  });

  it("drain on missing file returns empty array", () => {
    expect(qq.drain()).toEqual([]);
  });

  it("drain recovers orphan .processing from prior crash", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.drain();
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    const entries = qq.drain();
    expect(entries.map(e => e.draft_id)).toEqual(["a", "b"]);
  });

  it("drain + second drain with no new appends returns orphans only", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.drain();
    const entries = qq.drain();
    expect(entries.map(e => e.draft_id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: 4 failures — `qq.drain is not a function`.

- [ ] **Step 3: Add drain to implementation**

Modify `workspace-mirror/skills/shared/quiet-queue.js` — replace the final `return { append, peek };` block with:

```js
  function drain() {
    return withLock(() => {
      const orphan = readLines(processingPath);
      const current = readLines(path);
      if (existsSync(path)) {
        if (orphan.length > 0) {
          const combined = [...orphan, ...current];
          const body = combined.map(e => JSON.stringify(e)).join("\n") + (combined.length > 0 ? "\n" : "");
          writeFileSync(processingPath, body);
          unlinkSync(path);
        } else {
          renameSync(path, processingPath);
        }
      }
      return [...orphan, ...current];
    });
  }

  return { append, peek, drain };
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/shared/quiet-queue.js workspace-mirror/skills/shared/tests/quiet-queue.test.js
git commit -m "feat(shared): quiet-queue drain with orphan .processing recovery"
```

---

## Task 4: `shared/quiet-queue.js` — commitDrain + putBack

**Files:**
- Modify: `workspace-mirror/skills/shared/quiet-queue.js`
- Modify: `workspace-mirror/skills/shared/tests/quiet-queue.test.js`

- [ ] **Step 1: Failing tests**

Append to `tests/quiet-queue.test.js`:

```js
describe("commitDrain + putBack", () => {
  it("commitDrain removes the .processing file", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    qq.drain();
    expect(existsSync(join(tmp, "quiet-queue.jsonl.processing"))).toBe(true);
    qq.commitDrain();
    expect(existsSync(join(tmp, "quiet-queue.jsonl.processing"))).toBe(false);
  });

  it("commitDrain with no .processing is a no-op", () => {
    expect(() => qq.commitDrain()).not.toThrow();
  });

  it("putBack restores entries and removes .processing", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    const entries = qq.drain();
    qq.putBack(entries);
    expect(existsSync(join(tmp, "quiet-queue.jsonl"))).toBe(true);
    expect(existsSync(join(tmp, "quiet-queue.jsonl.processing"))).toBe(false);
    expect(qq.peek()).toHaveLength(1);
    expect(qq.peek()[0].draft_id).toBe("a");
  });

  it("putBack preserves entries appended during drain", () => {
    qq.append({ draft_id: "a", created_at: "t", mode: "clip", topic: "x" });
    const entries = qq.drain();
    qq.append({ draft_id: "b", created_at: "t", mode: "slideshow", topic: "y" });
    qq.putBack(entries);
    const remaining = qq.peek();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(e => e.draft_id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: 4 failures.

- [ ] **Step 3: Add commitDrain + putBack to implementation**

Modify `quiet-queue.js` — replace `return { append, peek, drain };` with:

```js
  function commitDrain() {
    return withLock(() => {
      if (existsSync(processingPath)) unlinkSync(processingPath);
    });
  }

  function putBack(entries) {
    return withLock(() => {
      const lateAppends = readLines(path);
      const combined = [...entries, ...lateAppends];
      if (combined.length === 0) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        const tmpOut = path + ".tmp";
        writeFileSync(tmpOut, combined.map(e => JSON.stringify(e)).join("\n") + "\n");
        renameSync(tmpOut, path);
      }
      if (existsSync(processingPath)) unlinkSync(processingPath);
    });
  }

  return { append, peek, drain, commitDrain, putBack };
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/shared && npx vitest run tests/quiet-queue.test.js
```
Expected: PASS — 13 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/shared/quiet-queue.js workspace-mirror/skills/shared/tests/quiet-queue.test.js
git commit -m "feat(shared): quiet-queue commitDrain + putBack with late-append preservation"
```

---

# Phase 2 — Orchestrator skill

## Task 5: Scaffold `orchestrator` package

**Files:**
- Create: `workspace-mirror/skills/orchestrator/package.json`
- Create: `workspace-mirror/skills/orchestrator/index.js` (stub)
- Create: `workspace-mirror/skills/orchestrator/README.md`

- [ ] **Step 1: Create package.json**

Create `workspace-mirror/skills/orchestrator/package.json`:

```json
{
  "name": "orchestrator",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "shared": "file:../shared",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create index.js stub**

Create `workspace-mirror/skills/orchestrator/index.js`:

```js
export { runDailyLoop } from "./daily-loop.js";
export { matchTopicToEpisode } from "./topic-episode-match.js";
export { isInQuietHours } from "./time.js";
// flushQuietQueue + runSourceDiscoveryPull added in Task 11/12
```

- [ ] **Step 3: Create README**

Create `workspace-mirror/skills/orchestrator/README.md`:

```markdown
# orchestrator

The daily-loop engine. Runs once per cron firing.

## CLI

    bin/orchestrator.js --job=daily-loop|flush-quiet-queue|source-discovery-pull [--sandbox]

## Programmatic

    import { runDailyLoop } from "orchestrator";
    await runDailyLoop({ clock, providerRouter, skills, approval, logger, paths });

## Smoke tests

Sandbox (no Telegram, writes under /tmp/openclaw-smoke/):

    node bin/orchestrator.js --job=daily-loop --sandbox

Expected: 2-3 drafts under /tmp/openclaw-smoke/pending/ and a `daily_loop_complete`
line in /tmp/openclaw-smoke/logs/agent.jsonl.

## Tests

    npm test
```

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/
git commit -m "chore(orchestrator): scaffold package + README"
```

---

## Task 6: `orchestrator/time.js` — `isInQuietHours`

**Files:**
- Create: `workspace-mirror/skills/orchestrator/time.js`
- Create: `workspace-mirror/skills/orchestrator/time.test.js`

- [ ] **Step 1: Write failing tests**

Create `workspace-mirror/skills/orchestrator/time.test.js`:

```js
import { describe, it, expect } from "vitest";
import { isInQuietHours } from "./time.js";

function atLocal(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe("isInQuietHours — wrapping window (22:00-08:00)", () => {
  const window = { start: "22:00", end: "08:00" };
  it("inside at 23:30", () => expect(isInQuietHours(atLocal(23, 30), window)).toBe(true));
  it("inside at 03:00", () => expect(isInQuietHours(atLocal(3, 0), window)).toBe(true));
  it("outside at 09:00", () => expect(isInQuietHours(atLocal(9, 0), window)).toBe(false));
  it("outside at 12:00", () => expect(isInQuietHours(atLocal(12, 0), window)).toBe(false));
  it("boundary: 22:00 is quiet (start inclusive)", () => expect(isInQuietHours(atLocal(22, 0), window)).toBe(true));
  it("boundary: 08:00 is NOT quiet (end exclusive)", () => expect(isInQuietHours(atLocal(8, 0), window)).toBe(false));
  it("boundary: 07:59 is quiet", () => expect(isInQuietHours(atLocal(7, 59), window)).toBe(true));
});

describe("isInQuietHours — non-wrapping window (12:00-14:00)", () => {
  const window = { start: "12:00", end: "14:00" };
  it("inside at 13:00", () => expect(isInQuietHours(atLocal(13, 0), window)).toBe(true));
  it("outside at 11:00", () => expect(isInQuietHours(atLocal(11, 0), window)).toBe(false));
  it("outside at 15:00", () => expect(isInQuietHours(atLocal(15, 0), window)).toBe(false));
  it("boundary: 12:00 is quiet", () => expect(isInQuietHours(atLocal(12, 0), window)).toBe(true));
  it("boundary: 14:00 is NOT quiet", () => expect(isInQuietHours(atLocal(14, 0), window)).toBe(false));
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run time.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/orchestrator/time.js`:

```js
function hhmm(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function isInQuietHours(now, quietHours) {
  const t = hhmm(now);
  const { start, end } = quietHours;
  if (start > end) {
    return t >= start || t < end;
  }
  return t >= start && t < end;
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run time.test.js
```
Expected: PASS — 12 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/time.js workspace-mirror/skills/orchestrator/time.test.js
git commit -m "feat(orchestrator): isInQuietHours with wrap + boundary semantics"
```

---

## Task 7: `orchestrator/topic-episode-match.js` — keyword prefilter

**Files:**
- Create: `workspace-mirror/skills/orchestrator/topic-episode-match.js`
- Create: `workspace-mirror/skills/orchestrator/topic-episode-match.test.js`

- [ ] **Step 1: Write failing tests**

Create `workspace-mirror/skills/orchestrator/topic-episode-match.test.js`:

```js
import { describe, it, expect } from "vitest";
import { matchTopicToEpisode, jaccard, keywords } from "./topic-episode-match.js";

describe("jaccard", () => {
  it("identical sets = 1", () => expect(jaccard(new Set(["a","b"]), new Set(["a","b"]))).toBe(1));
  it("disjoint sets = 0", () => expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0));
  it("half overlap = 1/3", () => expect(jaccard(new Set(["a","b"]), new Set(["b","c"]))).toBeCloseTo(1/3, 3));
});

describe("keywords", () => {
  it("lowercases, tokenizes, removes stopwords, light-stems", () => {
    const kw = keywords("AI Agents replacing Junior Devs");
    expect(kw.has("ai")).toBe(true);
    expect(kw.has("agent")).toBe(true);
    expect(kw.has("replac")).toBe(true);
    expect(kw.has("junior")).toBe(true);
    expect(kw.has("dev")).toBe(true);
    expect(kw.has("the")).toBe(false);
    expect(kw.has("and")).toBe(false);
  });
});

describe("matchTopicToEpisode — keyword fallback path", () => {
  const now = new Date("2026-04-17T12:00:00Z");
  const freshTranscripts = [
    { source_id: "lex", episode_id: "ep-1", title: "Sam Altman on AGI timelines", transcribed_at: "2026-04-16T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "Welcome to the podcast." }] },
    { source_id: "lex", episode_id: "ep-2", title: "AI agents replacing junior devs deep-dive", transcribed_at: "2026-04-15T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "Today we discuss junior devs and AI." }] },
  ];
  const topics = [
    { topic: "AI agents replacing junior devs", source_url: "https://a.test/1", score: 0.9, niche: "ai" },
    { topic: "Crypto rally continues", source_url: "https://a.test/2", score: 0.8, niche: "ai" },
  ];

  it("LLM throws, keyword fallback picks ep-2", async () => {
    const router = { complete: async () => { throw new Error("router down"); } };
    const res = await matchTopicToEpisode(topics, freshTranscripts, router, { now });
    expect(res).not.toBeNull();
    expect(res.topic.topic).toBe("AI agents replacing junior devs");
    expect(res.episode.episode_id).toBe("ep-2");
    expect(res.via).toBe("keyword");
  });

  it("returns null when no recent transcripts", async () => {
    const router = { complete: async () => ({}) };
    const stale = freshTranscripts.map(t => ({ ...t, transcribed_at: "2026-01-01T00:00:00Z" }));
    const res = await matchTopicToEpisode(topics, stale, router, { now });
    expect(res).toBeNull();
  });

  it("returns null when no topic has any keyword overlap", async () => {
    const router = { complete: async () => { throw new Error("skip"); } };
    const unrelated = [{ topic: "Weather forecast Tuesday", source_url: "u", score: 1, niche: "x" }];
    const res = await matchTopicToEpisode(unrelated, freshTranscripts, router, { now });
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run topic-episode-match.test.js
```
Expected: FAIL.

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/orchestrator/topic-episode-match.js`:

```js
const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","has","have","had","do","does","did",
  "this","that","these","those","it","its","as","from","up","about","into","over",
  "then","than","so","if","not","no"
]);

function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ing")) return word.slice(0, -3);
  if (word.endsWith("ed")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function keywords(text) {
  const tokens = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w))
    .map(stem);
  return new Set(tokens);
}

export function jaccard(a, b) {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

const RECENT_DAYS = 7;
const KEYWORD_FALLBACK_THRESHOLD = 0.15;
const LLM_CONFIDENCE_THRESHOLD = 0.5;

function daysSince(isoTs, now) {
  return (now.getTime() - new Date(isoTs).getTime()) / (1000 * 60 * 60 * 24);
}

function summarySnippet(ep) {
  return (ep.segments || []).slice(0, 20).map(s => s.text).join(" ");
}

function renderMatchPrompt(topic, candidates) {
  const list = candidates.map((c, i) =>
    `${i + 1}. episode_id=${c.ep.episode_id}\n   title: ${c.ep.title}\n   snippet: ${summarySnippet(c.ep).slice(0, 400)}`
  ).join("\n\n");
  return `Pick the best episode match for this topic. Return JSON {best_episode_id, confidence, reasoning}.\n\nTopic: ${topic.topic}\n\nCandidates:\n${list}`;
}

export async function matchTopicToEpisode(topics, transcripts, router, { now = new Date() } = {}) {
  const recent = (transcripts || []).filter(t => daysSince(t.transcribed_at, now) <= RECENT_DAYS);
  if (recent.length === 0) return null;

  for (const topic of topics) {
    const kwTopic = keywords(topic.topic);
    const scored = recent.map(ep => {
      const kwEp = keywords(ep.title + " " + summarySnippet(ep));
      return { ep, score: jaccard(kwTopic, kwEp) };
    }).sort((a, b) => b.score - a.score).slice(0, 3);

    if (scored.length === 0 || scored[0].score === 0) continue;

    try {
      const prompt = renderMatchPrompt(topic, scored);
      const resp = await router.complete({ taskClass: "reason", prompt });
      const parsed = typeof resp === "string"
        ? JSON.parse(resp)
        : (resp?.parsed ?? JSON.parse(resp?.text ?? "{}"));
      if (parsed?.confidence >= LLM_CONFIDENCE_THRESHOLD) {
        const pick = scored.find(c => c.ep.episode_id === parsed.best_episode_id);
        if (pick) return { topic, episode: pick.ep, confidence: parsed.confidence, via: "llm" };
      }
    } catch {
      // fall through to keyword
    }

    if (scored[0].score >= KEYWORD_FALLBACK_THRESHOLD) {
      return { topic, episode: scored[0].ep, confidence: scored[0].score, via: "keyword" };
    }
  }

  return null;
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run topic-episode-match.test.js
```
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/topic-episode-match.js workspace-mirror/skills/orchestrator/topic-episode-match.test.js
git commit -m "feat(orchestrator): topic-episode-match jaccard prefilter + LLM top-3"
```

---

## Task 8: `topic-episode-match` — LLM success paths

**Files:**
- Modify: `workspace-mirror/skills/orchestrator/topic-episode-match.test.js`

- [ ] **Step 1: Add LLM success test cases**

Append to `topic-episode-match.test.js`:

```js
describe("matchTopicToEpisode — LLM path", () => {
  const now = new Date("2026-04-17T12:00:00Z");
  const transcripts = [
    { source_id: "lex", episode_id: "ep-1", title: "Sam Altman on AGI timelines", transcribed_at: "2026-04-16T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "AGI and autonomous systems." }] },
    { source_id: "lex", episode_id: "ep-2", title: "Football tactics 101", transcribed_at: "2026-04-16T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "Zone defense matters." }] },
  ];
  const topics = [
    { topic: "AI agents replacing junior devs", source_url: "u1", score: 1, niche: "ai" },
  ];

  it("LLM picks a candidate with confidence >= 0.5 → via:llm", async () => {
    const router = { complete: async () => JSON.stringify({ best_episode_id: "ep-1", confidence: 0.82, reasoning: "AGI relates" }) };
    const res = await matchTopicToEpisode(topics, transcripts, router, { now });
    expect(res.via).toBe("llm");
    expect(res.episode.episode_id).toBe("ep-1");
    expect(res.confidence).toBe(0.82);
  });

  it("LLM low confidence → falls through to keyword (or null)", async () => {
    const router = { complete: async () => JSON.stringify({ best_episode_id: "ep-1", confidence: 0.3 }) };
    const res = await matchTopicToEpisode(topics, transcripts, router, { now });
    // Top candidate "ep-1" keyword score is low for topic "AI agents replacing junior devs"
    // (overlap = just "AI"). Likely below keyword threshold 0.15 → null.
    // If the test machine's keyword tokenization produces a higher overlap, loosen the assertion.
    expect(res).toBeNull();
  });

  it("LLM returns episode_id not in candidate set → falls through", async () => {
    const router = { complete: async () => JSON.stringify({ best_episode_id: "ep-hallucinated", confidence: 0.99 }) };
    const res = await matchTopicToEpisode(topics, transcripts, router, { now });
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run topic-episode-match.test.js
```
Expected: PASS — 12 passed total.

If the low-confidence or hallucinated-id test fails because keyword overlap crosses the 0.15 threshold in the test fixture, adjust either the fixture (more distinctive titles) or the threshold comment — the behavior under test is "LLM failure routes through keyword fallback," which either outcome satisfies.

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/topic-episode-match.test.js
git commit -m "test(orchestrator): topic-episode-match LLM success/low-conf/hallucinated"
```

---

## Task 9: `daily-loop.js` — steps 1-3 + end-to-end happy path

**Files:**
- Create: `workspace-mirror/skills/orchestrator/daily-loop.js`
- Create: `workspace-mirror/skills/orchestrator/daily-loop.test.js`

- [ ] **Step 1: Write failing tests**

Create `workspace-mirror/skills/orchestrator/daily-loop.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDailyLoop } from "./daily-loop.js";

let tmp;
let paths;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dl-"));
  paths = { workspace: join(tmp, "workspace"), drafts: join(tmp, "drafts") };
  mkdirSync(join(paths.workspace, "config"), { recursive: true });
  mkdirSync(join(paths.drafts, "pending"), { recursive: true });
  mkdirSync(join(paths.drafts, "approved"), { recursive: true });
  mkdirSync(join(paths.drafts, "rejected"), { recursive: true });
  mkdirSync(join(paths.drafts, "logs"), { recursive: true });
  writeFileSync(join(paths.workspace, "config/niches.yaml"),
    `niches:\n  ai:\n    rss: []\n    web_search_queries: []\n`);
  writeFileSync(join(paths.workspace, "config/telegram.yaml"),
    `quiet_hours:\n  start: "22:00"\n  end: "08:00"\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSkills(overrides = {}) {
  return {
    research: {
      run: vi.fn().mockResolvedValue([
        { topic: "AI agents replacing junior devs", source_url: "https://a.test/1", score: 0.9, niche: "ai" },
        { topic: "Open-source LLMs surge", source_url: "https://a.test/2", score: 0.8, niche: "ai" },
        { topic: "Crypto rally today", source_url: "https://a.test/3", score: 0.7, niche: "ai" },
      ]),
    },
    clipExtract: { run: vi.fn().mockResolvedValue({ draft: { id: "d-clip-1", mode: "clip" } }) },
    slideshowDraft: { run: vi.fn().mockResolvedValue({ draft: { id: "d-slide-1", mode: "slideshow" } }) },
    quotecardDraft: { run: vi.fn().mockResolvedValue({ draft: { id: "d-quote-1", mode: "quotecard" } }) },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
  return {
    clock: new Date(2026, 3, 17, 9, 5),  // local 09:05 — outside quiet hours
    providerRouter: { complete: vi.fn().mockRejectedValue(new Error("no llm")) },
    skills: makeSkills(),
    approval: { sendForApproval: vi.fn().mockResolvedValue({ messageId: 123 }) },
    quietQueue: { append: vi.fn() },
    logger,
    paths,
    transcripts: [],
    telegramClient: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    chatId: 42,
    ...overrides,
  };
}

describe("runDailyLoop — steps 1-3 + wiring", () => {
  it("early exit when all three modes already produced today", async () => {
    const today = new Date().toISOString();
    for (const m of ["clip", "slideshow", "quotecard"]) {
      const dir = join(paths.drafts, "pending", `today-${m}-seed`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "draft.json"), JSON.stringify({ id: `today-${m}-seed`, mode: m, created_at: today }));
    }
    const deps = makeDeps({ clock: new Date() });
    const res = await runDailyLoop(deps);
    expect(res.produced).toBe(0);
    expect(deps.skills.research.run).not.toHaveBeenCalled();
  });

  it("empty research → exits clean, no draft attempts", async () => {
    const deps = makeDeps({ skills: makeSkills({ research: { run: vi.fn().mockResolvedValue([]) } }) });
    const res = await runDailyLoop(deps);
    expect(res.produced).toBe(0);
    expect(deps.skills.slideshowDraft.run).not.toHaveBeenCalled();
  });

  it("no matching episode for clip → slideshow takes rank 1, quotecard takes rank 2", async () => {
    const deps = makeDeps();
    const res = await runDailyLoop(deps);
    expect(deps.skills.clipExtract.run).not.toHaveBeenCalled();
    expect(deps.skills.slideshowDraft.run).toHaveBeenCalledWith(expect.objectContaining({ topic: "AI agents replacing junior devs" }));
    expect(deps.skills.quotecardDraft.run).toHaveBeenCalledWith(expect.objectContaining({ topic: "Open-source LLMs surge" }));
    expect(res.produced).toBe(2);
    expect(res.skipped.find(s => s.mode === "clip").reason).toBe("not_selected");
  });

  it("dedupe across modes keyed on source_url", async () => {
    const deps = makeDeps();
    await runDailyLoop(deps);
    const slideTopic = deps.skills.slideshowDraft.run.mock.calls[0][0].topic;
    const quoteTopic = deps.skills.quotecardDraft.run.mock.calls[0][0].topic;
    expect(slideTopic).not.toBe(quoteTopic);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run daily-loop.test.js
```
Expected: FAIL.

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/orchestrator/daily-loop.js`:

```js
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { matchTopicToEpisode } from "./topic-episode-match.js";
import { isInQuietHours } from "./time.js";

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function walkDraftsRecursive(dir, byMode, today) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    const draftFile = join(p, "draft.json");
    if (existsSync(draftFile)) {
      try {
        const d = JSON.parse(readFileSync(draftFile, "utf8"));
        const created = new Date(d.created_at);
        if (!isNaN(created) && sameLocalDay(created, today) && byMode[d.mode] !== undefined) {
          byMode[d.mode]++;
        }
      } catch { /* skip malformed */ }
    } else {
      walkDraftsRecursive(p, byMode, today);
    }
  }
}

function readDraftsByMode(draftsRoot, today) {
  const byMode = { clip: 0, slideshow: 0, quotecard: 0 };
  for (const bucket of ["pending", "approved", "rejected"]) {
    walkDraftsRecursive(join(draftsRoot, bucket), byMode, today);
  }
  return byMode;
}

async function callSkill(mode, skills, topic, episode, transcripts) {
  switch (mode) {
    case "clip": {
      const transcript = episode ? transcripts.find(t => t.episode_id === episode.episode_id) : null;
      return (await skills.clipExtract.run({ transcript, source: episode, videoPath: episode?.video_path })).draft;
    }
    case "slideshow":
      return (await skills.slideshowDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    case "quotecard":
      return (await skills.quotecardDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

function isTransient(err) {
  const m = String(err?.message ?? "");
  if (/HTTP (5\d\d|429)/.test(m)) return true;
  if (/ECONN|timeout|ETIMEDOUT|fetch failed/i.test(m)) return true;
  return false;
}

export async function runDailyLoop({
  clock, providerRouter, skills, approval, quietQueue, logger,
  paths, transcripts = [], telegramClient, chatId,
}) {
  const today = clock instanceof Date ? clock : new Date();
  const nichesDoc = yaml.load(readFileSync(join(paths.workspace, "config/niches.yaml"), "utf8"));
  const telegramDoc = yaml.load(readFileSync(join(paths.workspace, "config/telegram.yaml"), "utf8"));
  const niches = Object.keys(nichesDoc?.niches ?? {});

  const produced = readDraftsByMode(paths.drafts, today);
  const modesNeeded = ["clip", "slideshow", "quotecard"].filter(m => produced[m] === 0);
  if (modesNeeded.length === 0) {
    logger.jsonl({ event: "daily_loop_skip", reason: "all_modes_produced_today" });
    return { drafts: [], produced: 0, skipped: [], durationMs: 0 };
  }

  const topics = [];
  for (const niche of niches) {
    try {
      const items = await skills.research.run(niche);
      topics.push(...items);
    } catch (err) {
      logger.errorjsonl(err, { phase: "research", niche });
    }
  }
  topics.sort((a, b) => b.score - a.score);
  if (topics.length === 0) {
    logger.jsonl({ event: "daily_loop_skip", reason: "no_topics" });
    return { drafts: [], produced: 0, skipped: [], durationMs: 0 };
  }

  const assignments = {};
  const usedUrls = new Set();
  if (modesNeeded.includes("clip")) {
    const match = await matchTopicToEpisode(topics, transcripts, providerRouter, { now: today });
    if (match) {
      assignments.clip = { topic: match.topic, episode: match.episode };
      usedUrls.add(match.topic.source_url);
    }
  }
  for (const m of ["slideshow", "quotecard"]) {
    if (!modesNeeded.includes(m)) continue;
    const pick = topics.find(t => !usedUrls.has(t.source_url));
    if (pick) {
      assignments[m] = { topic: pick };
      usedUrls.add(pick.source_url);
    }
  }

  const results = [];
  for (const mode of ["clip", "slideshow", "quotecard"]) {
    if (!assignments[mode]) continue;
    const { topic, episode } = assignments[mode];
    try {
      const draft = await callSkill(mode, skills, topic, episode, transcripts);
      results.push({ mode, draft_id: draft.id, ok: true });
    } catch (err) {
      if (isTransient(err)) {
        try {
          await new Promise(r => setTimeout(r, 2000));
          const draft = await callSkill(mode, skills, topic, episode, transcripts);
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

  const inQuiet = isInQuietHours(today, telegramDoc.quiet_hours);
  for (const r of results.filter(r => r.ok)) {
    if (inQuiet) {
      quietQueue.append({
        draft_id: r.draft_id,
        created_at: today.toISOString(),
        mode: r.mode,
        topic: assignments[r.mode].topic.topic,
      });
    } else {
      await approval.sendForApproval(r.draft_id);
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const skipped = [
    ...results.filter(r => !r.ok).map(r => ({ mode: r.mode, reason: r.reason })),
    ...modesNeeded.filter(m => !assignments[m]).map(m => ({ mode: m, reason: "not_selected" })),
  ];
  logger.jsonl({ event: "daily_loop_complete", produced: okCount, skipped });
  if (skipped.length > 0 && telegramClient && chatId) {
    const summary = `📋 Daily loop: ${okCount}/${modesNeeded.length} produced\n` +
      skipped.map(s => `• ${s.mode} skipped: ${s.reason}`).join("\n");
    await telegramClient.sendMessage(chatId, summary);
  }

  return { drafts: results, produced: okCount, skipped, durationMs: 0 };
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run daily-loop.test.js
```
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/daily-loop.js workspace-mirror/skills/orchestrator/daily-loop.test.js
git commit -m "feat(orchestrator): daily-loop steps 1-6 with happy-path tests"
```

---

## Task 10: daily-loop — retry + hard-fail + quiet-hours cases

**Files:**
- Modify: `workspace-mirror/skills/orchestrator/daily-loop.test.js`

The implementation in Task 9 already covers retry/quiet-hours behavior; this task locks it in with additional tests.

- [ ] **Step 1: Append test cases**

```js
describe("runDailyLoop — retry + failure + quiet-hours", () => {
  it("slideshow transient fail then success → all produced", async () => {
    const slideshowRun = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValue({ draft: { id: "d-slide-2", mode: "slideshow" } });
    const deps = makeDeps({ skills: makeSkills({
      slideshowDraft: { run: slideshowRun },
    })});
    const res = await runDailyLoop(deps);
    expect(slideshowRun).toHaveBeenCalledTimes(2);
    expect(res.drafts.find(d => d.mode === "slideshow").ok).toBe(true);
  });

  it("slideshow hard fail (TypeError) → no retry, skipped", async () => {
    const slideshowRun = vi.fn().mockRejectedValue(new TypeError("bad schema"));
    const deps = makeDeps({ skills: makeSkills({
      slideshowDraft: { run: slideshowRun },
    })});
    const res = await runDailyLoop(deps);
    expect(slideshowRun).toHaveBeenCalledTimes(1);
    expect(res.drafts.find(d => d.mode === "slideshow").ok).toBe(false);
    expect(res.drafts.find(d => d.mode === "quotecard").ok).toBe(true);
  });

  it("quiet hours routes approvals to quietQueue", async () => {
    const deps = makeDeps({ clock: new Date(2026, 3, 17, 3, 30) });  // local 03:30
    await runDailyLoop(deps);
    expect(deps.quietQueue.append).toHaveBeenCalledTimes(2);
    expect(deps.approval.sendForApproval).not.toHaveBeenCalled();
  });

  it("summary DM sent when a mode is skipped", async () => {
    const deps = makeDeps();
    await runDailyLoop(deps);
    expect(deps.telegramClient.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("clip skipped"));
  });

  it("silent on fully successful day", async () => {
    const transcripts = [
      { source_id: "lex", episode_id: "ep-1", title: "AI agents replacing junior devs", transcribed_at: "2026-04-16T10:00:00Z", segments: [{ t_start: 0, t_end: 3, text: "AI agents discussion" }] },
    ];
    const deps = makeDeps({ transcripts });
    await runDailyLoop(deps);
    expect(deps.telegramClient.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run daily-loop.test.js
```
Expected: PASS — 9 passed.

If the quiet-hours test sees the clock as outside quiet hours because the test machine's TZ pushes `new Date(2026, 3, 17, 3, 30)` into daylight time differently — just use `new Date(2026, 3, 17, 2, 0)` (02:00 is unambiguously inside the 22:00-08:00 window regardless of DST).

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/daily-loop.test.js
git commit -m "test(orchestrator): daily-loop retry/hard-fail/quiet-hours/summary cases"
```

---

## Task 11: `flushQuietQueue`

**Files:**
- Create: `workspace-mirror/skills/orchestrator/flush-quiet-queue.js`
- Create: `workspace-mirror/skills/orchestrator/flush-quiet-queue.test.js`
- Modify: `workspace-mirror/skills/orchestrator/index.js`

- [ ] **Step 1: Failing tests**

Create `workspace-mirror/skills/orchestrator/flush-quiet-queue.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { flushQuietQueue } from "./flush-quiet-queue.js";

function makeDeps(entries = []) {
  const queue = {
    drain: vi.fn().mockReturnValue(entries),
    commitDrain: vi.fn(),
    putBack: vi.fn(),
  };
  const telegramClient = { sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }) };
  const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
  return { queue, telegramClient, logger, chatId: 42 };
}

describe("flushQuietQueue", () => {
  it("empty queue → no DM, no commit", async () => {
    const deps = makeDeps([]);
    await flushQuietQueue(deps);
    expect(deps.telegramClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.commitDrain).not.toHaveBeenCalled();
  });

  it("two entries → one DM with both draft ids, commit called", async () => {
    const entries = [
      { draft_id: "d1", created_at: "2026-04-17T03:00:00Z", mode: "clip", topic: "AI" },
      { draft_id: "d2", created_at: "2026-04-17T05:00:00Z", mode: "slideshow", topic: "LLMs" },
    ];
    const deps = makeDeps(entries);
    await flushQuietQueue(deps);
    const [chatId, text, opts] = deps.telegramClient.sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain("Good morning");
    expect(text).toContain("2 drafts");
    expect(text).toContain("d1");
    expect(text).toContain("d2");
    expect(opts.reply_markup.inline_keyboard).toHaveLength(2);
    expect(deps.queue.commitDrain).toHaveBeenCalledOnce();
    expect(deps.queue.putBack).not.toHaveBeenCalled();
  });

  it("DM send fails → putBack called, commit not called", async () => {
    const deps = makeDeps([{ draft_id: "d1", created_at: "t", mode: "clip", topic: "x" }]);
    deps.telegramClient.sendMessage = vi.fn().mockRejectedValue(new Error("Telegram down"));
    await flushQuietQueue(deps);
    expect(deps.queue.putBack).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ draft_id: "d1" })])
    );
    expect(deps.queue.commitDrain).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run flush-quiet-queue.test.js
```

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/orchestrator/flush-quiet-queue.js`:

```js
export async function flushQuietQueue({ queue, telegramClient, logger, chatId }) {
  const entries = queue.drain();
  if (entries.length === 0) {
    logger.jsonl({ event: "flush_quiet_queue_noop" });
    return { flushed: 0 };
  }

  const header = `🌅 Good morning — ${entries.length} draft${entries.length === 1 ? "" : "s"} from last night`;
  const lines = [header, ""];
  for (const e of entries) {
    lines.push(`[Draft ${e.draft_id}] ${e.mode}: ${e.topic}`);
  }
  const buttons = entries.map(e => [
    { text: `Review ${e.draft_id.slice(-8)} →`, callback_data: `draft:${e.draft_id}` },
  ]);

  try {
    await telegramClient.sendMessage(chatId, lines.join("\n"), {
      reply_markup: { inline_keyboard: buttons },
    });
    queue.commitDrain();
    logger.jsonl({ event: "flush_quiet_queue_ok", flushed: entries.length });
    return { flushed: entries.length };
  } catch (err) {
    logger.errorjsonl(err, { phase: "flush_quiet_queue" });
    queue.putBack(entries);
    return { flushed: 0, putBack: entries.length };
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run flush-quiet-queue.test.js
```
Expected: PASS — 3 passed.

- [ ] **Step 5: Update index.js**

Modify `workspace-mirror/skills/orchestrator/index.js`:

```js
export { runDailyLoop } from "./daily-loop.js";
export { matchTopicToEpisode } from "./topic-episode-match.js";
export { isInQuietHours } from "./time.js";
export { flushQuietQueue } from "./flush-quiet-queue.js";
export { runSourceDiscoveryPull } from "./source-discovery-pull.js";
```

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/flush-quiet-queue.js workspace-mirror/skills/orchestrator/flush-quiet-queue.test.js workspace-mirror/skills/orchestrator/index.js
git commit -m "feat(orchestrator): flushQuietQueue with putBack-on-send-fail"
```

---

## Task 12: `runSourceDiscoveryPull`

**Files:**
- Create: `workspace-mirror/skills/orchestrator/source-discovery-pull.js`
- Create: `workspace-mirror/skills/orchestrator/source-discovery-pull.test.js`

- [ ] **Step 1: Failing tests**

Create `workspace-mirror/skills/orchestrator/source-discovery-pull.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSourceDiscoveryPull } from "./source-discovery-pull.js";

let tmp, workspace;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sdp-"));
  workspace = join(tmp, "workspace");
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(join(workspace, "config/niches.yaml"),
    `niches:\n  ai: { rss: [] }\n  finance: { rss: [] }\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runSourceDiscoveryPull", () => {
  it("invokes runPull(niche) for each niche", async () => {
    const sourceDiscovery = { runPull: vi.fn().mockResolvedValue({ candidatesCount: 2 }) };
    const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
    const res = await runSourceDiscoveryPull({ sourceDiscovery, logger, paths: { workspace } });
    expect(sourceDiscovery.runPull).toHaveBeenCalledTimes(2);
    expect(sourceDiscovery.runPull).toHaveBeenCalledWith("ai");
    expect(sourceDiscovery.runPull).toHaveBeenCalledWith("finance");
    expect(res.nichesRun).toBe(2);
  });

  it("one niche failure does not block others", async () => {
    const runPull = vi.fn()
      .mockResolvedValueOnce({ candidatesCount: 1 })
      .mockRejectedValueOnce(new Error("quota exceeded"));
    const sourceDiscovery = { runPull };
    const logger = { jsonl: vi.fn(), errorjsonl: vi.fn() };
    const res = await runSourceDiscoveryPull({ sourceDiscovery, logger, paths: { workspace } });
    expect(res.nichesRun).toBe(2);
    expect(res.nichesFailed).toBe(1);
    expect(logger.errorjsonl).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run source-discovery-pull.test.js
```

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/orchestrator/source-discovery-pull.js`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export async function runSourceDiscoveryPull({ sourceDiscovery, logger, paths }) {
  const nichesDoc = yaml.load(readFileSync(join(paths.workspace, "config/niches.yaml"), "utf8"));
  const niches = Object.keys(nichesDoc?.niches ?? {});
  let nichesRun = 0;
  let nichesFailed = 0;
  for (const niche of niches) {
    try {
      await sourceDiscovery.runPull(niche);
      logger.jsonl({ event: "source_discovery_pull_ok", niche });
    } catch (err) {
      nichesFailed++;
      logger.errorjsonl(err, { phase: "source_discovery_pull", niche });
    }
    nichesRun++;
  }
  return { nichesRun, nichesFailed };
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && npx vitest run source-discovery-pull.test.js
```
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/source-discovery-pull.js workspace-mirror/skills/orchestrator/source-discovery-pull.test.js
git commit -m "feat(orchestrator): runSourceDiscoveryPull iterates niches with per-niche resilience"
```

---

## Task 13: `bin/orchestrator.js` CLI dispatcher

**Files:**
- Create: `workspace-mirror/skills/orchestrator/bin/orchestrator.js`

- [ ] **Step 1: Create the CLI**

Create `workspace-mirror/skills/orchestrator/bin/orchestrator.js`:

```js
#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "shared/jsonl-logger";
import { createQuietQueue } from "shared/quiet-queue";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : (args.includes(`--${name}`) ? true : fallback);
}

const job = arg("job");
const sandbox = !!arg("sandbox", false);
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;
const WORKSPACE = `${HOME}/.openclaw/workspace`;

const logger = createLogger(`${DRAFTS}/logs/agent.jsonl`);
const quietQueue = createQuietQueue({ path: `${DRAFTS}/state/quiet-queue.jsonl` });

if (!job) {
  console.error("orchestrator: --job=<daily-loop|flush-quiet-queue|source-discovery-pull> required");
  process.exit(2);
}

async function loadSkillsAndRouter() {
  const { createRouter } = await import(`${WORKSPACE}/skills/provider-router/router.js`);
  const ollama = (await import(`${WORKSPACE}/skills/provider-router/providers/ollama.js`)).default;
  const anthropic = (await import(`${WORKSPACE}/skills/provider-router/providers/anthropic.js`)).default;
  const { createResearch } = await import(`${WORKSPACE}/skills/research/index.js`);
  const { createSlideshowDraft } = await import(`${WORKSPACE}/skills/slideshow-draft/index.js`);
  const { createQuotecardDraft, createRenderCard } = await import(`${WORKSPACE}/skills/quotecard-draft/index.js`);
  const { createClipExtract } = await import(`${WORKSPACE}/skills/clip-extract/index.js`);
  const { createFfmpegRunner } = await import(`${WORKSPACE}/skills/clip-extract/ffmpeg.js`);
  const { createPexelsClient } = await import(`${WORKSPACE}/skills/slideshow-draft/pexels.js`);
  const { createTelegramClient } = await import(`${WORKSPACE}/skills/shared/telegram-client.js`);
  const { createDraftStore } = await import(`${WORKSPACE}/skills/shared/draft-store.js`);
  const { createSourceDiscovery } = await import(`${WORKSPACE}/skills/source-discovery/index.js`);
  const { sendForApproval } = await import(`${WORKSPACE}/skills/approval/approval.js`);

  const router = createRouter({
    configPath: `${WORKSPACE}/config/providers.yaml`,
    adapters: { ollama, anthropic },
    logPath: `${DRAFTS}/logs/router.jsonl`,
  });

  const draftStore = createDraftStore(DRAFTS);
  const telegramClient = createTelegramClient({ token: process.env.TG_BOT_TOKEN });
  const chatId = Number(process.env.TG_CHAT_ID);

  const research = createResearch({
    readFileSync,
    nichesPath: `${WORKSPACE}/config/niches.yaml`,
    browserSearch: async () => [],
    router,
  });
  const slideshowDraft = createSlideshowDraft({
    router, draftStore,
    pexels: createPexelsClient({ apiKey: process.env.PEXELS_API_KEY }),
  });
  const quotecardDraft = createQuotecardDraft({
    router, draftStore,
    renderCard: createRenderCard({
      pythonPath: `${WORKSPACE}/.venv/bin/python`,
      scriptPath: `${WORKSPACE}/skills/quotecard-draft/render.py`,
    }),
  });
  const clipExtract = createClipExtract({
    router, draftStore, ffmpeg: createFfmpegRunner(),
  });
  const sourceDiscovery = createSourceDiscovery({
    router, telegramClient, chatId,
    sourcesStorePath: `${WORKSPACE}/config/sources.yaml`,
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    logger,
  });

  return {
    router, draftStore, telegramClient, chatId,
    skills: { research, slideshowDraft, quotecardDraft, clipExtract },
    sourceDiscovery,
    approval: { sendForApproval: (id) => sendForApproval(id, { telegramClient, draftStore, chatId }) },
  };
}

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

async function main() {
  try {
    if (job === "daily-loop") {
      const { runDailyLoop } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await runDailyLoop({
        clock: new Date(),
        providerRouter: d.router,
        skills: d.skills,
        approval: d.approval,
        quietQueue,
        logger,
        paths: { workspace: WORKSPACE, drafts: DRAFTS },
        transcripts: loadTranscripts(),
        telegramClient: d.telegramClient,
        chatId: d.chatId,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (job === "flush-quiet-queue") {
      const { flushQuietQueue } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await flushQuietQueue({
        queue: quietQueue,
        telegramClient: d.telegramClient,
        logger, chatId: d.chatId,
      });
      console.log(JSON.stringify(res));
    } else if (job === "source-discovery-pull") {
      const { runSourceDiscoveryPull } = await import("../index.js");
      const d = await loadSkillsAndRouter();
      const res = await runSourceDiscoveryPull({
        sourceDiscovery: d.sourceDiscovery,
        logger,
        paths: { workspace: WORKSPACE, drafts: DRAFTS },
      });
      console.log(JSON.stringify(res));
    } else {
      console.error(`orchestrator: unknown --job=${job}`);
      process.exit(2);
    }
  } catch (err) {
    logger.errorjsonl(err, { phase: "cli", job });
    console.error(err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Import-parse check**

Primary agent runs:
```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/orchestrator && node -e "import('./bin/orchestrator.js').catch(e => { console.error(e); process.exit(1); })"
```
Expected: prints the usage error (no `--job` passed) and exits 2 — that confirms the file parses and reaches the usage branch.

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/orchestrator/bin/orchestrator.js
git commit -m "feat(orchestrator): CLI dispatcher for 3 phases"
```

---

# Phase 3 — Report skill

## Task 14: Scaffold `report` + `digest-data.js`

**Files:**
- Create: `workspace-mirror/skills/report/package.json`
- Create: `workspace-mirror/skills/report/README.md`
- Create: `workspace-mirror/skills/report/digest-data.js`
- Create: `workspace-mirror/skills/report/digest-data.test.js`

- [ ] **Step 1: Package + README**

Create `workspace-mirror/skills/report/package.json`:

```json
{
  "name": "report",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run", "test:watch": "vitest" },
  "dependencies": { "shared": "file:../shared", "js-yaml": "^4.1.0" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

Create `workspace-mirror/skills/report/README.md`:

```markdown
# report

Nightly digest: last-24h drafts + spend + rejection reasons, sent as one Telegram DM.

## CLI

    bin/report.js --job=nightly [--sandbox]

## Smoke

    node bin/report.js --job=nightly

Expected: one Telegram DM. If no activity: "Quiet day — no drafts produced."
```

- [ ] **Step 2: Failing tests**

Create `workspace-mirror/skills/report/digest-data.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatherDigestData } from "./digest-data.js";

let tmp, drafts;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dd-"));
  drafts = join(tmp, "drafts");
  mkdirSync(join(drafts, "pending"), { recursive: true });
  mkdirSync(join(drafts, "approved"), { recursive: true });
  mkdirSync(join(drafts, "rejected"), { recursive: true });
  mkdirSync(join(drafts, "logs"), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seedDraft(bucket, id, draft) {
  const dir = bucket === "pending"
    ? join(drafts, "pending", id)
    : join(drafts, bucket, "2026-04-17", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
}

describe("gatherDigestData", () => {
  const now = new Date("2026-04-17T22:30:00Z");

  it("reports zeros on empty workspace", async () => {
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(0);
    expect(data.byMode).toEqual({ clip: 0, slideshow: 0, quotecard: 0 });
  });

  it("counts drafts by bucket + mode in last 24h", async () => {
    seedDraft("pending", "p1", { id: "p1", mode: "clip", created_at: "2026-04-17T09:00:00Z", provider_used: "ollama:qwen2.5:14b" });
    seedDraft("approved", "a1", { id: "a1", mode: "slideshow", created_at: "2026-04-17T10:00:00Z", provider_used: "ollama:qwen2.5:14b" });
    seedDraft("rejected", "r1", { id: "r1", mode: "quotecard", created_at: "2026-04-17T11:00:00Z", provider_used: "anthropic:claude-sonnet-4-6" });
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(3);
    expect(data.approved).toBe(1);
    expect(data.rejected).toBe(1);
    expect(data.pending).toBe(1);
    expect(data.byMode).toEqual({ clip: 1, slideshow: 1, quotecard: 1 });
  });

  it("ignores drafts outside 24h window", async () => {
    seedDraft("pending", "old", { id: "old", mode: "clip", created_at: "2026-04-10T09:00:00Z" });
    const data = await gatherDigestData({ drafts, now });
    expect(data.produced).toBe(0);
  });

  it("reads top rejection reason from rejections.jsonl", async () => {
    writeFileSync(join(drafts, "logs/rejections.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T10:00:00Z", draft_id: "r1", reason: "too clickbait" }),
      JSON.stringify({ ts: "2026-04-17T11:00:00Z", draft_id: "r2", reason: "too clickbait" }),
      JSON.stringify({ ts: "2026-04-17T12:00:00Z", draft_id: "r3", reason: "off brand" }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.topRejectionReason).toBe("too clickbait");
  });

  it("computes spend + provider mix from router.jsonl", async () => {
    writeFileSync(join(drafts, "logs/router.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T10:00:00Z", provider: "ollama:qwen2.5:14b", cost_usd: 0 }),
      JSON.stringify({ ts: "2026-04-17T11:00:00Z", provider: "ollama:qwen2.5:14b", cost_usd: 0 }),
      JSON.stringify({ ts: "2026-04-17T12:00:00Z", provider: "anthropic:claude-sonnet-4-6", cost_usd: 0.05 }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.spendUsd).toBeCloseTo(0.05, 4);
    expect(data.providerMix.find(p => p.provider === "ollama:qwen2.5:14b").pct).toBeCloseTo(66.6, 0);
  });

  it("surfaces spend_cap_hit event", async () => {
    writeFileSync(join(drafts, "logs/router.jsonl"), [
      JSON.stringify({ ts: "2026-04-17T14:32:00Z", event: "spend_cap_hit", spent_usd: 1.02 }),
    ].join("\n"));
    const data = await gatherDigestData({ drafts, now });
    expect(data.spendCapHit).toEqual({ at: "14:32", spentUsd: 1.02 });
  });
});
```

- [ ] **Step 3: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/report && npx vitest run digest-data.test.js
```

- [ ] **Step 4: Implementation**

Create `workspace-mirror/skills/report/digest-data.js`:

```js
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MS_24H = 24 * 60 * 60 * 1000;

function readJsonlIfExists(p) {
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function walkDrafts(dir, onDraft) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    const draftPath = join(p, "draft.json");
    if (existsSync(draftPath)) {
      try { onDraft(JSON.parse(readFileSync(draftPath, "utf8"))); } catch {}
    } else {
      walkDrafts(p, onDraft);
    }
  }
}

function inLast24h(ts, now) {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  return now.getTime() - t <= MS_24H;
}

export async function gatherDigestData({ drafts, now = new Date() }) {
  const byBucket = { pending: 0, approved: 0, rejected: 0 };
  const byMode = { clip: 0, slideshow: 0, quotecard: 0 };

  for (const bucket of ["pending", "approved", "rejected"]) {
    walkDrafts(join(drafts, bucket), (d) => {
      if (!inLast24h(d.created_at, now)) return;
      byBucket[bucket]++;
      if (byMode[d.mode] !== undefined) byMode[d.mode]++;
    });
  }

  const rejectionsLines = readJsonlIfExists(join(drafts, "logs/rejections.jsonl"))
    .filter(l => inLast24h(l.ts, now));
  const rejectionCounts = new Map();
  for (const r of rejectionsLines) {
    rejectionCounts.set(r.reason, (rejectionCounts.get(r.reason) || 0) + 1);
  }
  const topRejection = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const routerLines = readJsonlIfExists(join(drafts, "logs/router.jsonl"))
    .filter(l => inLast24h(l.ts, now));
  const calls = routerLines.filter(l => !l.event);
  let spendUsd = 0;
  const providerCounts = new Map();
  for (const l of calls) {
    spendUsd += Number(l.cost_usd || 0);
    if (l.provider) providerCounts.set(l.provider, (providerCounts.get(l.provider) || 0) + 1);
  }
  const totalCalls = calls.length || 1;
  const providerMix = [...providerCounts.entries()]
    .map(([provider, n]) => ({ provider, pct: (n / totalCalls) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const capHit = routerLines.find(l => l.event === "spend_cap_hit");
  const spendCapHit = capHit ? {
    at: new Date(capHit.ts).toISOString().slice(11, 16),
    spentUsd: Number(capHit.spent_usd || 0),
  } : null;

  return {
    produced: byBucket.pending + byBucket.approved + byBucket.rejected,
    pending: byBucket.pending,
    approved: byBucket.approved,
    rejected: byBucket.rejected,
    modified: 0,
    byMode,
    topRejectionReason: topRejection ? topRejection[0] : null,
    spendUsd,
    providerMix,
    spendCapHit,
    date: now.toISOString().slice(0, 10),
  };
}
```

- [ ] **Step 5: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/report && npx vitest run digest-data.test.js
```
Expected: PASS — 6 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/report/package.json workspace-mirror/skills/report/README.md workspace-mirror/skills/report/digest-data.js workspace-mirror/skills/report/digest-data.test.js
git commit -m "feat(report): digest-data scanners for drafts + logs"
```

---

## Task 15: `digest-render.js` + `index.js` + `bin/report.js`

**Files:**
- Create: `workspace-mirror/skills/report/digest-render.js`
- Create: `workspace-mirror/skills/report/digest-render.test.js`
- Create: `workspace-mirror/skills/report/index.js`
- Create: `workspace-mirror/skills/report/bin/report.js`

- [ ] **Step 1: Failing tests**

Create `workspace-mirror/skills/report/digest-render.test.js`:

```js
import { describe, it, expect } from "vitest";
import { renderDigest } from "./digest-render.js";

describe("renderDigest", () => {
  it("renders 'Quiet day' when nothing was produced", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 0, pending: 0, approved: 0, rejected: 0, modified: 0,
      byMode: { clip: 0, slideshow: 0, quotecard: 0 },
      topRejectionReason: null, spendUsd: 0, providerMix: [], spendCapHit: null,
    });
    expect(out).toContain("Quiet day");
  });

  it("renders full report with all sections", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 3, pending: 0, approved: 1, rejected: 1, modified: 1,
      byMode: { clip: 1, slideshow: 1, quotecard: 1 },
      topRejectionReason: "too clickbait",
      spendUsd: 0.08,
      providerMix: [
        { provider: "ollama:qwen2.5:14b", pct: 94 },
        { provider: "anthropic:claude-sonnet-4-6", pct: 6 },
      ],
      spendCapHit: null,
    });
    expect(out).toContain("2026-04-17");
    expect(out).toContain("Produced: 3");
    expect(out).toContain("Approved: 1");
    expect(out).toContain("too clickbait");
    expect(out).toContain("$0.08");
    expect(out).toContain("ollama:qwen2.5:14b");
  });

  it("includes spend-cap-hit line when present", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 1, pending: 0, approved: 0, rejected: 0, modified: 0,
      byMode: { clip: 0, slideshow: 1, quotecard: 0 },
      topRejectionReason: null, spendUsd: 1.02,
      providerMix: [], spendCapHit: { at: "14:32", spentUsd: 1.02 },
    });
    expect(out).toContain("Spend cap hit at 14:32");
  });

  it("omits empty sections", () => {
    const out = renderDigest({
      date: "2026-04-17", produced: 1, pending: 0, approved: 1, rejected: 0, modified: 0,
      byMode: { clip: 1, slideshow: 0, quotecard: 0 },
      topRejectionReason: null, spendUsd: 0, providerMix: [], spendCapHit: null,
    });
    expect(out).not.toContain("Top rejection");
    expect(out).not.toContain("Provider mix");
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/report && npx vitest run digest-render.test.js
```

- [ ] **Step 3: Implementation**

Create `workspace-mirror/skills/report/digest-render.js`:

```js
export function renderDigest(d) {
  const lines = [];
  lines.push(`🌙 Daily report · ${d.date}`);
  if (d.produced === 0) {
    lines.push("Quiet day — no drafts produced.");
    return lines.join("\n");
  }
  const modeBreakdown = Object.entries(d.byMode)
    .filter(([, n]) => n > 0)
    .map(([mode, n]) => `${n} ${mode}`).join(", ");
  lines.push(`Produced: ${d.produced} drafts${modeBreakdown ? ` (${modeBreakdown})` : ""}`);
  lines.push(`Approved: ${d.approved} · Modified: ${d.modified} · Rejected: ${d.rejected} · Pending: ${d.pending}`);
  if (d.topRejectionReason) lines.push(`Top rejection reason: "${d.topRejectionReason}"`);
  if (d.providerMix?.length) {
    const mix = d.providerMix.map(p => `${p.provider} (${Math.round(p.pct)}%)`).join(", ");
    lines.push(`Provider mix: ${mix}`);
  }
  lines.push(`Spend: $${d.spendUsd.toFixed(2)}`);
  if (d.spendCapHit) lines.push(`Spend cap hit at ${d.spendCapHit.at} — downgraded to local`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/report && npx vitest run digest-render.test.js
```
Expected: PASS — 4 passed.

- [ ] **Step 5: Create index.js**

Create `workspace-mirror/skills/report/index.js`:

```js
import { gatherDigestData } from "./digest-data.js";
import { renderDigest } from "./digest-render.js";

export { gatherDigestData, renderDigest };

export async function sendNightlyReport({ drafts, telegramClient, chatId, logger, now }) {
  const data = await gatherDigestData({ drafts, now });
  const text = renderDigest(data);
  try {
    await telegramClient.sendMessage(chatId, text);
    logger.jsonl({ event: "report_sent", produced: data.produced, spend_usd: data.spendUsd });
    return { ok: true, text };
  } catch (err) {
    logger.errorjsonl(err, { phase: "nightly_report" });
    throw err;
  }
}
```

- [ ] **Step 6: Create bin/report.js**

Create `workspace-mirror/skills/report/bin/report.js`:

```js
#!/usr/bin/env node
import { createLogger } from "shared/jsonl-logger";
import { sendNightlyReport } from "../index.js";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
const sandbox = args.includes("--sandbox");
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;
const WORKSPACE = `${HOME}/.openclaw/workspace`;
const logger = createLogger(`${DRAFTS}/logs/agent.jsonl`);

async function main() {
  const { createTelegramClient } = await import(`${WORKSPACE}/skills/shared/telegram-client.js`);
  const telegramClient = createTelegramClient({ token: process.env.TG_BOT_TOKEN });
  const chatId = Number(process.env.TG_CHAT_ID);
  try {
    const res = await sendNightlyReport({
      drafts: DRAFTS, telegramClient, chatId, logger, now: new Date(),
    });
    console.log(JSON.stringify({ ok: res.ok }));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/report/digest-render.js workspace-mirror/skills/report/digest-render.test.js workspace-mirror/skills/report/index.js workspace-mirror/skills/report/bin/report.js
git commit -m "feat(report): digest renderer + sendNightlyReport + CLI"
```

---

# Phase 4 — Archive prune

## Task 16: `archive` pruneCache

**Files:**
- Modify: `workspace-mirror/skills/archive/archive.js`
- Modify: `workspace-mirror/skills/archive/archive.test.js` (or add new test file if layout differs — mirror the existing archive test convention)
- Create: `workspace-mirror/skills/archive/bin/archive.js`

- [ ] **Step 1: Append failing tests**

Append to the existing `workspace-mirror/skills/archive/archive.test.js` (or in the archive skill's existing test layout — inspect the skill before writing):

```js
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneCache } from "../archive.js";  // adjust path if tests are co-located

describe("pruneCache", () => {
  let drafts;
  beforeEach(() => {
    drafts = mkdtempSync(join(tmpdir(), "pc-"));
    const dirs = [
      "whitelist/audio-cache/lex",
      "whitelist/video-cache/lex",
      "whitelist/transcript-cache/lex",
      "pexels-cache",
      "pending/live-draft",
      "approved/2026-04-17/ok",
    ];
    for (const p of dirs) mkdirSync(join(drafts, p), { recursive: true });
    writeFileSync(join(drafts, "whitelist/audio-cache/lex/old.m4a"), "x");
    writeFileSync(join(drafts, "whitelist/video-cache/lex/old.mp4"), "x");
    writeFileSync(join(drafts, "whitelist/transcript-cache/lex/old.json"), "{}");
    writeFileSync(join(drafts, "pexels-cache/old.json"), "{}");
    writeFileSync(join(drafts, "pending/live-draft/draft.json"), "{}");
    writeFileSync(join(drafts, "approved/2026-04-17/ok/draft.json"), "{}");
    const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
    for (const rel of [
      "whitelist/audio-cache/lex/old.m4a",
      "whitelist/video-cache/lex/old.mp4",
      "whitelist/transcript-cache/lex/old.json",
      "pexels-cache/old.json",
    ]) {
      utimesSync(join(drafts, rel), tenDaysAgo, tenDaysAgo);
    }
  });
  afterEach(() => rmSync(drafts, { recursive: true, force: true }));

  it("prunes files older than retain_days in allow-listed cache dirs", () => {
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "whitelist/audio-cache/lex/old.m4a"))).toBe(false);
    expect(existsSync(join(drafts, "whitelist/video-cache/lex/old.mp4"))).toBe(false);
    expect(existsSync(join(drafts, "whitelist/transcript-cache/lex/old.json"))).toBe(false);
    expect(existsSync(join(drafts, "pexels-cache/old.json"))).toBe(false);
  });

  it("never touches pending/ or approved/ (not in allow-list)", () => {
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "pending/live-draft/draft.json"))).toBe(true);
    expect(existsSync(join(drafts, "approved/2026-04-17/ok/draft.json"))).toBe(true);
  });

  it("keeps files newer than retain_days", () => {
    writeFileSync(join(drafts, "whitelist/audio-cache/lex/fresh.m4a"), "x");
    pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(existsSync(join(drafts, "whitelist/audio-cache/lex/fresh.m4a"))).toBe(true);
  });

  it("returns pruned count", () => {
    const res = pruneCache({ drafts, retainDays: 7, now: new Date() });
    expect(res.pruned).toBe(4);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/archive && npx vitest run
```

- [ ] **Step 3: Implementation**

Append to `workspace-mirror/skills/archive/archive.js`:

```js
import { readdirSync, statSync, unlinkSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const PRUNABLE_SUBDIRS = [
  "whitelist/audio-cache",
  "whitelist/video-cache",
  "whitelist/transcript-cache",
  "pexels-cache",
];

export function pruneCache({ drafts, retainDays, now = new Date() }) {
  const cutoff = now.getTime() - retainDays * 86400 * 1000;
  let pruned = 0;

  function walkAndPrune(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndPrune(p);
        try {
          const remaining = readdirSync(p);
          if (remaining.length === 0) rmdirSync(p);
        } catch {}
      } else {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          pruned++;
        }
      }
    }
  }

  for (const sub of PRUNABLE_SUBDIRS) {
    walkAndPrune(join(drafts, sub));
  }

  return { pruned };
}
```

- [ ] **Step 4: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/skills/archive && npx vitest run
```
Expected: all original archive tests still pass, plus 4 new pruneCache tests.

- [ ] **Step 5: Add bin/archive.js CLI**

Create `workspace-mirror/skills/archive/bin/archive.js`:

```js
#!/usr/bin/env node
import { pruneCache } from "../archive.js";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : (args.includes(`--${name}`) ? true : fallback);
}
const job = arg("job");
const retainDays = Number(arg("retain_days", 7));
const sandbox = !!arg("sandbox", false);
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;

if (job === "prune-cache") {
  const res = pruneCache({ drafts: DRAFTS, retainDays, now: new Date() });
  console.log(JSON.stringify(res));
} else {
  console.error(`archive: unknown --job=${job}. Supported: prune-cache`);
  process.exit(2);
}
```

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/skills/archive/
git commit -m "feat(archive): pruneCache with explicit subdir allow-list + CLI"
```

---

# Phase 5 — Cron provisioning

## Task 17: `scripts/install-cron.mjs`

**Files:**
- Create: `workspace-mirror/scripts/package.json`
- Create: `workspace-mirror/scripts/install-cron.mjs`
- Create: `workspace-mirror/scripts/install-cron.test.mjs`

- [ ] **Step 1: Package**

Create `workspace-mirror/scripts/package.json`:

```json
{
  "name": "openclaw-scripts",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "dependencies": { "js-yaml": "^4.1.0" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

- [ ] **Step 2: Failing tests**

Create `workspace-mirror/scripts/install-cron.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { computeDiff, buildSkillInvocation, ALLOWED_SKILLS } from "./install-cron.mjs";

describe("buildSkillInvocation", () => {
  it("returns absolute argv for orchestrator daily-loop", () => {
    const argv = buildSkillInvocation(
      "orchestrator",
      { job: "daily-loop" },
      { nodePath: "/opt/homebrew/bin/node", workspace: "/Users/u/.openclaw/workspace" }
    );
    expect(argv[0]).toBe("/opt/homebrew/bin/node");
    expect(argv[1]).toBe("/Users/u/.openclaw/workspace/skills/orchestrator/bin/orchestrator.js");
    expect(argv).toContain("--job=daily-loop");
  });

  it("never contains literal ~", () => {
    const argv = buildSkillInvocation(
      "orchestrator",
      { job: "flush-quiet-queue" },
      { nodePath: "/opt/homebrew/bin/node", workspace: "/home/user/.openclaw/workspace" }
    );
    for (const a of argv) expect(a).not.toMatch(/~/);
  });

  it("rejects disallowed skills", () => {
    expect(() =>
      buildSkillInvocation("malicious-thing", { job: "x" }, { nodePath: "/n", workspace: "/w" })
    ).toThrow(/not in allow-list/);
  });

  it("ALLOWED_SKILLS list matches plan", () => {
    expect(ALLOWED_SKILLS).toEqual(["orchestrator", "report", "whitelist-scan", "archive"]);
  });
});

describe("computeDiff", () => {
  const ctx = { nodePath: "/n", workspace: "/w" };
  const desired = [
    { name: "daily-loop", schedule: "0 9 * * *", skill: "orchestrator", args: { job: "daily-loop" }, description: "daily" },
    { name: "nightly-report", schedule: "0 23 * * *", skill: "report", args: { job: "nightly" }, description: "report" },
  ];

  it("add missing + remove stale", () => {
    const actual = [{ name: "openclaw-managed-old-job", schedule: "0 1 * * *", message: "[]" }];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toAdd.map(j => j.name)).toEqual(["daily-loop", "nightly-report"]);
    expect(diff.toRemove.map(j => j.name)).toEqual(["openclaw-managed-old-job"]);
    expect(diff.toEdit).toEqual([]);
  });

  it("ignore unmanaged jobs", () => {
    const actual = [{ name: "user-personal-job", schedule: "0 3 * * *", message: "[]" }];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toRemove).toEqual([]);
  });

  it("edit on schedule change", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 8 * * *", message: JSON.stringify(buildSkillInvocation("orchestrator", { job: "daily-loop" }, ctx)) },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toEdit.map(j => j.name)).toEqual(["daily-loop"]);
  });

  it("edit on message change", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 9 * * *", message: "[]" },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toEdit.map(j => j.name)).toEqual(["daily-loop"]);
  });

  it("no-op when everything matches", () => {
    const actual = [
      { name: "openclaw-managed-daily-loop", schedule: "0 9 * * *", message: JSON.stringify(buildSkillInvocation("orchestrator", { job: "daily-loop" }, ctx)) },
      { name: "openclaw-managed-nightly-report", schedule: "0 23 * * *", message: JSON.stringify(buildSkillInvocation("report", { job: "nightly" }, ctx)) },
    ];
    const diff = computeDiff(desired, actual, ctx);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toEdit).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });
});
```

- [ ] **Step 3: Verify fail**

```bash
cd ~/Desktop/openclaw/workspace-mirror/scripts && npm install && npx vitest run install-cron.test.mjs
```

- [ ] **Step 4: Implementation**

Create `workspace-mirror/scripts/install-cron.mjs`:

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import yaml from "js-yaml";

export const ALLOWED_SKILLS = ["orchestrator", "report", "whitelist-scan", "archive"];
const NAME_PREFIX = "openclaw-managed-";

const SKILL_ENTRY_BIN = {
  orchestrator: "skills/orchestrator/bin/orchestrator.js",
  report: "skills/report/bin/report.js",
  "whitelist-scan": "skills/whitelist-scan/bin/scan.js",
  archive: "skills/archive/bin/archive.js",
};

function argsToCliFlags(args = {}) {
  return Object.entries(args).map(([k, v]) => `--${k}=${v}`);
}

export function buildSkillInvocation(skill, args, { nodePath, workspace }) {
  if (!ALLOWED_SKILLS.includes(skill)) {
    throw new Error(`install-cron: skill "${skill}" not in allow-list`);
  }
  const rel = SKILL_ENTRY_BIN[skill];
  return [nodePath, `${workspace}/${rel}`, ...argsToCliFlags(args)];
}

function parseYaml(path) {
  const doc = yaml.load(readFileSync(path, "utf8"));
  const jobs = doc?.jobs ?? [];
  for (const j of jobs) {
    if (!j.name || !j.schedule || !j.skill) {
      throw new Error(`install-cron: job missing name/schedule/skill: ${JSON.stringify(j)}`);
    }
    if (!ALLOWED_SKILLS.includes(j.skill)) {
      throw new Error(`install-cron: skill "${j.skill}" not in allow-list`);
    }
  }
  return jobs;
}

export function computeDiff(desired, actualAll, ctx) {
  const actual = actualAll.filter(a => a.name.startsWith(NAME_PREFIX));
  const byName = new Map(actual.map(a => [a.name, a]));
  const toAdd = [];
  const toEdit = [];
  const toRemove = [];
  const desiredNames = new Set();

  for (const d of desired) {
    const managedName = NAME_PREFIX + d.name;
    desiredNames.add(managedName);
    const argv = buildSkillInvocation(d.skill, d.args, ctx);
    const msg = JSON.stringify(argv);
    const existing = byName.get(managedName);
    if (!existing) {
      toAdd.push({ ...d, managedName, argv, message: msg });
    } else if (existing.schedule !== d.schedule || existing.message !== msg) {
      toEdit.push({ ...d, managedName, argv, message: msg });
    }
  }

  for (const a of actual) {
    if (!desiredNames.has(a.name)) toRemove.push(a);
  }

  return { toAdd, toEdit, toRemove };
}

export async function installCron({
  yamlPath, openClawBin, nodePath, workspace, runSub, dryRun,
}) {
  const desired = parseYaml(yamlPath);
  const ctx = { nodePath, workspace };

  const listResult = await runSub(openClawBin, ["cron", "list", "--json"]);
  let actual;
  try { actual = JSON.parse(listResult.stdout || "[]"); }
  catch (e) { throw new Error(`install-cron: 'openclaw cron list --json' did not return JSON: ${e.message}`); }
  if (!Array.isArray(actual)) actual = actual.jobs ?? [];
  for (const a of actual) {
    if (typeof a.name !== "string") {
      throw new Error(`install-cron: 'actual' job missing 'name' field: ${JSON.stringify(a)}`);
    }
  }

  const diff = computeDiff(desired, actual, ctx);
  const plan = [];

  for (const j of diff.toAdd) {
    plan.push(["cron", "add", "--name", j.managedName, "--cron", j.schedule, "--message", j.message, "--description", j.description ?? ""]);
  }
  for (const j of diff.toEdit) {
    plan.push(["cron", "edit", "--name", j.managedName, "--cron", j.schedule, "--message", j.message]);
  }
  for (const j of diff.toRemove) {
    plan.push(["cron", "rm", "--name", j.name]);
  }

  if (dryRun) {
    for (const a of plan) console.log(openClawBin, ...a);
    return { plan };
  }

  for (const a of plan) await runSub(openClawBin, a);
  return { plan, applied: plan.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const HOME = homedir();

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const runSub = (cmd, argv) => execFileAsync(cmd, argv);

  try {
    const res = await installCron({
      yamlPath: `${HOME}/.openclaw/workspace/config/cron.yaml`,
      openClawBin: "/opt/homebrew/bin/openclaw",
      nodePath: process.execPath,
      workspace: `${HOME}/.openclaw/workspace`,
      runSub,
      dryRun,
    });
    console.log(`install-cron: ${dryRun ? "dry-run" : "applied"} ${res.plan.length} operation(s)`);
  } catch (err) {
    console.error("install-cron failed:", err.message);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Verify pass**

```bash
cd ~/Desktop/openclaw/workspace-mirror/scripts && npx vitest run install-cron.test.mjs
```
Expected: PASS — 10 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/scripts/
git commit -m "feat(scripts): install-cron.mjs idempotent provisioner"
```

---

## Task 18: Fill in `config/cron.yaml`

**Files:**
- Modify: `workspace-mirror/config/cron.yaml`

- [ ] **Step 1: Replace cron.yaml content**

Replace `workspace-mirror/config/cron.yaml` contents with:

```yaml
jobs:
  - name: daily-loop
    schedule: "0 9 * * *"
    skill: orchestrator
    args: { job: daily-loop }
    description: "Daily content-generation loop: research -> 3 drafts -> approval"

  - name: morning-flush
    schedule: "0 8 * * *"
    skill: orchestrator
    args: { job: flush-quiet-queue }
    description: "Drain overnight quiet-queue; send morning digest"

  - name: scan-whitelist
    schedule: "0 13 * * *"
    skill: whitelist-scan
    args: { job: all }
    description: "Poll sources.yaml for new episodes; download + transcribe"

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

- [ ] **Step 2: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/config/cron.yaml
git commit -m "feat(config): populate cron.yaml with 6 jobs"
```

---

# Phase 6 — Integration

## Task 19: Add `--orchestrator` flag to `bin/smoke-run.js`

**Files:**
- Modify: `workspace-mirror/bin/smoke-run.js`

- [ ] **Step 1: Read the current file and locate insertion points**

The existing file imports skill factories and then invokes them in a hardcoded pipe. The `--orchestrator` branch goes **after** all factories are instantiated (so `research`, `slideshowDraft`, etc. are bound) and **before** the hardcoded pipe runs. If the factories are interspersed with pipeline code, refactor minimally to group them at the top.

- [ ] **Step 2: Add flag parsing near the other flag lines**

After the line:
```js
const SANDBOX = args.includes("--sandbox");
```
add:
```js
const ORCHESTRATOR = args.includes("--orchestrator");
```

- [ ] **Step 3: Add the orchestrator branch**

After all skill factories (`research`, `slideshowDraft`, `quotecardDraft`, `clipExtract`) and the router are constructed, but before the `// 1. research` line, insert:

```js
if (ORCHESTRATOR) {
  const { runDailyLoop } = await import(`${WS}/skills/orchestrator/index.js`);
  const { createQuietQueue } = await import(`${WS}/skills/shared/quiet-queue.js`);
  const { createLogger } = await import(`${WS}/skills/shared/jsonl-logger.js`);
  const { createDraftStore } = await import(`${WS}/skills/shared/draft-store.js`);
  const { readFileSync: rf, readdirSync: rd, existsSync: ex } = await import("node:fs");
  const { join: jn } = await import("node:path");

  const quietQueue = createQuietQueue({ path: `${draftsRoot}/state/quiet-queue.jsonl` });
  const logger = createLogger(`${draftsRoot}/logs/agent.jsonl`);
  const draftStore = createDraftStore(draftsRoot);

  function loadTranscripts() {
    const root = `${draftsRoot}/whitelist/transcript-cache`;
    if (!ex(root)) return [];
    const out = [];
    for (const s of rd(root, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      for (const f of rd(jn(root, s.name))) {
        if (!f.endsWith(".json")) continue;
        try { out.push(JSON.parse(rf(jn(root, s.name, f), "utf8"))); } catch {}
      }
    }
    return out;
  }

  const tg = SANDBOX
    ? { sendMessage: async () => ({ message_id: 0 }) }
    : telegramClient;
  const approvalWrap = {
    sendForApproval: async (id) => {
      if (SANDBOX) { console.log(`[smoke] sandbox: would send approval for ${id}`); return {}; }
      return sendForApproval(id, { telegramClient, draftStore, chatId });
    },
  };

  const res = await runDailyLoop({
    clock: new Date(),
    providerRouter: router,
    skills: { research, slideshowDraft, quotecardDraft, clipExtract },
    approval: approvalWrap,
    quietQueue,
    logger,
    paths: { workspace: LIVE_WS, drafts: draftsRoot },
    transcripts: loadTranscripts(),
    telegramClient: tg,
    chatId,
  });
  console.log(`[smoke] orchestrator result:`, JSON.stringify(res, null, 2));
  process.exit(0);
}
```

- [ ] **Step 4: Smoke test (sandbox)**

Primary agent runs:
```bash
cd ~/Desktop/openclaw/workspace-mirror/bin && OPENCLAW_LIVE=1 node smoke-run.js --orchestrator --sandbox
```

Expected output includes `[smoke] orchestrator result:` and a JSON block. With no transcripts cached, `clip` appears in `skipped`. If a downstream skill throws because an env var is missing (PEXELS_API_KEY etc.), that's expected for integration testing; record the outcome in your notes.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/openclaw
git add workspace-mirror/bin/smoke-run.js
git commit -m "feat(smoke): --orchestrator flag routes through runDailyLoop end-to-end"
```

---

# Phase 7 — Deploy + verify

## Task 20: Rsync workspace-mirror → ~/.openclaw/workspace

**Files:** none (shell only — primary agent)

- [ ] **Step 1: Rsync changed paths**

Primary agent runs (trailing slashes required):

```bash
rsync -av --delete \
  --exclude node_modules --exclude package-lock.json \
  ~/Desktop/openclaw/workspace-mirror/skills/shared/ \
  ~/.openclaw/workspace/skills/shared/

rsync -av --delete \
  --exclude node_modules --exclude package-lock.json \
  ~/Desktop/openclaw/workspace-mirror/skills/orchestrator/ \
  ~/.openclaw/workspace/skills/orchestrator/

rsync -av --delete \
  --exclude node_modules --exclude package-lock.json \
  ~/Desktop/openclaw/workspace-mirror/skills/report/ \
  ~/.openclaw/workspace/skills/report/

rsync -av \
  --exclude node_modules --exclude package-lock.json \
  ~/Desktop/openclaw/workspace-mirror/skills/archive/ \
  ~/.openclaw/workspace/skills/archive/

mkdir -p ~/.openclaw/workspace/scripts
rsync -av --delete \
  --exclude node_modules --exclude package-lock.json \
  ~/Desktop/openclaw/workspace-mirror/scripts/ \
  ~/.openclaw/workspace/scripts/

cp ~/Desktop/openclaw/workspace-mirror/config/cron.yaml ~/.openclaw/workspace/config/cron.yaml

rsync -av \
  --exclude node_modules \
  ~/Desktop/openclaw/workspace-mirror/bin/ \
  ~/.openclaw/workspace/bin/
```

- [ ] **Step 2: Verify structure**

```bash
ls ~/.openclaw/workspace/skills/orchestrator/
ls ~/.openclaw/workspace/skills/report/
ls ~/.openclaw/workspace/scripts/
head -5 ~/.openclaw/workspace/config/cron.yaml
```

---

## Task 21: Install deps + run full test suite on live workspace

**Files:** none

- [ ] **Step 1: npm install for new packages**

```bash
cd ~/.openclaw/workspace/skills/shared && npm install
cd ~/.openclaw/workspace/skills/orchestrator && npm install
cd ~/.openclaw/workspace/skills/report && npm install
cd ~/.openclaw/workspace/scripts && npm install
```

Expected: each ends with `added N packages in ...s`, no `npm ERR`.

- [ ] **Step 2: Run all test suites**

```bash
for d in shared orchestrator report archive; do
  echo "--- $d ---"
  (cd ~/.openclaw/workspace/skills/$d && npm test)
done
(cd ~/.openclaw/workspace/scripts && npm test)
```

Expected: all pass. If any fails on shared-module resolution, confirm `shared/package.json` exports include both `quiet-queue` and `jsonl-logger`.

---

## Task 22: Dry-run install-cron

**Files:** none

- [ ] **Step 1: Dry-run**

```bash
cd ~/.openclaw/workspace && node scripts/install-cron.mjs --dry-run
```

Expected: 6 `/opt/homebrew/bin/openclaw cron add ...` lines — one per cron.yaml job — and a final summary `install-cron: dry-run 6 operation(s)`.

If the script errors with "pairing required" from OpenClaw's gateway, pair Telegram first (see Plan A docs) and retry. If it fails because `openclaw cron list --json` returned non-JSON, capture the raw output and update the script's shape-validation or parse logic to match the real CLI version.

---

## Task 23: Apply install-cron (real)

**Files:** none

**Prerequisite:** OpenClaw gateway reachable (not "pairing required").

- [ ] **Step 1: Apply**

```bash
cd ~/.openclaw/workspace && node scripts/install-cron.mjs
```

Expected: `install-cron: applied 6 operation(s)`.

- [ ] **Step 2: Verify**

```bash
/opt/homebrew/bin/openclaw cron list --json | head -80
```

Expected: 6 jobs with names `openclaw-managed-<each>`. If any are missing, re-run install-cron and check for errors.

---

## Task 24: Trigger daily-loop once

**Files:** none

- [ ] **Step 1: Force-run the daily-loop cron**

```bash
/opt/homebrew/bin/openclaw cron run openclaw-managed-daily-loop
```

- [ ] **Step 2: Inspect results**

```bash
tail -20 ~/openclaw-drafts/logs/agent.jsonl
ls ~/openclaw-drafts/pending/
```

Expected: one `{"event":"daily_loop_complete","produced":N,...}` line; 0-3 new draft directories under `pending/` depending on transcript availability.

- [ ] **Step 3: If drafts produced outside quiet hours, check Telegram**

Expect one inline-keyboard message per produced draft (clip skipped unless you've cached a Lex transcript).

---

## Task 25: End of session — push + PR + close beads

**Files:** none (git + bd operations)

- [ ] **Step 1: Full test sweep in mirror**

```bash
for d in shared orchestrator report archive; do
  (cd ~/Desktop/openclaw/workspace-mirror/skills/$d && npm test) || echo "FAIL: $d"
done
(cd ~/Desktop/openclaw/workspace-mirror/scripts && npm test) || echo "FAIL: scripts"
```

Expected: all pass (no "FAIL:" lines).

- [ ] **Step 2: Push branch**

```bash
cd ~/Desktop/openclaw
git status
git push -u origin feat/plan-d-orchestration-scheduling
```

- [ ] **Step 3: File follow-up beads**

```bash
bd create --title="M3 follow-on: interactive cron-drift detection" --description="Per §11 of M3 design: wake-from-sleep should DM user with [Yes/Skip] if missed daily-loop > 2h. Needs source of scheduledTs (env var from OpenClaw cron or CLI flag)." --type=feature --priority=3

bd create --title="Cache a Lex Fridman fixture episode for clip-path smoke" --description="Per M3 design §10 handoff: needed to smoke-test the full clip-extract path end-to-end. One-time manual: pick an episode, run bin/scan.js + bin/transcribe.js once." --type=task --priority=3
```

- [ ] **Step 4: Open PR**

Use the GitHub web UI (user preference: gh CLI not installed): open a PR from `feat/plan-d-orchestration-scheduling` to `main` at https://github.com/MukhammadIbrokhimov/openclaw. Title: `feat(m3): orchestration & scheduling — orchestrator + report + cron provisioning`. Body: short summary referencing the spec file. Do NOT add a Claude signature.

- [ ] **Step 5: Close beads when merged**

After the PR merges:

```bash
bd close openclaw-c8y --reason="M3 merged via PR. Orchestrator + report skills + cron provisioning + quiet-queue + archive prune + config/cron.yaml shipped. End-to-end observed: node scripts/install-cron.mjs registered 6 jobs; openclaw cron run openclaw-managed-daily-loop produced drafts in Telegram."
bd dolt push
```

- [ ] **Step 6: Final verify**

```bash
cd ~/Desktop/openclaw && git status
```

Expected: branch `main` (or feat branch) is up to date; no pending changes.

---

# Summary

**Task count:** 25 tasks across 7 phases.

**Expected new test count:** ~45 unit tests added on top of M1+M2's existing 156.

**Success criteria (from spec §9):**

1. All skill test suites pass — Task 21
2. `scripts/install-cron.mjs` tests pass — Task 17
3. `config/cron.yaml` has 6 jobs — Task 18
4. `node scripts/install-cron.mjs` registers 6 OpenClaw cron jobs — Task 23
5. `openclaw cron run openclaw-managed-daily-loop` produces drafts — Task 24
6. `bin/smoke-run.js --orchestrator --sandbox` produces drafts — Task 19
7. M3 branch merged to main via PR — Task 25
