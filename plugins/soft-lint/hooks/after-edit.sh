#!/bin/bash
# PostToolUse hook: runs soft-lint over the edited file's uncommitted change and hands any findings to the agent as
# advisory context. It acts only in a git repo with a .soft-lint.json at its root, and never fails the edit: when
# soft-lint cannot run it leaves one line on stderr and exits 0. Each run it makes appends one line to
# $CLAUDE_PLUGIN_DATA/runs.jsonl, for reviewing how the rules behave in real use.
set -u
plugin=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

file=$(node -e 'const input = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(input.tool_input?.file_path ?? "")') || exit 0
[ -f "$file" ] || exit 0
dir=$(dirname "$file")
root=$(cd "$dir" && git rev-parse --show-toplevel 2>/dev/null) || exit 0
rules=$root/.soft-lint.json
[ -f "$rules" ] || exit 0

# The repo-relative path, from git's own view of the directory, so a symlinked path to the repo still matches.
path=$(cd "$dir" && git rev-parse --show-prefix)$(basename "$file")

if (cd "$root" && git ls-files --error-unmatch -- "$path" > /dev/null 2>&1); then
  diff=$(cd "$root" && git diff -W -- "$path")
else
  # --no-index exits 1 when the files differ, which they always do here.
  diff=$(cd "$root" && git diff --no-index -W -- /dev/null "$path")
fi
[ -n "$diff" ] || exit 0

# respond.ts turns soft-lint's report into the agent's context, the stderr line on exit 2 and the run log line.
report=$(printf '%s\n' "$diff" | node "$plugin/cli.ts" --json "$rules")
status=$?
printf '%s' "$report" | node "$plugin/hooks/respond.ts" "$root" "$path" "$status"
exit 0
