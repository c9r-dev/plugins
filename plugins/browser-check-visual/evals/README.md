# browser-check-visual evals

`cases.json` holds 45 visual claims (20 true) with a hand label and a one-line reason each, over screenshots in
`images/`: blank and near-empty pages, claims about elements a page does not have, planted defects (overlapping,
clipped and low-contrast text, misaligned fields, a truncated heading) beside their clean twins, wrong colours and
layouts, and true claims on public pages. The screenshots are full-page at CSS scale at 1280 wide, as browser-check
takes them (the long public pages are cut to the viewport). `node evals/score.ts [cases.json] [model ...]` scores them
with the judge's own request, by default on Clef and Clef Flash (Cloudflare credentials in the environment), and
prints the score distributions, the agreement at `PASS_AT` and at the best threshold, and every case on the wrong
side. The 32 claims the original 0.5 pass mark was set on are app screenshots that stay out of this public repo.
