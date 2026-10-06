import type { StepStatus } from "./runner";

/**
 * Whether a step's evidence (its screenshot and the tree the classifier judged) is written to disk: every step that did not
 * pass, and every step when `everyStep` asks for a record of the whole run.
 */
export const keepsEvidence = (status: StepStatus, everyStep: boolean) =>
  everyStep || status !== "passed";

/** File names of step `number`'s evidence, side by side in the run's output directory. */
export const evidenceFiles = (number: number) => ({
  screenshot: `step-${number}.png`,
  tree: `step-${number}.aria.yml`,
});
