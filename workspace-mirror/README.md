# workspace-mirror/

Version-controlled mirror of `~/.openclaw/workspace/` (skills + configs, NOT secrets or state).

The live workspace stays at `~/.openclaw/workspace/` because OpenClaw expects it there.
This mirror exists so the agent code is in version control, reviewable, portable.

To restore from this mirror onto a fresh laptop:

  rsync -a workspace-mirror/ ~/.openclaw/workspace/
  # then re-create ~/.openclaw/workspace/.env from your password manager

Required env vars in `~/.openclaw/workspace/.env`:

  - `TG_BOT_TOKEN`         — Telegram bot token (BotFather)
  - `TG_PAIRED_USER_ID`    — your Telegram numeric user id
  - `ANTHROPIC_API_KEY`    — Claude API (console.anthropic.com)
  - `OPENAI_API_KEY`       — Whisper transcription (platform.openai.com)
  - `PEXELS_API_KEY`       — stock images for slideshow drafts (pexels.com/api)
  - `YOUTUBE_API_KEY`      — channel discovery, weekly source-discovery-pull cron
                             (free quota, console.cloud.google.com/apis/credentials)

Plan A populated:
  - skills/provider-router/   (full)
  - config/*.yaml             (all 5 configs)
  - AGENTS.md, SOUL.md, TOOLS.md (stubs)

Plans B/C/D will populate:
  - skills/{approval,archive,research,whitelist-scan,transcribe,clip-extract,
            slideshow-draft,quotecard-draft,orchestrator,report}/
