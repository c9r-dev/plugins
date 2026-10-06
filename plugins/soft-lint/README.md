# soft-lint

Asks a classifier, TypeSafe's Jev by default, plain-English yes/no questions about the lines a diff adds, and reports
each "yes" that reaches the question's cutoff. It catches what a syntax rule cannot: a comment that restates the code, a
`getX` that writes, a swallowed error, logic in a Vue template.

It judges only what a change adds, never the code already there, so a new rule applies forward without a backfill.

## Install

As a Claude Code plugin, which adds the after-edit hook and a skill for writing and tuning rules:

```text
/plugin marketplace add c9r-dev/plugins
/plugin install soft-lint@c9r
```

As an npm package, which gives a project the `soft-lint` CLI. It needs Node 24 or newer and has no runtime
dependencies:

```bash
yarn add -D @c9r-dev/soft-lint
```

### Releasing

The plugin and the package share one version: `version` in `.claude-plugin/plugin.json`. Bump it in the pull request
that should ship. When that lands on `main`, the `release` workflow creates the GitHub release `soft-lint-v<version>`,
then stamps that version into `package.json` (whose own `version` is a `0.0.0` placeholder), runs the typecheck and
tests, builds `dist/` and publishes to npm through trusted publishing, with provenance. The plugin and its hook run the
TypeScript sources directly and need no build.

## Run it

The CLI reads a unified diff on stdin and takes the rules file as its one argument:

```bash
git diff -W origin/main...HEAD | soft-lint rules.json
```

It never calls git or reads the working tree, so the caller chooses what to judge. `-W` (the whole enclosing function
as context) is the recommended diff. Paths must carry git's default `b/` prefix, so do not pass `--no-prefix`.

Output is one line per finding: path, rule id, score, cutoff and question. The line number is the hunk's first added
line, not the offending line, and several rules can fire on one hunk:

```text
src/cart.ts:1:1: [hidden-write] 0.97 >= 0.80: Do the added lines make a function whose name promises ...
```

Scores vary by a few hundredths between runs, so a score just above or below its cutoff can flip on a rerun.

The exit code says whether the check is complete:

- **0**: every hunk checked, no findings.
- **1**: every hunk checked, findings.
- **2**: no verdict. soft-lint could not run (a bad rules file, a malformed diff, no model it can ask), or could not
  check some hunk (offline, a timeout, an HTTP error). Findings from the hunks it did check are still printed.

An incomplete check is never a pass. A local hook that should not block you when offline tolerates exit 2 explicitly,
for example in a pre-push hook:

```bash
git diff -W origin/main...HEAD | soft-lint .soft-lint.json || [ $? -eq 2 ]
```

CI should not tolerate it: there, exit 2 means the change went unchecked.

The last stderr line counts files, requests (with the model asked), gateway hits and findings, with the tokens the
provider reports. Token totals cover the requests the gateway did not answer from its cache; tokens reported on gateway
hits are totalled apart, because whether Cloudflare bills a hit is unverified.

### The whole repo

To ask every rule about every file, diff against the empty tree:

```bash
git diff -W $(git hash-object -t tree /dev/null) HEAD | soft-lint rules.json
```

Each file is then one hunk, so one request per file, and a file longer than `maxHunkChars` is truncated: the question
sees only its start. Use it to measure a rule against a codebase, not as a routine check.

## Rules

A rules file holds the questions:

```json
{
  "model": "typesafe:jev-latest",
  "timeoutMs": 30000,
  "maxHunkChars": 4000,
  "rules": [
    {
      "id": "swallowed-error",
      "question": "Do the added lines catch an error and then let it vanish ...? Answer no if ...",
      "cutoff": 0.8,
      "files": ["**/*.ts"]
    }
  ]
}
```

- `files` globs match the new-side path with Node's `path.matchesGlob`. A rule applies when any glob matches.
- `question` is asked about each hunk. Phrase it about "the added lines", and say when to answer no, so unchanged
  context and legitimate code do not fire.
- `cutoff` is the yes-probability, from 0 to 1, at which an answer is a finding.
- `model` is the repo's classifier, named with its provider (below). The cutoffs in a rules file are tuned for its
  model, so moving to another model family (Jev to Clef) means re-tuning them; moving the same model to another
  provider (Jev on TypeSafe to Jev on Cloudflare) does not.
- `model`, `timeoutMs` and `maxHunkChars` are optional, with the defaults above, except that a missing `model`
  falls to the default described below. A hunk longer than `maxHunkChars` is truncated.
