#!/bin/bash
# PostToolUse hook: runs soft-lint over the edited file's uncommitted change and hands any findings to the agent as
# advisory context. It acts only in a git repo with a .soft-lint.json at its root, and never fails the edit: when
# soft-lint cannot run it leaves one line on stderr and exits 0.
set -u
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli.ts

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

errors=$(mktemp)
findings=$(printf '%s\n' "$diff" | node "$cli" "$rules" 2> "$errors")
status=$?
if [ "$status" -eq 2 ]; then
  # The first reason it could not ask the classifier, else the run's own error, which is its last line.
  reason=$(grep -m 1 'could not ask the classifier' "$errors" || tail -n 1 "$errors")
  echo "soft-lint: could not run on $path: ${reason#soft-lint: }" >&2
fi
rm -f "$errors"

# Exit 2 can still carry findings from the hunks that were checked.
if [ -n "$findings" ]; then
  context="soft-lint findings on your edit to $path. They are advisory: a classifier's yes/no on the added lines, not a lint error. Fix the ones you agree with; ignore the rest.
$findings"
  node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: process.argv[1] } }))' "$context"
fi
exit 0
