// A browser-check visual judge (see QA_VISUAL_JUDGE in browser-check's SKILL.md): asks a vision judgment model on
// Cloudflare Workers AI whether the full-page screenshot satisfies the claim. It passes the step at a yes-probability
// of PASS_AT or more and hands it back otherwise; any failure throws, which browser-check reports and hands back.
//
// Settings, from the environment:
//   BROWSER_CHECK_VISUAL_ACCOUNT_ID  Cloudflare account with Workers AI access (required)
//   BROWSER_CHECK_VISUAL_API_TOKEN   API token that can run Workers AI models (required)
//   BROWSER_CHECK_VISUAL_AI_GATEWAY  AI Gateway id, sent as cf-aig-gateway-id; a gateway on Unified billing pays from
//                                    its credit instead of the free daily allocation (optional)
//   BROWSER_CHECK_VISUAL_MODEL       Workers AI model (default @cf/cloudflare/clef)

const DEFAULT_MODEL = "@cf/cloudflare/clef";

/*
 * Measured on 32 labelled visual claims with Clef and the screenshot alone: 96.9% agreement at 0.5, and every false
 * claim scored 0.12 or less, so 0.5 passes true claims without passing false ones.
 */
const PASS_AT = 0.5;

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
};

function setting(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name} for the browser-check-visual judge`);
  }
  return value;
}

export default async function judge({ claim, claimNumber, checklist, screenshot }) {
  const account = setting("BROWSER_CHECK_VISUAL_ACCOUNT_ID");
  const token = setting("BROWSER_CHECK_VISUAL_API_TOKEN");
  const gateway = process.env.BROWSER_CHECK_VISUAL_AI_GATEWAY;
  const model = process.env.BROWSER_CHECK_VISUAL_MODEL || DEFAULT_MODEL;

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(gateway ? { "cf-aig-gateway-id": gateway } : {}),
    },
    body: JSON.stringify({
      model,
      input: {
        state: { claim, claim_number: claimNumber, checklist },
        questions: QUESTIONS,
        images: [`data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`],
      },
    }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${model}: HTTP ${response.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  const score = body.result?.answers?.holds?.noul;
  if (!response.ok || body.success === false || typeof score !== "number") {
    throw new Error(`${model}: HTTP ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  const detail = `${model} score ${score.toFixed(2)}`;
  return score >= PASS_AT ? { status: "passed", detail } : { status: "for-caller", detail };
}