- The file is checked on load. An unknown key, a cutoff outside 0 to 1, a rule without globs or a repeated id stops the
  run.

[`rules.json`](rules.json) is a starting set for TypeScript and Vue, with cutoffs tuned on Jev. The plugin's skill
covers how to write and tune a question.

Each hunk with at least one matching rule is one request asking every rule whose globs match its path, keyed by rule
id in id order. The request depends only on the hunk and the rules, so everyone sends the same request for the same
change. Adding a rule adds tokens, not requests: with Jev, a hunk asked four rules is about 800 input tokens. At most
8 requests run at once. soft-lint writes no files.

## Models and credentials

A model is named `<provider>:<model id>`:

| Model                                  | What it is                                         |
| -------------------------------------- | -------------------------------------------------- |
| `typesafe:jev-latest`                  | TypeSafe's Jev, through TypeSafe's own API         |
| `cloudflare:typesafe/jev`              | the same Jev, through Cloudflare Workers AI        |
| `cloudflare:@cf/cloudflare/clef`       | Cloudflare's Clef                                  |
| `cloudflare:@cf/cloudflare/clef-flash` | Cloudflare's Clef Flash                            |

TypeSafe serves Jev; a model it does not serve fails with its own error. Each provider reads its credentials from its
own environment variables, and nothing else:

| Provider     | Variables                                                                         |
| ------------ | --------------------------------------------------------------------------------- |
| `typesafe`   | `TYPESAFE_API_KEY`                                                                |
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`; optional `CLOUDFLARE_AI_GATEWAY` |

Export them however you keep secrets: a shell profile, direnv, a password manager's CLI. The after-edit hook sees the
environment Claude Code was started with.

soft-lint asks the model `SOFT_LINT_MODEL` names, else the rules file's `model`. With neither, it asks Jev through
whichever provider has credentials; when both have, it stops and asks you to set `SOFT_LINT_MODEL`, and when neither
has, it names the variables to set. For example, to run soft-lint on Jev through TypeSafe while browser-check uses Clef
through Cloudflare, with both providers' credentials exported:

```bash
export SOFT_LINT_MODEL=typesafe:jev-latest
export BROWSER_CHECK_MODEL=cloudflare:@cf/cloudflare/clef
```

browser-check refuses Clef until its thresholds have been measured on Clef; see its README.

When the classifier cannot be asked about a hunk (timeout, HTTP error, invalid answer), soft-lint prints each distinct
reason once on stderr and exits 2.

## Cache

The only cache is Cloudflare AI Gateway's, for a `cloudflare:` model with `CLOUDFLARE_AI_GATEWAY` set. Requests then go
to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/run/<model id>`, each carrying
`cf-aig-cache-key`, a hash of the qualified model name and the exact request body, and `cf-aig-cache-ttl` of one month
(2,592,000 seconds, the gateway's documented maximum). Without a gateway, requests go straight to Workers AI's
`/ai/run`, and nothing is cached.

Anyone who asks about the same hunk with the same questions through the same gateway within the month gets the cached
answer, so a rerun on an unchanged branch is all gateway hits. A changed model, question, hunk or path is a new key; a
cutoff is not part of it. The token is not part of the key either, so teammates share answers by naming the same
gateway, each with their own token that has access to it. A cache write lands a few seconds after the response, so an
immediate repeat can still miss. TypeSafe caches nothing.

## After-edit hook

The plugin runs soft-lint after every `Edit`, `Write` and `MultiEdit` in a git repo that has a `.soft-lint.json` (a
rules file) at its root, and does nothing in any other repo. It diffs the edited file against the index
(`git diff -W -- <file>`, or against `/dev/null` for an untracked file), so it judges everything uncommitted in that
file, not only the last edit.

The hook runs in the background (`"async": true`), so it never delays an edit. Its findings reach the agent as
context on its next model request, marked advisory: a classifier's opinion, to act on where the agent agrees. No
findings means no message. When soft-lint cannot run, the hook writes one line to stderr, which lands in Claude Code's
debug log, and the edit is unaffected.

## Why a diff

- **Rules apply forward.** A question judges the lines a change adds, so old code is never backfilled. Asking about
  every function in a repo is slow and paid, and mostly noise.
- **Whole files, not script blocks.** A hunk carries everything the change touched, a Vue `<template>` included,
  which a linter's JavaScript plugin often never sees.
