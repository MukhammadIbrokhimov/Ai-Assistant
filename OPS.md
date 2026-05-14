# Operations notes

Concise runbooks for recurring local-machine operations. M3 is launchd-scheduled, so cron and the gateway are independent: cron keeps running even if the gateway is unpaired, but Telegram approval/poller stops working until pairing is restored.

## Gateway re-pair after laptop reboot

**Symptom.** Drafts are produced, but no approval keyboard arrives in Telegram. `openclaw cron list --json` errors with `pairing required` (gateway side; ignore for cron — launchd is the scheduler).

**Cause.** OpenClaw gateway loses its pairing token on reboot. Poller + approval skills still send via Telegram Bot API, but the gateway's outbound DM channel for our agent identity is gated on pairing.

**Fix.**

```bash
# Confirm pairing state
openclaw devices list

# Approve our device (id from the list)
openclaw devices approve <device-id>

# Verify
openclaw devices list   # should show "paired"
```

After approval, the next poller run (or `flush-quiet-queue` at 08:00) will deliver buffered approval messages. No additional restart needed.

## Cron-drift detection

`launchd` does not catch up missed `StartCalendarInterval` fires when the machine was asleep on battery (only `RunAtLoad=true` jobs catch up — we don't set that). To detect silent skips:

```bash
node workspace-mirror/scripts/check-cron-drift.mjs
```

Compares each job's most recent expected fire (from `workspace-mirror/config/cron.yaml`) against the mtime of `~/openclaw-drafts/logs/launchd-{name}.log`. Reports drifts > 2h as JSON on stdout; exits non-zero if any drift is found, so it composes with shell pipelines and watchdog alerts.

Schedule it daily (suggested 09:30 — just after `daily-loop` at 09:00) by adding to `cron.yaml`, or run it manually after any extended sleep.

## Bootstrapping a clean clone

```bash
node workspace-mirror/scripts/setup.mjs
```

Runs `npm install` in every `workspace-mirror/skills/*` and `workspace-mirror/scripts/` directory. After this completes, `npm test` works in any skill directory.
