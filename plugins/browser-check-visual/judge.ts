/*
 * A browser-check visual judge (see QA_VISUAL_JUDGE in browser-check's SKILL.md): asks a vision classifier whether the
 * full-page screenshot satisfies the claim. It passes the step at a yes-probability of PASS_AT or more and hands it back
 * otherwise; any failure throws, which browser-check reports and hands back.
 *
 * BROWSER_CHECK_VISUAL_MODEL names the model, provider-qualified (default cloudflare:@cf/cloudflare/clef). Credentials
 * are the provider's own variables, such as CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
 */
import { classify, resolveModel } from "./classifier.ts";
import type { Classification, Questions } from "./classifier.ts";

const DEFAULT_MODEL = "cloudflare:@cf/cloudflare/clef";

/*
 * No threshold separates Clef's scores cleanly. On 77 labelled claims (evals/cases.json's 45, plus 32 private app
 * screenshots kept outside the repo) it agrees with the label on 92.2% at 0.5, and no threshold beats 93.5%: true
 * claims score 0.68 or more bar one, but a claim that something does not go wrong in an element the page does not
 * show ("no text in the navigation overlaps" with no navigation) scores up to 0.92. A claim that states the element is
 * shown ("the page shows a navigation, and no text in it overlaps") scores 0.14 or less on those pages.
 */
export const PASS_AT = 0.5;

/* The runner's own verify question, word for word, so the judge answers what browser-check asks of every check. */
const QUESTIONS = {
  holds: {
    type: "noul",
    instructions: "Does the current page satisfy this QA claim? Judge only what the snapshot shows.",
    criteria: {
      true: "Every part of the claim is supported by the snapshot, or describes a transient state (loading, a brief spinner) that has resolved into what the snapshot shows",
      false: "Some part of the claim is contradicted or not shown",
    },
  },
} satisfies Questions;

export type JudgeInput = { claim: string; claimNumber: number; checklist: string[]; screenshot: Uint8Array };

/** The request the judge sends for one claim, shared with the evals so they measure exactly this. */
export const classificationFor = ({
  claim,
  claimNumber,
  checklist,
  screenshot,
}: JudgeInput): Classification<typeof QUESTIONS> => ({
  state: { claim, claim_number: claimNumber, checklist },
  images: [`data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`],
  questions: QUESTIONS,
});

export default async function judge(input: JudgeInput): Promise<{
  status: "passed" | "for-caller";
  detail: string;
}> {
  /*
   * The model is always named, defaulting to Clef, so resolveModel's Jev default (a text model) never applies here;
   * it still parses the name and checks the provider's credentials, the one path every tool takes.
   */
  const model = resolveModel(
    process.env,
    process.env.BROWSER_CHECK_VISUAL_MODEL || DEFAULT_MODEL,
    "BROWSER_CHECK_VISUAL_MODEL",
  );
  const { answers } = await classify(process.env, model, classificationFor(input));
  const score = answers.holds.noul;
  const detail = `${model.name} score ${score.toFixed(2)}`;
  return score >= PASS_AT ? { status: "passed", detail } : { status: "for-caller", detail };
}
