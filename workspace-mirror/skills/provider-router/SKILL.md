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
