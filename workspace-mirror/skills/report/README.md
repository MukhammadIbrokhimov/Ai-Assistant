# report

Nightly digest: last-24h drafts + spend + rejection reasons, sent as one Telegram DM.

## CLI

    bin/report.js --job=nightly [--sandbox]

## Smoke

    node bin/report.js --job=nightly

Expected: one Telegram DM. If no activity: "Quiet day — no drafts produced."
