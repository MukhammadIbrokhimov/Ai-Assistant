# Built-in tools (OpenClaw provided)

- `bash`, `process`, `read`, `write`, `edit` — workspace-sandboxed by default
- `browser` — for web research (used in Plan C)
- `cron` — schedule definitions consumed from `config/cron.yaml`

# Custom tools (skills we author)

- `provider-router` — route LLM calls based on current mode and task class. Returns `{text, tokensIn, tokensOut, latencyMs, providerUsed}`.

(More tools added in Plans B/C/D.)
