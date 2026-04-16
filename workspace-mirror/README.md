# workspace-mirror/

Version-controlled mirror of `~/.openclaw/workspace/` (skills + configs, NOT secrets or state).

The live workspace stays at `~/.openclaw/workspace/` because OpenClaw expects it there.
This mirror exists so the agent code is in version control, reviewable, portable.

To restore from this mirror onto a fresh laptop:

  rsync -a workspace-mirror/ ~/.openclaw/workspace/
  # then re-create ~/.openclaw/workspace/.env from your password manager

Plan A populated:
  - skills/provider-router/   (full)
  - config/*.yaml             (all 5 configs)
  - AGENTS.md, SOUL.md, TOOLS.md (stubs)

Plans B/C/D will populate:
  - skills/{approval,archive,research,whitelist-scan,transcribe,clip-extract,
            slideshow-draft,quotecard-draft,orchestrator,report}/
