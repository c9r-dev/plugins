# cpu-lock

One CPU-heavy command at a time, across every project and worktree on a Mac.

A test suite or a release build already uses every core. Two at once, from two worktrees or two
agents, oversubscribe the machine and both finish later than they would have in turn. `cpu-lock.sh`
queues them instead.

Requires macOS (`/usr/bin/lockf`). The lock is a kernel flock, released whenever its holder dies,
for any reason including `SIGKILL`, so a crashed run never wedges the queue.

It is two things: the lock itself, a shell script you can use on its own, and a Claude Code
plugin that routes an agent's heavy commands through it. The plugin is for Claude Code only; Codex
does not load it.

## Usage

```bash
cpu-lock.sh cargo test --workspace     # waits its turn, then runs; exits with the command's status
cpu-lock.sh --status                   # who holds the lock, how long, and who is queued
cpu-lock.sh --cancel <pid>             # stop a queued or running run, by the pid --status shows
cpu-lock.sh --cancel-session <id>      # stop every queued or running run of one Claude Code session
CPU_LOCK_MAX=900 cpu-lock.sh make test # kill the run (exit 124) if it holds the lock over 900 s
```

A queued run says what it is waiting behind. `--status` exits 0 while the lock is free and 3 while
a run holds it. State lives in `${XDG_CACHE_HOME:-~/.cache}/cpu-lock/`: a record of the holder and
of each waiter, naming its pid, checkout, branch, command and Claude Code session. A record whose
process has died is stale, and the script ignores it.

To use the script without the plugin, put it on your `PATH` from a checkout of
[c9r-dev/plugins](https://github.com/c9r-dev/plugins):

```bash
ln -s "$PWD/plugins/cpu-lock/cpu-lock.sh" /usr/local/bin/cpu-lock.sh
```

## Which commands are heavy: `.claude/cpu-lock`

Each repo declares its own heavy commands in `.claude/cpu-lock` at its top level. A repo without
the file gates nothing.

```
# Rust
cargo (test|build|clippy|bench|run)( |$)
# nx; long-lived servers (nx dev) stay out
nx (test|lint|build)(:| |$)
```

- One regular expression per line. Blank lines and lines starting with `#` are skipped.
- A pattern matches from the start of a simple command: the command word and its arguments, joined
  by single spaces. Leading assignments (`FOO=1`), keywords (`do`, `then`) and the commands that run
  the words after them (`env`, `time`, `nice`, `nohup` and a `cpu-lock.sh` already in front), with
  their `-option` words, are not part of it.
- Write word boundaries as `( |$)`. Patterns must mean the same as a POSIX extended regex and as a
  JavaScript regex, so use neither `\s` nor `[[:space:]]`.
- If another plugin rewrites commands, gate both the form the agent writes and the form it is
  rewritten to: plugins of one tier run in no set order, so this one may see either.

The lock itself never reads this file. It is the contract for whatever wraps commands
automatically, which in Claude Code is the plugin below.

## The Claude Code plugin

It is written as function hooks, which are early access: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` must
be in the environment, or in `env` in `~/.claude/settings.json`.

```text
/plugin marketplace add c9r-dev/plugins
/plugin install cpu-lock@c9r
```

or, for one session, `claude --plugin-dir <checkout>/plugins/cpu-lock`.

It does three things.

- **Wraps gated commands.** Before every Bash call, it reads `<git toplevel>/.claude/cpu-lock` for
  the session's directory and puts its own `cpu-lock.sh`, by absolute path inside the installed
  plugin, in front of each simple command a pattern matches. The wrapper goes at the command word,
  after any assignment, keyword, `env`, `time`, `nice` or `nohup`, so they still apply to the run.
  A command that already runs through a `cpu-lock.sh`, by any path, is not wrapped again. A
  foreground call with no timeout of its own gets the Bash maximum, 600000 ms, since the default
  two minutes would return mid-run. When a live run holds the lock, the model is told the call will queue, with what
  `cpu-lock.sh --status` reports. Subagents' calls are wrapped too.
- **Stops this session's runs when it exits.** On exit, `cpu-lock.sh --cancel-session` cancels
  every live waiter and holder whose record names this session, detached so the cancels finish
  after Claude has gone. A `/clear` or a resume keeps the process and its runs, so it cancels
  nothing.
- **Lends its shell lexer to other plugins**, as the `shell` noun on `$`.

Nothing here denies a command: an unwrapped heavy command runs, unqueued, as it would without the
plugin. A command the lexer cannot account for is passed through untouched.

### The `shell` noun

A plugin that needs to read Bash commands as the shell would, without regexes over the whole
string, can use this plugin's lexer. List it in your `plugin.json`:

```json
{ "name": "my-plugin", "dependencies": ["cpu-lock"] }
```

The engine then lays this plugin's contract, `types/index.d.ts`, into your plugin's
`.claude-plugin/types/cpu-lock/index.d.ts`, so `$.shell` is typed:

```ts
on("tool.call", { tool: "Bash" }, async ($, e, next) => {
  const parsed = await $.shell.parse(e.command);
  if (!parsed.ok) return next(e); // parsed.error says why
  for (const segment of parsed.segments) {
    const word = segment.words[segment.commandIndex]; // undefined when the segment runs nothing
    // word.start and word.end are offsets into e.command, for splicing
  }
  return next(e);
});
```

`parse` answers plain data: one segment per simple command, each with its tokens (words,
operators, redirections, heredoc bodies) and their offsets into the command, their unquoted
values, and whether each was quoted or expands. A quoted string, a heredoc body and a commit
message that merely name a command are tokens of another command, never a command of their own.
`commandIndex` looks past assignments, keywords, `env`, `time`, `nice`, `nohup` and a `cpu-lock.sh`
wrapper, with their `-option` words, so a plugin that rewrites a command finds it inside
`cpu-lock.sh …` too and rewrites it in place: whichever plugin runs first, the command that
reaches the shell is the same.

`claude plugin test` does not load a plugin's dependencies, so a dependent's tests do not reach
`$.shell`.

### Developing it

From `plugins/cpu-lock`:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 npm test    # claude plugin test .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/plugin.json
```

The lexer is `hooks/shell.ts`, the wrapping and the queue note `hooks/wrap.ts`, and the hooks
`hooks/register.ts`.
