/*
 * usage: node check-model.ts
 * Prints the model browser-check will ask, or, when it cannot ask one (no credentials, an ambiguous choice, or a model
 * whose thresholds have not been measured), prints why on stderr and exits 2. run.sh calls it before Playwright starts,
 * so that refusal is one line rather than a test failure; the runner makes the same check again.
 */
import { resolveModel } from "./engine/classifier.ts";
import { thresholdsFor } from "./engine/thresholds.ts";

try {
  const model = resolveModel(process.env, process.env.BROWSER_CHECK_MODEL, "BROWSER_CHECK_MODEL");
  thresholdsFor(model.name);
  console.log(model.name);
} catch (error) {
  console.error(`browser-check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
