/*
 * Minimal client for TypeSafe's Jev judgment model, through Cloudflare Workers AI or TypeSafe's own API. Jev answers
 * two question shapes: a yes/no probability ("noul") and a pick-one-label "choice". A request bundles any JSON `state`
 * with a record of named questions; the answers come back keyed by the same names.
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

export type RouteName = "cloudflare" | "typesafe";

type Env = Record<string, string | undefined>;

/**
 * Where Jev calls go: Cloudflare Workers AI when its credentials are set, TypeSafe's own API when its key is. With
 * both, `JEV_ROUTE` decides, since either could be the one meant.
 */
export const chooseRoute = (env: Env): RouteName => {
  const configured: RouteName[] = [];
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    configured.push("cloudflare");
  }
  if (env.TYPESAFE_API_KEY) {
    configured.push("typesafe");
  }
  const chosen = env.JEV_ROUTE;
  if (chosen) {
    if (chosen !== "cloudflare" && chosen !== "typesafe") {
      throw new Error(`JEV_ROUTE must be cloudflare or typesafe, not ${chosen}`);
    }
    if (!configured.includes(chosen)) {
      throw new Error(
        chosen === "cloudflare"
          ? "JEV_ROUTE=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
          : "JEV_ROUTE=typesafe needs TYPESAFE_API_KEY",
      );
    }
    return chosen;
  }
  if (configured.length === 2) {
    throw new Error(
      "Both Cloudflare and TypeSafe credentials are set; set JEV_ROUTE=cloudflare or JEV_ROUTE=typesafe",
    );
  }
  if (configured.length === 0) {
    throw new Error(
      "Jev needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or TYPESAFE_API_KEY, in the environment",
    );
  }
  return configured[0]!;
};

type Request = { url: string; headers: Record<string, string>; body: unknown };

const requestFor = (route: RouteName, env: Env, input: { state: unknown; questions: unknown }): Request => {
  if (route === "typesafe") {
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
      body: { model: "jev-latest", ...input },
    };
  }
  /* Names the AI Gateway to route through, so a gateway on Unified billing pays from its credit. */
  const gateway = env.CLOUDFLARE_AI_GATEWAY;
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(gateway ? { "cf-aig-gateway-id": gateway } : {}),
    },
    body: { model: "typesafe/jev", input },
  };
};

/** The answers and usage from a route's response body; throws when the call failed or carries no answers. */
const runFrom = <Qs extends Record<string, Question>>(
  route: RouteName,
  response: Response,
  body: unknown,
): RunResult<Qs> => {
  if (route === "typesafe") {
    const run = body as Partial<RunResult<Qs>>;
    if (!response.ok || !run.answers) {
      throw new Error(`Jev request failed: HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return run as RunResult<Qs>;
  }
  const envelope = body as Envelope<Qs>;
  if (!response.ok || envelope.success === false) {
    throw new Error(
      `Jev request failed: ${JSON.stringify(envelope.errors ?? envelope).slice(0, 300)}`,
    );
  }
  const runState = envelope.result?.state;
  if (typeof runState === "string" && runState !== "Completed") {
    throw new Error(`Jev run did not complete: state ${runState}`);
  }
  const run = envelope.result?.result;
  if (!run?.answers) {
    throw new Error(
      `Jev response has no answers: ${JSON.stringify(envelope).slice(0, 300)}`,
    );
  }
  return run;
};

/**
 * Ask Jev one or more questions about `state`. The answer record has the same keys as `questions`, with each
 * answer typed from its question. Throws on a transport, response or credential failure.
 */
export const askJev = async <Qs extends Record<string, Question>>(
  state: unknown,
  questions: Qs,
): Promise<RunResult<Qs>> => {
  const env = process.env;
  const route = chooseRoute(env);
  const request = requestFor(route, env, { state, questions });
  const started = Date.now();
  const response = await fetch(request.url, {
    method: "POST",
    headers: { ...request.headers, "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
  });
  const run = runFrom<Qs>(route, response, await response.json());
  totals.calls += 1;
  console.log(
    `[jev] ${Object.keys(questions).join(",")} ${Date.now() - started}ms ${JSON.stringify(state).length}B`,
  );
  totals.input_tokens += run.usage?.input_tokens ?? 0;
  totals.output_tokens += run.usage?.output_tokens ?? 0;
  return run;
};
