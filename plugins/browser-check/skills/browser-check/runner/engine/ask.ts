/*
 * The runner's one way to ask the classifier: the shared client with this process's credentials and model, plus a
 * log line per call and running token totals for the run report.
 */
import { classify, resolveModel } from "./classifier";
import type { Classified, Model, Questions } from "./classifier";

/** The model browser-check asks: `BROWSER_CHECK_MODEL`, else the shared default (Jev, on whichever provider is set). */
export const classifierModel = (): Model =>
  resolveModel(process.env, process.env.BROWSER_CHECK_MODEL, "BROWSER_CHECK_MODEL");

const totals = { calls: 0, input_tokens: 0, output_tokens: 0 };

/** Running totals across every `askClassifier` call in this process, for the run report. */
export const classifierUsage = () => ({ ...totals });

/**
 * Ask the classifier one or more questions about `state`. The answer record has the same keys as `questions`, with
 * each answer typed from its question. Throws on a transport, response or credential failure, or a missing or invalid
 * answer.
 */
export const askClassifier = async <Qs extends Questions>(state: unknown, questions: Qs): Promise<Classified<Qs>> => {
  const model = classifierModel();
  const started = Date.now();
  const reply = await classify(process.env, model, { state, questions });
  totals.calls += 1;
  totals.input_tokens += reply.usage?.input ?? 0;
  totals.output_tokens += reply.usage?.output ?? 0;
  const cache = reply.gatewayHit ? " gateway-hit" : "";
  console.log(
    `[classifier ${model.name}] ${Object.keys(questions).join(",")} ${Date.now() - started}ms ` +
      `${JSON.stringify(state).length}B${cache}`,
  );
  return reply;
};
