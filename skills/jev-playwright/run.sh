#!/bin/bash
# usage:
#   run.sh <steps-file> --url URL [--storage-state FILE] [--worktree DIR] [--project NAME] [--viewport WxH] [--output DIR] [--headed] [--hold] [--trace] [--video] [--screenshots] [-- playwright args]
#   run.sh <steps-file> --app NAME [--worktree DIR] [--project NAME] [--output DIR] [--headed] [--trace] [--screenshots] [-- playwright args]
#
# --url starts from any page with no fixtures; pass a Playwright storage-state file to start logged in. It runs
# under the standalone config copied to <worktree>/.jev-playwright/.
# --app NAME starts from an app's own e2e fixture, as defined by the manifest NAME.env + NAME.spec.ts in
# ${XDG_CONFIG_HOME:-~/.config}/jev-playwright/apps/. NAME.env is a shell fragment setting E2E_DIR (the app's e2e
# directory, relative to the worktree) and RUN (the command that runs qa.spec.ts under the app's Playwright config);
# NAME.spec.ts is a Playwright test that obtains a logged-in page from the app's fixtures and calls runChecklist.
# The engine is copied to <worktree>/<E2E_DIR>/qa/ and the spec to <worktree>/<E2E_DIR>/qa.spec.ts.
#
# --project names a Playwright project: Desktop-Chromium (the default), Desktop-Firefox, Desktop-Webkit,
# Mobile-Chromium, Mobile-Webkit-iPad or Mobile-Webkit-iPhone. Runs headless unless --headed is passed.
# --hold (--url only) runs headed and leaves the browser where the checklist ended until the page is closed.
#
# The skill owns nothing about the target: the caller serves the app, seeds the backend and prepares any session.
# The runner source lives beside this script and is copied into the worktree for each run, then removed.
set -u
SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${JEV_ENV_FILE:-$HOME/.config/jev/env}
APPS_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/jev-playwright/apps

steps=${1:?steps file}; shift
app=""; url=""; storage=""; worktree=$PWD; project=Desktop-Chromium; headed=""
tmp=${TMPDIR:-/tmp}
output=${tmp%/}/jev-playwright
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app=$2; shift 2 ;;
    --url) url=$2; shift 2 ;;
    --storage-state) storage=$2; shift 2 ;;
    --worktree) worktree=$2; shift 2 ;;
    --project) project=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    --viewport) export QA_VIEWPORT=$2; shift 2 ;;
    --headed) headed=--headed; shift ;;
    --hold) export QA_HOLD=1; headed=--headed; shift ;;
    --trace) export QA_TRACE=1; shift ;;
    --screenshots) export QA_SCREENSHOTS=1; shift ;;
    --video) export QA_VIDEO=1; shift ;;
    --) shift; break ;;
    *) echo "jev-playwright: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "jev-playwright: $ENV_FILE not found; it must export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

case "$steps" in /*) ;; *) steps=$PWD/$steps ;; esac
export QA_STEPS_FILE=$steps

# Each run gets its own directory outside the worktree, where a test run clearing test-results cannot delete it.
out=$output/$(date +%Y%m%d-%H%M%S)-$$

# Run the command from the worktree, remove the runner copies it needed, and exit with the command's status: a copy
# left in an app's e2e directory is picked up by that app's next full e2e run, which fails without QA_STEPS_FILE.
run_then_remove() {
  local copies=$1; shift
  (cd "$worktree" && "$@")
  local status=$?
  # shellcheck disable=SC2086
  rm -rf $copies
  exit $status
}

if [ -n "$app" ]; then
  [ -n "${QA_VIEWPORT:-}" ] && echo "jev-playwright: --viewport applies to --url runs only; --app takes the app config's projects" >&2
  [ -n "${QA_VIDEO:-}" ] && echo "jev-playwright: --video applies to --url runs only; the app fixtures create their own contexts (use --trace)" >&2
  [ -n "${QA_HOLD:-}" ] && { echo "jev-playwright: --hold applies to --url runs only; an --app run would keep the app's test command, and anything it holds, running while you browse" >&2; exit 2; }
  manifest=$APPS_DIR/$app
  if [ ! -f "$manifest.env" ] || [ ! -f "$manifest.spec.ts" ]; then
    echo "jev-playwright: no app manifest at $manifest.env; add one there, or use --url" >&2
    exit 2
  fi
  E2E_DIR=""; RUN=""
  # shellcheck disable=SC1090
  . "$manifest.env"
  [ -n "$E2E_DIR" ] && [ -n "$RUN" ] || { echo "jev-playwright: $manifest.env must set E2E_DIR and RUN" >&2; exit 2; }
  e2e=$worktree/$E2E_DIR
  [ -d "$e2e" ] || { echo "jev-playwright: $e2e not found; pass --worktree" >&2; exit 2; }
  mkdir -p "$e2e/qa/engine"
  cp -f "$SKILL_DIR"/runner/engine/*.ts "$e2e/qa/engine/"
  cp -f "$manifest.spec.ts" "$e2e/qa.spec.ts"
  # shellcheck disable=SC2086
  run_then_remove "$e2e/qa $e2e/qa.spec.ts" $RUN "--project=$project" --reporter=list "--output=$out" $headed "$@"
fi

if [ -n "$url" ]; then
  dir=$worktree/.jev-playwright
  [ -f "$worktree/node_modules/.bin/playwright" ] || { echo "jev-playwright: $worktree has no Playwright install (node_modules/.bin/playwright); pass --worktree" >&2; exit 2; }
  mkdir -p "$dir/engine"
  cp -f "$SKILL_DIR"/runner/engine/*.ts "$dir/engine/"
  cp -f "$SKILL_DIR/runner/browse.spec.ts" "$SKILL_DIR/runner/browse.config.ts" "$dir/"
  export QA_START_URL=$url
  [ -n "$storage" ] && export QA_STORAGE_STATE=$storage
  # shellcheck disable=SC2086
  run_then_remove "$dir" node_modules/.bin/playwright test -c .jev-playwright/browse.config.ts "--project=$project" "--output=$out" $headed "$@"
fi

echo "jev-playwright: pass --url <URL> or --app <NAME>" >&2
exit 2
