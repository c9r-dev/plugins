---
name: soft-lint
description: Write, reword or tune a soft-lint rule, the plain-English yes/no question a classifier asks about the lines a diff adds. Use when adding or changing a rule in a .soft-lint.json, or when a rule fires on legitimate code or misses a real case.
---

# Tuning a soft-lint rule

`${CLAUDE_PLUGIN_ROOT}/README.md` covers running soft-lint, its output and exit codes, the rules format and the models.
Run it as `node ${CLAUDE_PLUGIN_ROOT}/cli.ts <rules.json>` with a diff on stdin. If the classifier's credentials are not
set, ask the user; never search for them.

A rule is `{ "id", "question", "cutoff", "files" }`. Work it through this loop until a round changes nothing.

1. **Draft a precise question about the added lines.** Start "Do the added lines …", name the defect with one or two
   concrete examples, and end with when to answer no: "Answer no if the added lines add no catch, or if every such
   catch …". Unchanged context lines are in the hunk too, so a question not anchored to the added lines fires on them.
2. **Plant hits and near-cases in a scratch repo.** In a temporary directory, `git init`, commit a baseline, then add
   several clear hits and some clean code that looks close to a hit but is legitimate. Copy the rules file there with
   only the rule under test.
3. **Run soft-lint** on `git diff -W` for tracked changes, or the README's empty-tree pass for new files. Every planted
   hit should fire and no near-case should. Then run it on a few real branches and a whole-repo pass: real code holds
   legitimate patterns you did not think to plant.
4. **Lower the cutoffs in a scratch copy of the rules file**, to 0.5 or below, and rerun. This surfaces the near
   misses: the hunks the question nearly fires on.
5. **Judge each finding and near miss**, true or false positive. Read the hunk and decide for yourself, not from the
   score.
6. **Reword.** Name each false positive's legitimate case in the question as something not to catch: a `SAFETY:`
   comment justifying a cast is not a restating comment, even though it names the values the code checks, so the
   restating-comment question says so outright. Name each missed shape as an example. Keep the wording about the added
   lines.
7. **Repeat** from step 3. Set the real cutoff above the false positives' scores and below the true ones'; 0.8 is a
   good start.

After a session or two of real use, review the after-edit hook's run log, `${CLAUDE_PLUGIN_DATA}/runs.jsonl`: which
rules fire, at what scores, and on which files. A rule that fires often on code you accept is a rewording candidate,
from step 5; one that never fires may be too narrow, or not needed. Findings per rule:

```bash
jq -r '.findings[].rule' "${CLAUDE_PLUGIN_DATA}/runs.jsonl" | sort | uniq -c | sort -rn
```

Keep one rule to one defect: when a question asks two things, a finding cannot say which one fired.

Through a Cloudflare AI Gateway, a changed question is a new cache key but a changed cutoff is not, so a rerun after
retuning only cutoffs is answered from the cache. The cutoffs are tuned for the rules file's model: moving to another
model family (Jev to Clef) means re-tuning every cutoff, from step 3; the same model through another provider does not.
Re-tune `maxHunkChars` too when you change model: sweep it on the same data and keep the largest size that loses no hit.
