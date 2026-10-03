# c9r plugins

A plugin marketplace for Claude Code and Codex.

## Install

Claude Code:

```text
/plugin marketplace add c9r-dev/plugins
/plugin install <plugin>@c9r
```

Codex CLI:

```bash
codex plugin marketplace add c9r-dev/plugins
codex plugin add <plugin>@c9r
```

## Plugins

### [browser-check](plugins/browser-check/README.md)

Runs a checklist written in plain English, one action or check per line, in a real browser. Playwright drives the
page and a judgment model decides each step: which element an action means, and whether a check holds. An agent uses
it to check its own work after a user-visible change, to run a pull request's QA steps as written, or to compare two
builds. It starts from any URL, or logged in through an app's own e2e fixture. A 24-step flow takes about 35 seconds
and about a cent.

It reports one verdict line, PASS or FAIL over the steps it decided, plus screenshots. A check about looks (layout,
colour, clipping) is handed back to the calling agent with a screenshot, unless a visual judge is installed.

Needs Playwright 1.59 or newer and a browser already installed (it never installs either), and credentials for the
judgment model; [its README](plugins/browser-check/README.md) has the details.

### [browser-check-visual](plugins/browser-check-visual/README.md)

A visual judge for browser-check. It looks at the screenshot of each visual step with a vision judgment model,
passes the steps it is confident hold, and hands the rest back to the agent with a score. It can never fail a step.
On 32 hand-labelled visual claims it agreed with the label 96.9% of the time and never passed a false one.

Installing it is the whole setup in Claude Code: a session hook points browser-check at it. Needs a Cloudflare
account with Workers AI access.

### [cpu-lock](plugins/cpu-lock/README.md)

Runs one CPU-heavy command at a time across every project and worktree on a Mac, so test suites and builds started
from different worktrees or agents queue instead of oversubscribing the cores. Each repo lists its heavy commands as
patterns in `.claude/cpu-lock`; the plugin wraps the Bash calls they match in the lock, subagents' calls included.

It tells Claude when a call will queue, and when a session exits it stops that session's queued and running runs. It
also offers its bash parser to other plugins as `$.shell`.

Needs macOS and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Claude Code only; Codex does not load it.

## Releases

Each plugin is versioned by its own `plugins/<name>/.claude-plugin/plugin.json`. Bump it in the pull request that
should ship; when that lands on `main`, a workflow publishes the GitHub release `<name>-vX.Y.Z`. A merge that leaves
a version alone publishes nothing for that plugin.

## Licence

MIT
