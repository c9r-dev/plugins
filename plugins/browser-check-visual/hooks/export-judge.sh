#!/bin/bash
# Points browser-check at this installed version's judge for the session's Bash calls. The path changes with every
# plugin update, so it is exported afresh each session rather than written into a config file. A QA_VISUAL_JUDGE the
# environment already sets wins.
judge=$CLAUDE_PLUGIN_ROOT/judge.mjs
if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  echo "browser-check-visual: CLAUDE_ENV_FILE is not set, so QA_VISUAL_JUDGE was not exported; set it to $judge" >&2
  exit 1
fi
# shellcheck disable=SC2016 # the default is expanded when the env file is sourced, not here
printf 'export QA_VISUAL_JUDGE="${QA_VISUAL_JUDGE:-%s}"\n' "$judge" >> "$CLAUDE_ENV_FILE"
