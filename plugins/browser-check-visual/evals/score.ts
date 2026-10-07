/*
 * Scores labelled visual claims with the judge's own request and reports how well PASS_AT separates them.
 *
 *   node evals/score.ts [cases.json] [model ...]
 *
 * Cases default to evals/cases.json, models to Clef and Clef Flash. Image paths resolve against the cases file's
 * directory. Credentials are the provider's own variables, as for the judge.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { classify, resolveModel } from "../classifier.ts";
import { classificationFor, PASS_AT } from "../judge.ts";

type Case = {
  id: string;
  image: string;
  claim: string;
  claim_number: number;
  checklist: string[];
  label: boolean;
  reason: string;
};

type Scored = Case & { score: number };

const [casesPath = resolve(import.meta.dirname, "cases.json"), ...named] = process.argv.slice(2);
const models = named.length > 0 ? named : ["cloudflare:@cf/cloudflare/clef", "cloudflare:@cf/cloudflare/clef-flash"];
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));

/* AI Gateway answers HTTP 429 when the account's rate limit is hit; wait and ask again rather than lose the case. */
const classifyPatiently: typeof classify = async (env, model, classification) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the previous one to be refused
      return await classify(env, model, classification);
    } catch (error) {
      if (attempt === 5 || !(error instanceof Error) || !error.message.includes("HTTP 429")) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop
      await sleep(2 ** attempt * 1000);
    }
  }
};

const agreementAt = (scored: Scored[], threshold: number) =>
  scored.filter(({ score, label }) => score >= threshold === label).length / scored.length;

/* Every distinct score is a candidate threshold; the best is the one with the highest agreement, lowest first. */
const bestThreshold = (scored: Scored[]) =>
  scored
    .map(({ score }) => score)
    .toSorted((a, b) => a - b)
    .reduce((best, candidate) => (agreementAt(scored, candidate) > agreementAt(scored, best) ? candidate : best), 1);

const summary = (scores: number[]) => {
  const sorted = scores.toSorted((a, b) => a - b);
  const at = (q: number) => (sorted[Math.floor(q * (sorted.length - 1))] ?? Number.NaN).toFixed(2);
  return `min ${at(0)} median ${at(0.5)} max ${at(1)} (n=${sorted.length})`;
};

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

for (const name of models) {
  const model = resolveModel(process.env, name, "model");
  const scored: Scored[] = [];
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop -- sequential, so the provider's rate limit never fails a case
    const { answers } = await classifyPatiently(
      process.env,
      model,
      classificationFor({
        claim: item.claim,
        claimNumber: item.claim_number,
        checklist: item.checklist,
        screenshot: readFileSync(resolve(dirname(casesPath), item.image)),
      }),
    );
    scored.push({ ...item, score: answers.holds.noul });
  }
  const best = bestThreshold(scored);
  console.log(`\n## ${model.name}: ${cases.length} cases`);
  console.log(`true  ${summary(scored.filter((c) => c.label).map((c) => c.score))}`);
  console.log(`false ${summary(scored.filter((c) => !c.label).map((c) => c.score))}`);
  console.log(`agreement at PASS_AT ${PASS_AT}: ${percent(agreementAt(scored, PASS_AT))}`);
  console.log(`best threshold ${best.toFixed(2)}: ${percent(agreementAt(scored, best))}`);
  for (const threshold of new Set([PASS_AT, best])) {
    for (const wrong of scored.filter(({ score, label }) => score >= threshold !== label)) {
      console.log(
        `  wrong at ${threshold.toFixed(2)}: ${wrong.id} ${wrong.label} ${wrong.score.toFixed(2)} ${wrong.claim} (${wrong.reason})`,
      );
    }
  }
  for (const { id, label, score } of scored) {
    console.log(`  ${id} ${label ? "T" : "F"} ${score.toFixed(3)}`);
  }
}
