---
name: jev-browse
description: Run a natural-language browser QA checklist against a served web app with Playwright and Jev on Cloudflare Workers AI. Use after a user-visible change when browser QA is appropriate, for a PR's QA steps, or to compare two builds. Start from a URL or an app's logged-in e2e fixture. Trigger words include qa check, check the flow, verify the steps, and run the QA steps.
---

# jev-browse

Executes a checklist written as plain English, one step per line. Each step is an action (click, type, open a
URL) or a check ("Confirm …"). Jev picks the element to act on from the page's accessibility tree and judges each
check against the settled page. Measured on a 24-step flow: ~35 s and ~$0.01, against 6.5 minutes driving a
browser by hand.

It is a QA aid, not a merge gate: a pass is Jev's judgement at ≥ 0.7 probability, not a locator assertion.

**Jev judges structure and text; you judge looks.** Jev reads the accessibility tree, never pixels: which elements
exist and their roles, labels, text, values and states. How something looks or where it sits (layout, overlap,
clipping or overflowing text, colour, spacing, an icon's appearance) is not in the tree, and clipped text is still
there, so a tree cannot decide a clipped-text check. Preflight flags such a check `visual`; the runner does not ask
Jev, but saves a full-page `step-N.png` and hands the step to you, the caller, to judge from that picture. A visual
check is a normal, supported step. Write it whenever looks are what you need to confirm.

jev-browse drives a live page. To judge image files that already exist, such as screenshots from another run or
a design mock, you need no jev-browse: read them directly.

The runner sends the accessibility tree and checklist text to Cloudflare Workers AI for Jev decisions.

## The skill runs steps. The caller owns the target.

Before calling it, the caller has already made sure that:

- the app is served at the URL the run will hit, from the code under test;
- the backend and its seed data are what the steps assume;
- any session the steps need exists (see the two ways to start below).

The skill checks none of that. A run against the wrong build passes or fails on that build.

Its one dependency of its own: a file exporting `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for an account
with Workers AI access, at `$JEV_ENV_FILE` or `~/.config/jev/env`. If it is missing, ask the user; never search
for credentials.

## Two ways to start

**`--url <URL>`** — starts from any page with no fixtures: a local server, a preview, a site outside the repo.
Anonymous unless `--storage-state <file>` names a Playwright storage-state file the caller prepared
(`context.storageState({ path })` after logging in). Runs under a standalone Playwright config.

**`--app NAME`** — starts from an app's own e2e fixture, as defined by a manifest in
`${XDG_CONFIG_HOME:-~/.config}/jev-browse/apps/`: `NAME.env` + `NAME.spec.ts`. The `.env` is a shell fragment
setting `E2E_DIR` (the app's e2e directory, relative to the worktree) and `RUN` (the command that runs `qa.spec.ts`
under the app's Playwright config; it may be wrapped in whatever the machine needs, such as a lock). The spec
exports one Playwright test that obtains a logged-in `Page` from the app's fixtures and calls
`runChecklist(page, testInfo)` from `./qa/engine/checklist`, asserting the returned array is empty. The run
inherits whatever the fixture provides: session, database isolation, mock clock, the app config's projects.
Without a manifest for `NAME` the script exits 2 and names the path it looked for. A `README.md` beside the
manifests is the place for anything a caller must know about those apps.

```bash
<skill-dir>/run.sh <steps-file> --url https://… [--storage-state FILE] [--worktree DIR] [--project NAME] [--viewport WxH] [--output DIR] [--headed] [--trace] [--video] [--screenshots]
<skill-dir>/run.sh <steps-file> --app NAME [--worktree DIR] [--project NAME] [--output DIR] [--headed] [--trace] [--screenshots]
```

- `<skill-dir>` is this skill's base directory, shown when the skill loads.
- `--worktree` defaults to the current directory; pass an absolute path when the run's working directory differs
  from the Playwright checkout, including delegated runs. Both modes need a checkout with Playwright and its
  browsers installed, even when the URL is outside the repo.
- Run in the foreground with a command session that permits 10 minutes; the spec's own cap is 10 minutes.
  Delegate the run when an available subagent can handle it, otherwise run it directly.
- **Browser and size**: `--project` takes `Desktop-Chromium` (the default), `Desktop-Firefox`, `Desktop-Webkit`,
  `Mobile-Chromium`, `Mobile-Webkit-iPad` or `Mobile-Webkit-iPhone`; in `--app` mode these must be project names
  the app's own config defines. In `--url` mode `--viewport 400x900` overrides the device's viewport to check one
  breakpoint.
- **Headless by default**; `--headed` shows the browser. Anything after `--` goes to Playwright.
- The runner source lives in `runner/` beside this file and is copied into the worktree on every run; edit the
  skill's copy. `--app` copies the engine to `<E2E_DIR>/qa/` and the spec to `<E2E_DIR>/qa.spec.ts`; `--url`
  copies everything to `<worktree>/.jev-browse/`. The copies are removed when the run ends; add them to the
  repo's `.git/info/exclude` to keep them out of `git status` while it runs.
- Artifacts go to `<output>/<date>-<time>-<pid>/`, where `--output` defaults to `$TMPDIR/jev-browse`: outside the
  worktree, so a test run that clears `test-results` cannot delete them.

## Writing steps

One step per line; a leading `N.` is fine. A step may name several actions ("select the Menu button, then
select Edit"; "replace the Description with "…" then press Save"): after the first, Jev keeps choosing the next
element until it judges the step done.

Jev judges; it never generates. So:

- **Quote anything to be typed**: `Type "Payments were frozen" into the Notes editor`. Typing selects the
  field's contents first, so "replace the text with …" and "type into the empty field" are the same step.
- **A form can be one step or one step per field.** A step's quoted values are consumed in the order it names
  them: `Fill in the form with the Title "A", the Description "B" and the Success Criteria "C"` fills three
  fields, Jev choosing each. One field per line is more precise and reads better in a PR; the compound form is
  there because QA sections are written that way.
- **Spell out any URL or path, or say where the page shows it**: `Open /items/qqqqqqqqqqqqqqqqqqqq in the browser
  address bar`, or `Open the URL shown in the Link field` for a link the app generates. For the second, Jev picks
  the element holding the URL (a link, a field, a line of text) and the runner opens its value exactly as the DOM
  has it. "Replace the id in the URL with …" cannot be executed; it is flagged `derived`.
- **Check end states, not moments**: "renders the form with Description filled in", not "shows a brief
  loading state, then …". A check runs once the page has settled; a moment that has passed is flagged
  `transient` and scores near the threshold.
- A check may refer to other steps ("the text saved in step 6"); the whole checklist is in view for checks.
- Describe elements the way a screen reader would: the button's label, the row's title, the field's label or
  placeholder. Targets come from the accessibility tree.
- **Check state as state, looks as looks**: when a state is in the tree, say so ("the theme toggle is pressed",
  "its label reads Dark mode") and Jev decides it. When the point is how it looks ("the moon icon replaces the
  sun", "the long title is not cut off"), write that; the step is handed to you with a full-page screenshot.

## Reading the result

Live lines while it runs, then a table and a Jev usage line:

```
[qa] preflight 16 transient: Confirm the Edit Exercise modal shows a brief loading state, then …
[qa] 4 passed click 597ms settle=8ms a=1 c=1.00 Select the Write Retrospective button | button "Write Retrospective"
[qa] 15 passed click 1198ms settle=92ms a=2 c=0.99 On the … row select the Menu … | button "Menu (more links)" → button "Edit Exercise"
[qa] 16 passed (advisory: transient) verify … a=1 c=0.77 …
```

- **a=** is how many elements the step's wording says to act on, counted in preflight; the step does exactly that
  many, so it never carries on into the next step's work. A step's quoted values are a floor under the count.
- **preflight** lines list steps Jev cannot decide from the settled tree (`transient`, `derived`, `visual`,
  `external`). A `visual` check is not sent to Jev: it reports `for-caller` with no `c=`, and its full-page
  `step-N.png` is for you to judge. The other flags still run, as **advisory**: shown, never decisive; rewrite
  them per the rules above. An advisory `c=` is not a finding: two builds scoring 0.44 and 0.45 say nothing about
  which is right.
- **c=** is element-choice confidence for an action, yes-probability for a check. Both fail below 0.70. A low
  check score is a confident "no", not uncertainty. A check in the 0.5–0.7 band usually means part of the claim
  is about something the page does not show; reread the wording before blaming the app.
- **An action is refused before it runs** when Jev finds no element the step names (`no element on the page
  matches the step`), when its target scores below 0.70 (`uncertain target`), or when the target has no
  accessible name (`with no accessible name`): wrong picks score 0.38–0.53, and an unnamed field can score 1.00
  for the wrong field. Nothing is clicked, so later steps fail on the unchanged page rather than a wrong one. An
  unnamed control is an accessibility bug in the app: name it there, or seed around it. A control whose role takes
  its name from content, such as a button wrapping a paragraph, is named by that text.
- **settle=** is time waiting after the step: the network, any visible loading indicator, and then a quarter
  second with no DOM mutation, which is what stops the next step reading a page that has not re-rendered. So
  roughly 260 ms is the floor; a step still loading after 8 s fails. Seconds on a Save deserve a glance.
- A failed action names what was clicked and why. Later steps keep running, so read the first failure first; the
  rest may be consequences.
- The last live line, `[qa] artifacts in <dir>`, names the run's output directory. It always holds
  `qa-report.json` (every step with kind, status, detail, confidence, elapsed and settle time, and `screenshot`,
  the absolute path of its `step-N.png` when it has one) and a `step-N.png` for each step that did not pass.
- The very last line is the verdict, e.g. `[qa] verdict FAIL: 8 of 9 decisive steps passed (failed: 4); for you
  to judge: 5 → /abs/…/step-5.png; advisory, not decisive: 2, 7`. PASS or FAIL counts decisive steps only, and
  matches the exit status; it says nothing about the steps listed for you to judge.

**The run is not finished until you have judged every step the verdict lists for you.** Open each screenshot it
names (read the image), judge that step's claim against it, and give a pass or fail with what you saw. A subagent
running the skill does this itself, since it can read images too; it never passes the paths up unjudged.

Report to the user: the verdict line word for word, your judgement of each step listed for you to judge, each
failed step with its detail, and what the screenshots of the advisory steps show. Not the whole table. If
delegated, have the subagent relay the verdict line verbatim along with its judgements.

## Debugging a failure

Start with the failed step's `step-N.png` (inspect it with an image viewer) and the `qa-report.json` detail. When
that is not enough, rerun with recording on:

- `--screenshots` — a `step-N.png` after every step, so the page state before the failing one is on disk too.
- `--trace` — a Playwright trace (`qa-trace.zip`: DOM snapshot, screenshot and network for every action). Both
  modes. For a person: `node_modules/.bin/playwright show-trace <zip>`. For an agent: unzip it; `trace.trace`
  is newline-delimited JSON with every action and the console and network events, and `resources/` holds the
  screenshots.
- `--video` — `video.webm` of the whole run. `--url` mode only, because video is chosen when the browser context
  is created and the app fixtures create their own. For a person to watch; an agent gets more from the trace.

All of it lands in the same output directory.

## Known limits

- Probabilistic. Across many runs of one 24-step list, a loosely worded check scored 0.69–0.78 around the 0.70
  threshold; expect an occasional advisory-band result on such steps.
- One project per run. Several browsers or sizes means several runs, one `--project` each.
- A step's action count comes from its wording, so a step whose words hide an action ("submit the form" where
  the button also needs a confirmation) does the first and leaves the rest; the next step usually picks it up,
  and the `detail` chain shows what was done.
- Step count is bounded only by the 10-minute timeout (~1.5 s per step).
- The cost line is an estimate at TypeSafe's direct rate; Cloudflare bills Workers AI on its own tariff.
- `--app` covers only the apps with a manifest; use `--url` otherwise.
- Jev reads the whole page tree on every step (an open dialog's tree when one is open), never a cut-down one, so an
  element late in the DOM such as a drawer tab is still in view. Measured: about 25k input tokens worked and about
  50k failed with `max_tokens_exceeded`; a typical app page is about 5k. A page past the limit fails that step
  with Jev's error.
- Elements hidden from the accessibility tree cannot be targeted, such as a date picker whose input is
  `aria-hidden`. Seed that data instead of filling it.
