# browser-check

A Claude Code and Codex plugin that runs a checklist written in plain English in a real browser. Each line is
an action ("Select the Generate Link button", `Type "Acme" into the Name field`) or a check ("Confirm the report
lists three risks"), and a judgment model decides each step. [Playwright](https://playwright.dev) drives the
browser; TypeSafe's Jev model, served on [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) as
`typesafe/jev`, picks the element for each action from the page's accessibility tree and judges each check.

A 24-step flow runs in about 35 seconds for about a cent of Jev calls. Driving the same flow through a browser
extension took Claude 14 minutes.

## What it is for

- **An agent checking its own work.** After a user-visible change, Claude or Codex can run a flow before saying
  the work is done. It gives a subagent a few lines describing the flow when delegation is available, or runs
  the checklist directly, and gets back one verdict line plus screenshots instead of spending its context on a
  click-by-click browser session. The run reports
  `[qa] verdict PASS: 8 of 8 decisive steps passed` or the failing step with its reason. With an `--app` manifest
  it logs in through the app's own e2e fixture, so a login or 2FA screen never stops it.
- **Running a PR's QA steps.** The "how to test" section of a pull request is usually a checklist already; paste
  it in and it runs as written.
- **Before-and-after evidence.** Run one checklist against two servers, such as the branch and main, and compare
  the verdicts and screenshots.

```text
[qa] 2 passed click 1345ms settle=562ms a=1 c=1.00 Select the "External shares" button | button "External shares"
[qa] 6 passed goto 3455ms settle=1220ms a=1 c=0.77 Open the URL shown in the Link field | opened https://…/shares/reports/… from textbox "Link"
[qa] 8 passed verify 1516ms settle=264ms a=1 c=0.98 Confirm the page shows the "Table Widths" report | yes-probability 0.98
[qa] verdict PASS: 8 of 8 decisive steps passed
```

It is a QA aid, not a test framework: a pass is Jev's judgement, not a locator assertion. Jev reads the
accessibility tree, never pixels, so it judges structure and text. A check about layout, overlap, clipping or
colour is captured as a full-page screenshot and handed to the calling agent, which can see images: the verdict
line lists each such step with its screenshot's path, and the run is finished once the caller has judged them.

## Install

### Claude Code

```text
/plugin marketplace add c9r-dev/plugins
/plugin install browser-check@c9r
```

Then ask Claude to "qa check" a flow, or invoke the `browser-check` skill.

To update, run `claude plugin update browser-check@c9r`, then restart Claude Code or run
`/reload-plugins`. It fetches the latest release from GitHub itself, so no `plugin marketplace update` is needed
first.

### Codex CLI

```bash
codex plugin marketplace add c9r-dev/plugins
codex plugin add browser-check@c9r
```

Start a new Codex session, then ask it to "qa check" a flow or invoke `$browser-check`. In the desktop app, add the
repository as a plugin marketplace and install `browser-check` from the Plugins Directory. The same package works
in Claude Code and Codex.

[`skills/browser-check/SKILL.md`](skills/browser-check/SKILL.md) is the full guide: how to write steps, read the
output and debug a failure.

### Moving from jev-playwright

An install of `jev-playwright` from the `jev-playwright` marketplace does not update to `browser-check`. In Claude
Code, remove it and install again:

```text
/plugin uninstall jev-playwright@jev-playwright
/plugin marketplace remove jev-playwright
/plugin marketplace add c9r-dev/plugins
/plugin install browser-check@c9r
```

In Codex, remove the `jev-playwright` plugin and marketplace, then install with the commands above.
App manifests live in `~/.config/browser-check/apps/`, so move any you have:

```bash
mv ~/.config/jev-playwright ~/.config/browser-check
```

A repository that excludes the per-run copy directory (`.jev-playwright/` in `.git/info/exclude`) should exclude
`.browser-check/` instead.

### Moving from jev-browse

An install under the plugin's earlier name, `jev-browse`, does not update either. In Claude Code:

```text
/plugin uninstall jev-browse@jev-browse
/plugin marketplace remove jev-browse
/plugin marketplace add c9r-dev/plugins
/plugin install browser-check@c9r
```

In Codex, reinstall with the commands above. Move any app manifests:

```bash
mv ~/.config/jev-browse ~/.config/browser-check
```

## Requirements

- **A Cloudflare account with Workers AI access**, and an API token that can run Workers AI models. Put both in
  `~/.config/jev/env` (or a file named by `$JEV_ENV_FILE`):

  ```bash
  export CLOUDFLARE_ACCOUNT_ID=…
  export CLOUDFLARE_API_TOKEN=…
  ```

- **A checkout with Playwright and its browsers installed.** The runner is copied into it for each run and removed
  afterwards; `--worktree` names it.
- **The app already served** at the URL the run will hit. The plugin never starts servers or seeds data.

The runner sends the page's accessibility tree and checklist text to Cloudflare Workers AI for Jev decisions.
Codex must be able to execute Playwright locally and reach Cloudflare's API; its sandbox may request permission
for those operations.

## Two ways to start

- `--url https://…` opens any page, anonymously or from a Playwright storage-state file (`--storage-state`).
- `--app NAME` starts from your app's own logged-in e2e fixture. Describe the app once in
  `~/.config/browser-check/apps/`: `NAME.env` sets `E2E_DIR` and `RUN`, and `NAME.spec.ts` gets a logged-in page
  from your fixtures and calls `runChecklist`. The skill documents the format.

For a first `--url` check from a repository checkout, with a Playwright project available at
`/path/to/playwright-project`:

```bash
printf '%s\n' 'Confirm the page shows the "Example Domain" heading' > /tmp/browser-check-steps.txt
plugins/browser-check/skills/browser-check/run.sh /tmp/browser-check-steps.txt --url https://example.com --worktree /path/to/playwright-project
```

Releases and licence: see the [marketplace README](../../README.md).
