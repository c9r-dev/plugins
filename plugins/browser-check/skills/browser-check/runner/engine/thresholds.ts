/** The scores below which browser-check refuses an action's target or fails a verify. */
export type Thresholds = {
  /** Below this confidence the chosen element is a guess, not the one the step names. */
  action: number;
  /** A verify passes when the model puts at least this probability on the claim holding. */
  verify: number;
};

/*
 * Measured on Jev: right targets score 0.89–1.00, while wrong ones ("External Contacts" for "Contacts", "Close" for
 * "Write Retrospective") score 0.38–0.53 and used to pass, surfacing as a failure several steps later. Both providers
 * serve the same Jev, so both of its names share the values.
 */
const JEV: Thresholds = { action: 0.7, verify: 0.7 };

/*
 * Clef and Clef Flash stay refused (measured with evals/ at the plugin root: 43 verifies, 34 actions). Both reject a
 * choice question with one label (HTTP 422), which the runner sends whenever a page has no candidate of a kind, so
 * half the actions never get an answer; and on the rest Clef rates right targets 0.53-0.70 and a wrong one 0.94.
 */

/** Thresholds by provider-qualified model, for the models they were measured on. */
const MEASURED: Record<string, Thresholds> = {
  "typesafe:jev-latest": JEV,
  "cloudflare:typesafe/jev": JEV,
};

/**
 * The thresholds measured for `model`. Throws for any other model: another model scores differently, so reusing
 * Jev's numbers would pass and fail steps on a scale they were never set for.
 */
export function thresholdsFor(model: string): Thresholds {
  const measured = Object.hasOwn(MEASURED, model) ? MEASURED[model] : undefined;
  if (measured === undefined) {
    throw new Error(
      `browser-check's thresholds have not been measured for ${model} yet; set BROWSER_CHECK_MODEL to one that has ` +
        `them: ${Object.keys(MEASURED).join(", ")}`,
    );
  }
  return measured;
}
