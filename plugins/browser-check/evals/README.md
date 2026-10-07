# browser-check evals

`verify.json.gz` (43 verify requests, 23 true) and `action.json.gz` (34 element choices, 8 whose right answer is
`none`) are classifier requests browser-check sent during `--url` runs on info.cern.ch, example.com, Wikipedia,
playwright.dev and Hacker News, captured verbatim and labelled by hand against the page tree each one carries, with a
one-line reason per case. `node evals/score.ts [model ...]` replays them (Cloudflare credentials in the environment,
`CLOUDFLARE_AI_GATEWAY` to cache repeats) and prints each model's score distributions, its agreement at Jev's
thresholds and at its best threshold, and every case on the wrong side. The requests carry the question wording of
the runner that sent them; after changing that wording, recapture by appending each `askClassifier` call's state,
questions and answers to a file in a scratch copy of the runner, run checklists against public pages, and relabel.
