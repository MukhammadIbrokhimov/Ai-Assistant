# Built-in tools (OpenClaw provided)

- `bash`, `process`, `read`, `write`, `edit` — workspace-sandboxed by default
- `browser` (web search) — wired via Brave Search API. Set `BRAVE_SEARCH_API_KEY` in `.env` to enable; absent the key, research falls back to RSS only and emits a `web_search_disabled` event at startup (see `skills/research/web-search.js`). Brave's free tier is 2k queries/month.
- `cron` — schedule definitions consumed from `config/cron.yaml`

# Custom tools (skills we author)

- `provider-router` — route LLM calls based on current mode and task class. Returns `{text, tokensIn, tokensOut, latencyMs, providerUsed}`.

(More tools added in Plans B/C/D.)
