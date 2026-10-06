# browser-check-visual

A visual judge for [browser-check](../browser-check/README.md). browser-check's own model reads the accessibility
tree, never pixels, so it hands every check about looks (layout, overlap, clipping, colour, icons) back to the
calling agent with a screenshot. With this plugin installed, a vision classifier looks at that screenshot first:
it passes the steps it is confident hold, and hands the rest back with its score. It can never fail a step.

On 32 visual claims labelled by hand, Clef with the screenshot alone agreed with the label on 96.9% at the 0.5
threshold, and never passed a false claim: every false claim scored 0.12 or less. browser-check's text model,
judging the same claims from the accessibility tree, agreed on 42%.

## Install

Claude Code:

```text
/plugin marketplace add c9r-dev/plugins
/plugin install browser-check-visual@c9r
```

A SessionStart hook exports `QA_VISUAL_JUDGE` (the setting browser-check reads) pointing at this version's
`judge.ts`, so nothing else needs configuring once the credentials below are set. A `QA_VISUAL_JUDGE` already in
your environment wins.

Codex: install it with `codex plugin add browser-check-visual@c9r`, then set `QA_VISUAL_JUDGE` yourself to the
absolute path of the installed `judge.ts`.

## Settings

It reads the classifier provider's own credentials from the environment, the same ones browser-check uses. Export them
however you keep secrets:

```bash
export CLOUDFLARE_ACCOUNT_ID=…   # a Cloudflare account with Workers AI access
export CLOUDFLARE_API_TOKEN=…    # a token that can run Workers AI models
export CLOUDFLARE_AI_GATEWAY=…   # optional, an AI Gateway id
export BROWSER_CHECK_VISUAL_MODEL=…   # optional, default cloudflare:@cf/cloudflare/clef
```

`BROWSER_CHECK_VISUAL_MODEL` names a vision model with its provider, `<provider>:<model id>`, such as
`cloudflare:@cf/cloudflare/clef-flash`. The 0.5 pass mark was measured on Clef. It needs Cloudflare even when
browser-check asks Jev through TypeSafe's API, since the vision models run on Workers AI.

Set the gateway for regular use. Without one, calls draw on Workers AI's free daily allocation of 10,000 neurons and
fail once it runs out; through a gateway on Unified billing they are paid from its credit. With a gateway, each answer
is also cached for a month, so an unchanged screenshot of an unchanged claim is answered from the cache. A failed call
is never a failed step: browser-check hands the step back with the error.

## What it sends and decides

Each visual step sends the claim, the checklist and a full-page screenshot at CSS scale to Cloudflare Workers AI,
with the same yes/no question browser-check asks of every check. A score of 0.5 or more passes the step; below
that the step is handed back with the score.

A page about 1440×900 costs about a thousand image tokens. A very long page can exceed the model's 64k context, which
fails the call (HTTP 413) and hands the step back.
