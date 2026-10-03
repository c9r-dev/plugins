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

- [browser-check](plugins/browser-check/README.md) — run a plain-English QA checklist in a real browser, with a
  judgment model deciding each step.

## Releases

Each plugin is versioned by its own `plugins/<name>/.claude-plugin/plugin.json`. Bump it in the pull request that
should ship; when that lands on `main`, a workflow publishes the GitHub release `<name>-vX.Y.Z`. A merge that leaves
a version alone publishes nothing for that plugin.

## Licence

MIT
