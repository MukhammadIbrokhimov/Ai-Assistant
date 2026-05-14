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

## Healthchecks.io watchdog

External liveness alert: every 5 min the daemon pings a healthchecks.io URL; if the pings stop arriving for longer than the channel's grace window (15 min by default), healthchecks.io alerts the user via whatever integrations are configured on its side (SMS, email, Telegram, etc.). Unlike cron-drift, this catches the case where the *machine itself* is unreachable.

**Setup.**

1. Create a check at healthchecks.io with a 15-minute period and copy its ping URL.
2. Add to `~/.openclaw/workspace/.env`:
   ```
   OPENCLAW_HEALTHCHECK_URL=https://hc-ping.com/<uuid>
   ```
3. Install the launchd job:
   ```bash
   node workspace-mirror/scripts/install-healthcheck.mjs
   ```
   `--dry-run` previews; `--uninstall` removes it.

Pings are logged to `~/openclaw-drafts/logs/launchd-healthcheck-ping.log`. The ping script always exits 0 — an outage is detected externally by healthchecks.io when pings stop, not by launchd marking the job as failed.

## Bootstrapping a clean clone

```bash
node workspace-mirror/scripts/setup.mjs
```

Runs `npm install` in every `workspace-mirror/skills/*` and `workspace-mirror/scripts/` directory. After this completes, `npm test` works in any skill directory.
