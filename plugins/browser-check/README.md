# browser-check

A Claude Code and Codex plugin that runs a checklist written in plain English in a real browser. Each line is
an action ("Select the Generate Link button", `Type "Acme" into the Name field`) or a check ("Confirm the report
lists three risks"). [Playwright](https://playwright.dev) drives the browser, and a judgment model decides each
step: which element an action means, and whether a check holds.

A 24-step flow runs in about 35 seconds for about a cent of judgment calls. Driving the same flow through a browser
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

It is a QA aid, not a merge gate: a pass is the model's judgement at ≥ 0.7 probability, not a locator assertion.
The model reads the accessibility tree, never pixels, so it judges structure and text. A check about layout,
overlap, clipping or colour goes to a visual judge when one is configured (`QA_VISUAL_JUDGE`), which can pass it
from a screenshot; otherwise it is handed to the calling agent with a full-page screenshot, and the run is finished
once the caller has judged it.

[`skills/browser-check/SKILL.md`](skills/browser-check/SKILL.md) is the full guide: requirements in detail, how to
write steps, read the output, plug in a visual judge and debug a failure.

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

- **Access to the judgment model, TypeSafe's Jev**, through Cloudflare Workers AI or TypeSafe's own API. Put the
  credentials for either in `~/.config/jev/env` (or a file named by `$JEV_ENV_FILE`):

  ```bash
  # Cloudflare Workers AI (model typesafe/jev): an account with Workers AI access and a token that can run it
  export CLOUDFLARE_ACCOUNT_ID=…
  export CLOUDFLARE_API_TOKEN=…
  export CLOUDFLARE_AI_GATEWAY=default   # optional: route through this AI Gateway

  # TypeSafe's API (model jev-latest)
  export TYPESAFE_API_KEY=…

  export JEV_ROUTE=typesafe              # only when both are set: cloudflare or typesafe
  ```

  With `CLOUDFLARE_AI_GATEWAY` set, every Cloudflare call carries `cf-aig-gateway-id`. A gateway on Unified billing
  then pays from its prepaid credit rather than the account's free daily allocation.

- **Playwright 1.59 or newer and a browser, already installed.** The plugin uses yours and never installs or pins
  either: the checkout's or a global `@playwright/test`, and Playwright's own browser build, or for Chromium your
  installed Google Chrome. When one is missing, the run stops with the command that fixes it.
- **The app already served** at the URL the run will hit. The plugin never starts servers or seeds data.

The runner sends the page's accessibility tree and checklist text to the chosen route for the model's decisions.
Codex must be able to execute Playwright locally and reach that API; its sandbox may request
permission for those operations.

## Two ways to start

- `--url https://…` opens any page, anonymously or from a Playwright storage-state file (`--storage-state`).
- `--app NAME` starts from your app's own logged-in e2e fixture. Describe the app once in
  `~/.config/browser-check/apps/`: `NAME.env` sets `E2E_DIR` and `RUN`, and `NAME.spec.ts` gets a logged-in page
  from your fixtures and calls `runChecklist`. SKILL.md documents the format.

For a first `--url` check from a repository checkout, with Playwright installed in
`/path/to/playwright-project` (or globally):

```bash
printf '%s\n' 'Confirm the page shows a "Learn more" link' > /tmp/browser-check-steps.txt
plugins/browser-check/skills/browser-check/run.sh /tmp/browser-check-steps.txt --url https://example.com --worktree /path/to/playwright-project
```

Releases and licence: see the [marketplace README](../../README.md).
