#!/bin/bash
# Serialises CPU-heavy commands to one at a time across every project and worktree on this machine.
#
# A test or build run already saturates the cores, so two at once oversubscribe them and both get
# slower: the limit is one run, not a share of the cores. Which commands count as heavy is each
# project's call, as patterns in its .claude/cpu-lock (see README.md).
#
# The mutex is a kernel flock via lockf(1): it is released whenever the holder dies, for any
# reason including SIGKILL, so a crashed run cannot wedge the other worktrees.
#
#   cpu-lock.sh nx test:unit my-app
#   cpu-lock.sh cargo test --workspace 2>&1 | tee /tmp/run.txt
#   cpu-lock.sh --status          # who holds the lock and who is queued
#   cpu-lock.sh --cancel <pid>    # stop a queued or running run, by the pid --status shows
#
# CPU_LOCK_MAX=<seconds> kills a run that holds the lock longer, so a hung run frees it.

set -uo pipefail

LOCK_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/cpu-lock"
LOCK="$LOCK_DIR/cpu.lock"
HOLDER="$LOCK_DIR/cpu.holder"
WAITERS="$LOCK_DIR/waiters"

# Reads a key from one of the metadata files written below.
field() { sed -n "s/^$2:[[:space:]]*//p" "$1" 2>/dev/null | head -1; }

# A record is only real if its process is still alive. Nothing is cleaned up on SIGKILL, so
# liveness is checked on read rather than trusted from a trap.
alive() { [ -n "${1-}" ] && kill -0 "$1" 2>/dev/null; }

describe() {
  printf '%s  %s\n' "$(field "$1" branch)" "$(field "$1" command)"
  printf '    pid %s in %s since %s\n' "$(field "$1" pid)" "$(field "$1" worktree)" "$(field "$1" started)"
}

