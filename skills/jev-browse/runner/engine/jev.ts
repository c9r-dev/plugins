/*
 * Minimal client for TypeSafe's Jev judgment model, served through Cloudflare Workers AI. Jev answers two question
 * shapes: a yes/no probability ("noul") and a pick-one-label "choice". A request bundles any JSON `state` with a
 * record of named questions; the answers come back keyed by the same names.
 */

/** Any JSON value Jev accepts as instructions or criteria text. */
export type EntryType = string | Record<string, unknown> | unknown[] | null;

export type NoulQuestion = {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
};

/** `criteria` maps each label to its description; Jev allows at most 255 labels. */
export type ChoiceQuestion<T extends Record<string, EntryType>> = {
  type: "choice";
  instructions?: EntryType;
  criteria: T;
};

export type NoulResponse = {
  type: "noul";
  /** Probability of "yes", 0..1. */
  noul: number;
};

export type ChoiceResponse<T> = {
  type: "choice";
  choice: keyof T & string;
  confidence: number;
  probabilities: Record<keyof T, number>;
};

type Question = NoulQuestion | ChoiceQuestion<Record<string, EntryType>>;

type AnswerFor<Qn> =
  Qn extends ChoiceQuestion<infer T>
    ? ChoiceResponse<T>
    : Qn extends NoulQuestion
      ? NoulResponse
      : never;

type Answers<Qs extends Record<string, Question>> = {
  [K in keyof Qs]: AnswerFor<Qs[K]>;
};

export type JevUsage = { input_tokens: number; output_tokens: number };

type RunResult<Qs extends Record<string, Question>> = {
  answers: Answers<Qs>;
  usage: JevUsage;
};

/*
 * The Workers AI v4 envelope double-nests the model output: `result.result` holds the answers, and `result.state`
 * reports the run's lifecycle when the model ran asynchronously.
 */
type Envelope<Qs extends Record<string, Question>> = {
  success?: boolean;
  errors?: unknown[];
  result?: { state?: unknown; result?: RunResult<Qs> };
};

const totals = { calls: 0, input_tokens: 0, output_tokens: 0 };

/** Running totals across every `askJev` call in this process, for the run report. */
export const jevUsage = () => ({ ...totals });

const credentials = () => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      "Jev needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment",
    );
  }
  return { accountId, token };
};

/**
 * Ask Jev one or more questions about `state`. The answer record has the same keys as `questions`, with each
 * answer typed from its question. Throws on a transport, envelope or credential failure.
 */
export const askJev = async <Qs extends Record<string, Question>>(
  state: unknown,
  questions: Qs,
): Promise<RunResult<Qs>> => {
  const { accountId, token } = credentials();
  const started = Date.now();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "typesafe/jev",
        input: { state, questions },
      }),
    },
  );
  const body = (await response.json()) as Envelope<Qs>;
  if (!response.ok || body.success === false) {
    throw new Error(
      `Jev request failed: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`,
    );
  }
  const runState = body.result?.state;
  if (typeof runState === "string" && runState !== "Completed") {
    throw new Error(`Jev run did not complete: state ${runState}`);
  }
  const run = body.result?.result;
  if (!run?.answers) {
    throw new Error(
      `Jev response has no answers: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  totals.calls += 1;
  console.log(
    `[jev] ${Object.keys(questions).join(",")} ${Date.now() - started}ms ${JSON.stringify(state).length}B`,
  );
  totals.input_tokens += run.usage?.input_tokens ?? 0;
  totals.output_tokens += run.usage?.output_tokens ?? 0;
  return run;
};
