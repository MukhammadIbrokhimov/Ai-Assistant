#!/bin/bash
# Wrapper used by launchd-fired M3 jobs. Sources ~/.openclaw/workspace/.env
# so secrets (TG_BOT_TOKEN, PEXELS_API_KEY, etc.) are in the job's env,
# then execs the arguments verbatim.
set -euo pipefail
ENV_FILE="$HOME/.openclaw/workspace/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
exec "$@"
