import type { StepResult } from "./runner";

/** A step that decides PASS or FAIL: judged by Jev, with nothing about it flagged. */
export const isDecisive = (step: StepResult) =>
  step.flag === "ok" && step.status !== "unsupported";

/** A visual step the visual judge passed. A judge can never fail a step, so it is counted apart from the decisive ones. */
const isPassedByVisualJudge = (step: StepResult) =>
  step.flag === "visual" && step.status === "passed";

const numbersOf = (steps: StepResult[]) =>
  steps.map((step) => step.number).join(", ");

/*
 * The one line a caller relays. Steps handed to the caller and advisory steps are named apart from the decisive
 * ones, because the run's exit status says nothing about them and they have been misread both ways. A step handed to
 * the caller carries its screenshot's path, so the line alone says which pictures still need judging.
 */
export const verdict = (steps: StepResult[]) => {
  const decisive = steps.filter(isDecisive);
  const failed = decisive.filter((step) => step.status === "failed");
  const forCaller = steps.filter((step) => step.status === "for-caller");
  const judged = steps.filter(isPassedByVisualJudge);
  const advisory = steps.filter(
    (step) =>
      !isDecisive(step) && step.status !== "for-caller" && !isPassedByVisualJudge(step),
  );
  const failures = failed.length > 0 ? ` (failed: ${numbersOf(failed)})` : "";
  const handedOver =
    forCaller.length > 0
      ? `; for you to judge: ${forCaller.map((step) => `${step.number} → ${step.screenshot ?? "no screenshot taken"}`).join(", ")}`
      : "";
  const judgedPasses =
    judged.length > 0 ? `; passed by the visual judge: ${numbersOf(judged)}` : "";
  const advisories =
    advisory.length > 0 ? `; advisory, not decisive: ${numbersOf(advisory)}` : "";
  return `[qa] verdict ${failed.length === 0 ? "PASS" : "FAIL"}: ${decisive.length - failed.length} of ${decisive.length} decisive steps passed${failures}${handedOver}${judgedPasses}${advisories}`;
};
