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
