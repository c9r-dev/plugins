# cpu-lock

One CPU-heavy command at a time, across every project and worktree on a Mac.

A test suite or a release build already uses every core. Two at once, from two worktrees or two
agents, oversubscribe the machine and both finish later than they would have in turn. `cpu-lock.sh`
queues them instead.

Requires macOS (`/usr/bin/lockf`). The lock is a kernel flock, released whenever its holder dies,
for any reason including `SIGKILL`, so a crashed run never wedges the queue.

## Usage

```bash
cpu-lock.sh cargo test --workspace     # waits its turn, then runs; exits with the command's status
cpu-lock.sh --status                   # who holds the lock, how long, and who is queued
cpu-lock.sh --cancel <pid>             # stop a queued or running run, by the pid --status shows
CPU_LOCK_MAX=900 cpu-lock.sh nx test   # kill the run (exit 124) if it holds the lock over 900 s
```

A queued run says what it is waiting behind. State lives in `${XDG_CACHE_HOME:-~/.cache}/cpu-lock/`:
`cpu.holder` and one file per waiter in `waiters/`, each a list of `key:   value` lines (`pid`,
`worktree`, `branch`, `started`, `command`, `session`; the holder adds `epoch` and `budget`). A
record whose process has died is stale; readers check liveness and ignore it.

## Install

```bash
ln -s "$PWD/cpu-lock.sh" ~/.claude/scripts/cpu-lock.sh   # or anywhere on your PATH
```

## Which commands are heavy: `.claude/cpu-lock`

Each repo declares its own heavy commands in `.claude/cpu-lock` at its top level. A repo without
the file gates nothing.

```
# Rust
cargo (test|build|clippy|bench|run)( |$)
# nx, with or without yarn; long-lived servers (nx dev) stay out
(yarn (run )?)?nx (test|typecheck|lint|build|e2e|affected|run-many)(:| |$)
```

- One regular expression per line. Blank lines and lines starting with `#` are skipped.
- A pattern matches from the start of a simple command: the command word and its arguments, joined
  by single spaces. Leading assignments (`FOO=1`) and keywords (`do`, `then`) are not part of it.
- Write word boundaries as `( |$)`. Patterns must mean the same as a POSIX extended regex and as a
  JavaScript regex, so use neither `\s` nor `[[:space:]]`.

The lock itself never reads this file. It is the contract for whatever wraps commands
automatically.

## Claude Code

The `rewrite` plugin of claude-mods (not yet published) wraps every Bash call whose command
matches the repo's `.claude/cpu-lock` in `~/.claude/scripts/cpu-lock.sh`, and tells Claude when the
call will queue. It needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
