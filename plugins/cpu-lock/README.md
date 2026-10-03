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
CPU_LOCK_MAX=900 cpu-lock.sh nx test   # kill the run (exit 124) if it holds the lock over 900 s
```

A queued run says what it is waiting behind. State lives in `${XDG_CACHE_HOME:-~/.cache}/cpu-lock/`:
`cpu.holder` and one file per waiter in `waiters/`, each a list of `key:   value` lines (`pid`,
`worktree`, `branch`, `started`, `command`, `session`; the holder adds `epoch` and `budget`). A
record whose process has died is stale; readers check liveness and ignore it.

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
# nx, bare, through npx or through yarn; long-lived servers (nx dev) stay out
((npx|yarn( run)?) )?nx (test|typecheck|lint|build|e2e|affected|run-many)(:| |$)
```

- One regular expression per line. Blank lines and lines starting with `#` are skipped.
- A pattern matches from the start of a simple command: the command word and its arguments, joined
  by single spaces. Leading assignments (`FOO=1`), `env`, keywords (`do`, `then`, `time`) and a
  `cpu-lock.sh` already in front are not part of it.
- Write word boundaries as `( |$)`. Patterns must mean the same as a POSIX extended regex and as a
  JavaScript regex, so use neither `\s` nor `[[:space:]]`.
- Gate every spelling of a heavy command that may reach the shell (`npx nx`, `yarn nx`, `nx`).
  Another plugin that rewrites commands may run before or after this one, so this one may see
  either the spelling the agent wrote or the one it is rewritten to.

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
  after any assignment, `env` or keyword, so they still apply to the run. A command that already
  runs through a `cpu-lock.sh`, by any path, is not wrapped again. A foreground call with no
  timeout of its own gets the Bash maximum, 600000 ms, since the default two minutes would return
  mid-run. When a live run holds the lock, the model is told who holds it, for how long and how
  many wait. Subagents' calls are wrapped too.
- **Stops this session's runs when it exits.** On exit, every live waiter and holder whose record
  names this session is cancelled through `cpu-lock.sh --cancel`, detached so the cancels finish
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
`commandIndex` looks past assignments, `env`, keywords and a `cpu-lock.sh` wrapper, so a rule that
fixes `npx nx …` finds it inside `cpu-lock.sh npx nx …` too and fixes it in place: whichever
plugin runs first, the command that reaches the shell is the same.

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