if [ "${1-}" = "--status" ]; then
  if [ -f "$HOLDER" ] && alive "$(field "$HOLDER" pid)"; then
    echo "holding the cpu lock:"
    describe "$HOLDER"
    epoch=$(field "$HOLDER" epoch); budget=$(field "$HOLDER" budget)
    if [ -n "$epoch" ]; then
      age=$(($(date +%s) - epoch))
      line="    held for ${age}s"
      [ "${budget:-0}" -gt 0 ] && line="$line of a ${budget}s budget"
      [ "${budget:-0}" -gt 0 ] && [ "$age" -gt "$budget" ] && line="$line  ** OVER BUDGET **"
      echo "$line"
    fi
  else
    [ -f "$HOLDER" ] && rm -f "$HOLDER"
    echo "cpu lock is free."
  fi
  n=0
  for w in "$WAITERS"/*; do
    [ -e "$w" ] || continue
    if alive "$(basename "$w")"; then
      [ "$n" -eq 0 ] && echo "queued behind it:"
      n=$((n + 1))
      describe "$w"
    else
      rm -f "$w"   # waiter was killed while queued
    fi
  done
  [ "$n" -eq 0 ] && echo "nothing queued."
  exit 0
fi

# Every pid below $1, found by walking the process tree, so a kill names exact pids and never a pattern.
descendants() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants "$p"; done; }

# TERM the child and everything under it, then KILL what survived. The kernel releases the lock once
# nothing holds its fd, so this is all that is needed to free it.
kill_tree() {
  local pids p i any
  pids="$1 $(descendants "$1")"
  for p in $pids; do kill -TERM "$p" 2>/dev/null; done
  for i in 1 2 3 4 5; do
    any=0
    for p in $pids; do alive "$p" && any=1; done
    [ "$any" -eq 0 ] && return 0
    sleep 1
  done
  for p in $pids; do kill -KILL "$p" 2>/dev/null; done
}

# Second entry, now inside the critical section: record the holder, run, clean up.
if [ "${1-}" = "--held" ]; then
  shift
  waiter_pid="$1"; shift
  rm -f "$WAITERS/$waiter_pid"
  budget=${CPU_LOCK_MAX:-0}

  {
    echo "pid:      $$"
    echo "worktree: $PWD"
    echo "branch:   $(git branch --show-current 2>/dev/null || echo '?')"
    echo "started:  $(date '+%H:%M:%S')"
    echo "epoch:    $(date +%s)"
    echo "budget:   $budget"
    echo "command:  $*"
    echo "session:  ${CLAUDE_CODE_SESSION_ID-}"
  } >"$HOLDER" 2>/dev/null
  trap 'rm -f "$HOLDER"' EXIT
  # Name the checkout up front: a Bash call's cwd resets to the session's own directory, and a run
  # from the wrong checkout tests that checkout's code and passes with no error.
  branch=$(git branch --show-current 2>/dev/null)
  echo "cpu-lock: running in $(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD") on ${branch:-a detached HEAD}" >&2
  [ "$budget" -gt 0 ] && echo "cpu-lock: budget ${budget}s (CPU_LOCK_MAX)" >&2

  "$@" <&0 &
  child=$!
  trap 'kill_tree "$child"; exit 143' TERM INT HUP

  rc=''
  start=$SECONDS
  while alive "$child"; do
    sleep 2
    if [ "$budget" -gt 0 ] && [ $((SECONDS - start)) -gt "$budget" ]; then
      echo "cpu-lock: exceeded CPU_LOCK_MAX (${budget}s); killing the run so the lock is freed" >&2
      kill_tree "$child"; rc=124; break
    fi
  done
  if [ -z "$rc" ]; then wait "$child"; rc=$?; fi
  exit "$rc"
fi

# Stops one queued or running run by the pid its record names, with everything under it. Only a pid
# that is a current holder or waiter is accepted, so this can never kill an unrelated process.
if [ "${1-}" = "--cancel" ]; then
  pid="${2-}"
  if [ -n "$pid" ] && [ -f "$WAITERS/$pid" ]; then
    kill_tree "$pid"
    rm -f "$WAITERS/$pid"
    echo "cpu-lock: cancelled queued run $pid"
  elif [ -n "$pid" ] && [ "$(field "$HOLDER" pid)" = "$pid" ]; then
    kill_tree "$pid"
    echo "cpu-lock: stopped running run $pid"
  else
    echo "cpu-lock: $pid is not a queued or running cpu-lock run" >&2
    exit 1
  fi
  exit 0
fi

[ $# -gt 0 ] || { echo "usage: cpu-lock.sh <command> [args...] | --status | --cancel <pid>" >&2; exit 64; }
mkdir -p "$LOCK_DIR" "$WAITERS"

# Register as a waiter before queueing, so --status can show the whole queue. The record is
# removed on acquisition; if this process is killed first, --status prunes it by liveness.
{
  echo "pid:      $$"
  echo "worktree: $PWD"
  echo "branch:   $(git branch --show-current 2>/dev/null || echo '?')"
  echo "started:  $(date '+%H:%M:%S')"
  echo "command:  $*"
  echo "session:  ${CLAUDE_CODE_SESSION_ID-}"
} >"$WAITERS/$$" 2>/dev/null

# Probe without waiting, purely so a queued run can say what it is queued behind.
if ! /usr/bin/lockf -k -t 0 "$LOCK" true 2>/dev/null; then
  echo "cpu-lock: waiting — another run holds the cpu lock:" >&2
  [ -f "$HOLDER" ] && sed 's/^/cpu-lock:   /' "$HOLDER" >&2
  echo "cpu-lock: this run starts when that one finishes. Run it in the background so the wait cannot time out." >&2
  echo "cpu-lock: see the whole queue with: ~/.claude/scripts/cpu-lock.sh --status" >&2
fi

exec /usr/bin/lockf -k "$LOCK" "$0" --held "$$" "$@"
