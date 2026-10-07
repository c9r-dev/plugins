/*
 * Replays browser-check's own classifier requests, captured from real `--url` runs and labelled by hand, and reports
 * where each model's scores put the verify and action thresholds.
 *
 *   node evals/score.ts [model ...]
 *
 * Models default to Jev, Clef and Clef Flash on Cloudflare. Credentials are the provider's own variables. Agreement is
 * reported at Jev's measured thresholds and at the best threshold for the model. A request the model refuses (an
 * HTTP 4xx other than a rate limit, such as a request shape it does not accept) is listed with its error and left out
 * of the agreement; a rate limit is retried.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

import { classify, resolveModel } from "../skills/browser-check/runner/engine/classifier.ts";
import type { ChoiceAnswer, Model, NoulAnswer, Questions } from "../skills/browser-check/runner/engine/classifier.ts";
import { thresholdsFor } from "../skills/browser-check/runner/engine/thresholds.ts";

type Sent = { state: unknown; questions: Questions };
type VerifyCase = Sent & { id: string; label: boolean; reason: string };
/** `answer` names the question whose choice is the target; `kind` is the kind the step should get, when asked. */
type ActionCase = Sent & { id: string; answer: string; correct: string; kind: string | null; reason: string };

const load = <T>(name: string): T[] =>
  JSON.parse(gunzipSync(readFileSync(resolve(import.meta.dirname, name))).toString());

const models = process.argv.length > 2
  ? process.argv.slice(2)
  : ["cloudflare:typesafe/jev", "cloudflare:@cf/cloudflare/clef", "cloudflare:@cf/cloudflare/clef-flash"];

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

const JEV = thresholdsFor("cloudflare:typesafe/jev");

type Asked = { answers: Record<string, NoulAnswer | ChoiceAnswer<never>> } | { refused: string };

const ask = async (model: Model, { state, questions }: Sent): Promise<Asked> => {
  try {
    return { answers: (await classifyPatiently(process.env, model, { state, questions })).answers };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/HTTP 4\d\d/.test(message) || message.includes("HTTP 429")) {
      throw error;
    }
    return { refused: message.slice(0, 200) };
  }
};

/* Every distinct score is a candidate threshold; the best is the one the most cases agree with, lowest first. */
const bestThreshold = (scores: number[], agreementAt: (threshold: number) => number) =>
  scores.toSorted((a, b) => a - b).reduce((best, candidate) => (agreementAt(candidate) > agreementAt(best) ? candidate : best), 1);

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

const list = (scores: number[]) => scores.toSorted((a, b) => a - b).map((score) => score.toFixed(2)).join(" ") || "-";

const report = (label: string, scores: number[], agreementAt: (threshold: number) => number, current: number) => {
  const best = bestThreshold(scores, agreementAt);
  console.log(
    `${label}: agreement at ${current.toFixed(2)} ${percent(agreementAt(current))}, best ${best.toFixed(2)} ${percent(agreementAt(best))}`,
  );
};

async function scoreVerify(model: Model, cases: VerifyCase[]) {
  const scored: (VerifyCase & { score: number })[] = [];
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop -- sequential, so the provider's rate limit never fails a case
    const asked = await ask(model, item);
    if ("refused" in asked) {
      console.log(`  refused: ${item.id} ${asked.refused}`);
      continue;
    }
    scored.push({ ...item, score: (asked.answers.holds as NoulAnswer).noul });
  }
  const agreementAt = (threshold: number) =>
    scored.filter(({ score, label }) => score >= threshold === label).length / scored.length;
  console.log(`verify true  ${list(scored.filter((c) => c.label).map((c) => c.score))}`);
  console.log(`verify false ${list(scored.filter((c) => !c.label).map((c) => c.score))}`);
  report(`verify (${scored.length} of ${cases.length})`, scored.map((c) => c.score), agreementAt, JEV.verify);
  for (const wrong of scored.filter(({ score, label }) => score >= JEV.verify !== label)) {
    console.log(`  wrong at ${JEV.verify}: ${wrong.id} ${wrong.label} ${wrong.score.toFixed(2)} (${wrong.reason})`);
  }
}

type ScoredAction = ActionCase & { choice: string; confidence: number; kindChosen: string | undefined };

async function scoreActions(model: Model, cases: ActionCase[]) {
  const scored: ScoredAction[] = [];
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop
    const asked = await ask(model, item);
    if ("refused" in asked) {
      console.log(`  refused: ${item.id} ${asked.refused}`);
      continue;
    }
    const { answers } = asked;
    const target = answers[item.answer] as ChoiceAnswer<never>;
    const kind = answers.kind as ChoiceAnswer<never> | undefined;
    scored.push({ ...item, choice: target.choice as string, confidence: target.confidence, kindChosen: kind?.choice });
  }
  /* The runner acts only on a named candidate at or above the threshold; "none", or anything below it, refuses. */
  const outcomeAt = (threshold: number, { correct, choice, confidence }: ScoredAction) =>
    correct === "none" ? choice === "none" || confidence < threshold : choice === correct && confidence >= threshold;
  const agreementAt = (threshold: number) => scored.filter((c) => outcomeAt(threshold, c)).length / scored.length;
  const named = scored.filter((c) => c.choice !== "none");
  console.log(`action right pick ${list(named.filter((c) => c.choice === c.correct).map((c) => c.confidence))}`);
  console.log(`action wrong pick ${list(named.filter((c) => c.choice !== c.correct).map((c) => c.confidence))}`);
  report(`action (${scored.length} of ${cases.length})`, named.map((c) => c.confidence), agreementAt, JEV.action);
  for (const wrong of scored.filter((c) => !outcomeAt(JEV.action, c))) {
    console.log(`  wrong at ${JEV.action}: ${wrong.id} want ${wrong.correct} got ${wrong.choice} ${wrong.confidence.toFixed(2)} (${wrong.reason})`);
  }
  for (const wrong of scored.filter((c) => c.kind !== null && c.kindChosen !== c.kind)) {
    console.log(`  wrong kind: ${wrong.id} want ${wrong.kind} got ${wrong.kindChosen}`);
  }
}

const verifyCases = load<VerifyCase>("verify.json.gz");
const actionCases = load<ActionCase>("action.json.gz");
for (const name of models) {
  const model = resolveModel(process.env, name, "model");
  console.log(`\n## ${model.name}`);
  // oxlint-disable-next-line no-await-in-loop
  await scoreVerify(model, verifyCases);
  // oxlint-disable-next-line no-await-in-loop
  await scoreActions(model, actionCases);
}
