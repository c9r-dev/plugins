/*
 * A client for classifiers: models that answer yes/no ("noul") and pick-one-label ("choice") questions about a JSON
 * `state`, such as TypeSafe's Jev and Cloudflare's Clef. Plugins link this file rather than copy it, and it has no
 * imports, so it runs wherever it is linked: under Node's type stripping and under Playwright's loader. A change to it
 * changes every plugin that links it, so each needs a version bump.
 *
 * A request bundles the state, optional images and a record of named questions; the answers come back keyed by the
 * same names, each checked against its question. A model is named with its provider, `<provider>:<model id>`;
 * credentials come from the providers' own environment variables.
 */

export type Env = Partial<Record<string, string>>;

/** Who serves a model: TypeSafe's own API, which serves Jev only, or Cloudflare Workers AI, which serves any. */
export type Provider = "typesafe" | "cloudflare";

/** A model as one provider names it. `name` is the provider-qualified form a user writes: `cloudflare:typesafe/jev`. */
export type Model = { provider: Provider; id: string; name: string };

/** Jev, as each provider names it. */
export const JEV = { typesafe: "typesafe:jev-latest", cloudflare: "cloudflare:typesafe/jev" } as const;

const CREDENTIALS: Record<Provider, readonly string[]> = {
  typesafe: ["TYPESAFE_API_KEY"],
  cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
};

const isProvider = (value: string): value is Provider => Object.hasOwn(CREDENTIALS, value);

const hasCredentials = (env: Env, provider: Provider): boolean => CREDENTIALS[provider].every((name) => env[name]);

/** Parses `<provider>:<model id>`. Throws on an unknown provider, naming the known ones, or on a missing id. */
export function parseModel(name: string): Model {
  const colon = name.indexOf(":");
  const provider = name.slice(0, colon);
  const id = name.slice(colon + 1);
  if (colon === -1 || !isProvider(provider)) {
    throw new Error(
      `model ${name} must start with typesafe: or cloudflare:, as in ${JEV.typesafe} or ${JEV.cloudflare}`,
    );
  }
  if (id === "") {
    throw new Error(`model ${name} names no model id after the provider`);
  }
  return { provider, id, name };
}

/**
 * The model to ask: `name` when given, else Jev through whichever provider has credentials. Throws when the provider
 * lacks credentials (naming its variables), or, with no model named, when both or neither provider has them. `setting`
 * is the tool's own name for its model setting, such as `SOFT_LINT_MODEL`, so the error says what to set.
 */
export function resolveModel(env: Env, name: string | undefined, setting: string): Model {
  if (name !== undefined) {
    const model = parseModel(name);
    if (!hasCredentials(env, model.provider)) {
      throw new Error(`${name} needs ${CREDENTIALS[model.provider].join(" and ")} in the environment`);
    }
    return model;
  }
  const typesafe = hasCredentials(env, "typesafe");
  const cloudflare = hasCredentials(env, "cloudflare");
  if (typesafe && cloudflare) {
    throw new Error(
      `Both TypeSafe and Cloudflare credentials are set, so the classifier model is ambiguous; set ${setting}, ` +
        `such as ${setting}=${JEV.typesafe} or ${setting}=${JEV.cloudflare}`,
    );
  }
  if (typesafe) {
    return parseModel(JEV.typesafe);
  }
  if (cloudflare) {
    return parseModel(JEV.cloudflare);
  }
  throw new Error(
    `${setting} is not set, so the classifier is Jev, which needs TYPESAFE_API_KEY, or CLOUDFLARE_ACCOUNT_ID and ` +
      "CLOUDFLARE_API_TOKEN, in the environment",
  );
}

/** Any JSON value a classifier accepts as instructions or criteria text. */
export type EntryType = string | Record<string, unknown> | unknown[] | null;

export type NoulQuestion = {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
};

/** `criteria` maps each label to its description; Jev allows at most 255 labels. */
export type ChoiceQuestion<Labels extends Record<string, EntryType>> = {
  type: "choice";
  instructions?: EntryType;
  criteria: Labels;
};

export type Question = NoulQuestion | ChoiceQuestion<Record<string, EntryType>>;

export type Questions = Record<string, Question>;

export type NoulAnswer = {
  type: "noul";
  /** Probability of "yes", 0..1. */
  noul: number;
};

export type ChoiceAnswer<Labels> = {
  type: "choice";
  choice: keyof Labels & string;
  confidence: number;
  probabilities: Record<keyof Labels, number>;
};

type AnswerFor<Asked> =
  Asked extends ChoiceQuestion<infer Labels> ? ChoiceAnswer<Labels> : Asked extends NoulQuestion ? NoulAnswer : never;

/** The answers to `Qs`: one per question, each typed from its question. */
export type Answers<Qs extends Questions> = { [Id in keyof Qs]: AnswerFor<Qs[Id]> };

/** What to classify: the state and its images (data URLs), and the questions. */
export type Classification<Qs extends Questions> = { state: unknown; images?: string[]; questions: Qs };

/** Tokens one request consumed, as the provider reports them. */
export type Usage = { input: number; output: number };

/**
 * What one request returned: an answer to every question, its token usage (null when the provider reported none, never
 * zero), and whether AI Gateway served it from its cache.
 */
export type Classified<Qs extends Questions> = { answers: Answers<Qs>; usage: Usage | null; gatewayHit: boolean };

/** The longest time AI Gateway keeps a cached response: one month, in seconds. */
export const GATEWAY_CACHE_TTL_SECONDS = 2_592_000;

export type HttpRequest = { url: string; headers: Headers; body: string };

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The HTTP request for one classification. On Cloudflare with `CLOUDFLARE_AI_GATEWAY` set it goes through that AI
 * Gateway with a cache key hashed from the qualified model name and the exact body: a custom key overrides everything
 * else the gateway would key on, the model in the URL included, so the key must hold the model itself. Anyone asking
 * the same model the same questions through the same gateway gets the cached answer.
 */
export async function requestFor<Qs extends Questions>(
  env: Env,
  model: Model,
  { state, images, questions }: Classification<Qs>,
): Promise<HttpRequest> {
  /* `images` is left out when there are none, so a request without images keeps its body, and so its cache key. */
  const payload = images === undefined ? { state, questions } : { state, questions, images };
  const headers = new Headers({ "Content-Type": "application/json" });
  if (model.provider === "typesafe") {
    headers.set("Authorization", `Bearer ${env.TYPESAFE_API_KEY}`);
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      headers,
      body: JSON.stringify({ model: model.id, ...payload }),
    };
  }
  headers.set("Authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  const gateway = env.CLOUDFLARE_AI_GATEWAY;
  if (!gateway) {
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
      headers,
      body: JSON.stringify({ model: model.id, input: payload }),
    };
  }
  const body = JSON.stringify(payload);
  headers.set("cf-aig-cache-ttl", String(GATEWAY_CACHE_TTL_SECONDS));
  headers.set("cf-aig-cache-key", await sha256Hex(JSON.stringify([model.name, body])));
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${gateway}/workers-ai/run/${model.id}`,
    headers,
    body,
  };
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/**
 * A request the provider failed: its HTTP status, and its own code for the error when the body names one, such as
 * `max_tokens_exceeded` for an input past the model's limit.
 */
export class ClassifierError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `text` as JSON, or undefined when it is not: a provider's error body may be HTML or a bare message. */
const jsonIn = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/*
 * The provider's code in a failure body. TypeSafe answers `{"detail":{"error_type":…}}`; Cloudflare relays that body
 * as text inside one of its `errors` (or `error`) entries' `message`, after a prefix of its own.
 */
const errorCodeOf = (body: unknown): string | undefined => {
  if (!isObject(body)) {
    return undefined;
  }
  if ("detail" in body && isObject(body.detail) && "error_type" in body.detail) {
    return typeof body.detail.error_type === "string" ? body.detail.error_type : undefined;
  }
  const entries = [
    ...("errors" in body && Array.isArray(body.errors) ? body.errors : []),
    ...("error" in body && Array.isArray(body.error) ? body.error : []),
  ];
  for (const entry of entries) {
    const message = isObject(entry) && "message" in entry && typeof entry.message === "string" ? entry.message : "";
    const code = errorCodeOf(jsonIn(message.slice(message.indexOf("{"))));
    if (code !== undefined) {
      return code;
    }
  }
  return undefined;
};

const isProbability = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The object holding `answers` and `usage`. Providers and models wrap it to different depths (the body itself,
 * `result`, or `result.result`), so this follows `result` down to the first object holding `answers`. On the way, any
 * level reporting `success: false` or a run `state` other than `Completed` is an error.
 */
function runObject(text: string, status: number): object {
  let level: unknown = JSON.parse(text);
  while (isObject(level)) {
    if ("success" in level && level.success === false) {
      const errors = "errors" in level ? JSON.stringify(level.errors) : text;
      throw new ClassifierError(`classifier request failed: ${errors.slice(0, 300)}`, status, errorCodeOf(level));
    }
    if ("state" in level && typeof level.state === "string" && level.state !== "Completed") {
      throw new Error(`classifier run did not complete: state ${level.state}`);
    }
    if ("answers" in level) {
      return level;
    }
    level = "result" in level ? level.result : undefined;
  }
  throw new Error(`classifier response has no answers: ${text.slice(0, 300)}`);
}

/** Whether `answer` is a valid answer to `question`: a probability for a noul, one of its labels for a choice. */
function isAnswerTo(question: Question, answer: unknown): boolean {
  if (!isObject(answer) || !("type" in answer) || answer.type !== question.type) {
    return false;
  }
  if (question.type === "noul") {
    return "noul" in answer && isProbability(answer.noul);
  }
  return (
    "choice" in answer &&
    typeof answer.choice === "string" &&
    Object.hasOwn(question.criteria, answer.choice) &&
    "confidence" in answer &&
    isProbability(answer.confidence) &&
    "probabilities" in answer &&
    isObject(answer.probabilities) &&
    Object.values(answer.probabilities).every((probability) => typeof probability === "number")
  );
}

/** The ids of the questions in `questions` that `returned` holds no valid answer to. */
const unanswered = (questions: Questions, returned: Record<string, unknown>): string[] =>
  Object.entries(questions)
    .filter(([id, question]) => !isAnswerTo(question, returned[id]))
    .map(([id]) => id);

const answersEvery = <Qs extends Questions>(
  questions: Qs,
  returned: Record<string, unknown>,
): returned is Answers<Qs> => unanswered(questions, returned).length === 0;

function usageOf(run: object): Usage | null {
  const usage = "usage" in run ? run.usage : undefined;
  if (
    isObject(usage) &&
    "input_tokens" in usage &&
    isTokenCount(usage.input_tokens) &&
    "output_tokens" in usage &&
    isTokenCount(usage.output_tokens)
  ) {
    return { input: usage.input_tokens, output: usage.output_tokens };
  }
  return null;
}

/**
 * The answers and usage in a successful (HTTP 2xx, `status`) response body. Throws when the body reports a failure,
 * as a `ClassifierError`, or when any question has no valid answer, naming those questions.
 */
export function replyFrom<Qs extends Questions>(
  text: string,
  questions: Qs,
  status: number,
): Omit<Classified<Qs>, "gatewayHit"> {
  const run = runObject(text, status);
  const returned: Record<string, unknown> = "answers" in run && isObject(run.answers) ? { ...run.answers } : {};
  if (!answersEvery(questions, returned)) {
    throw new Error(`classifier returned no valid answer for ${unanswered(questions, returned).join(", ")}`);
  }
  return { answers: returned, usage: usageOf(run) };
}

/** HTTP statuses that a moment's wait may clear: rate limiting, and a gateway or upstream briefly unavailable. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const MAX_ATTEMPTS = 5;

const FIRST_BACKOFF_MS = 1000;

const attempts = (count: number): string => (count === 1 ? "1 attempt" : `${count} attempts`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before attempt `attempt + 1`: the response's `Retry-After` when it has a usable one (seconds, or an
 * HTTP date), else an exponential backoff from one second, jittered between half and all of it so concurrent callers
 * spread out.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && /^\d+$/u.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  const date = retryAfter === undefined ? Number.NaN : Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  const backoff = FIRST_BACKOFF_MS * 2 ** (attempt - 1);
  return backoff * (0.5 + Math.random() / 2);
}

/**
 * Asks `model`, as `resolveModel` gave it, every question in `classification` in one request. A rate limit (HTTP 429)
 * or an unavailable gateway (502, 503, 504) is retried, up to five attempts in all, while the wait fits the one
 * `timeoutMs` budget all attempts share. Throws, with a message fit to show a user, when the request fails or the
 * budget runs out (an HTTP error carries the provider's own message, such as a model it does not serve), or when any
 * answer is missing or invalid.
 */
export async function classify<Qs extends Questions>(
  env: Env,
  model: Model,
  classification: Classification<Qs>,
  options: { timeoutMs?: number } = {},
): Promise<Classified<Qs>> {
  const request = await requestFor(env, model, classification);
  const { timeoutMs } = options;
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  const signal = timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs);
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal });
      text = await response.text();
    } catch (error) {
      /* The timeout signal aborts the body read as well as the connection, so both surface here. */
      throw error instanceof Error && error.name === "TimeoutError"
        ? new Error(`${model.name} did not answer within ${timeoutMs}ms (${attempts(attempt)})`)
        : error;
    }
    if (response.ok) {
      return {
        ...replyFrom(text, classification.questions, response.status),
        gatewayHit: response.headers.get("cf-aig-cache-status") === "HIT",
      };
    }
    const failure = new ClassifierError(
      `${model.name} request failed after ${attempts(attempt)}: HTTP ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      errorCodeOf(jsonIn(text)),
    );
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      throw failure;
    }
    const delay = retryDelayMs(response, attempt);
    if (Date.now() + delay >= deadline) {
      throw failure;
    }
    await sleep(delay);
  }
}
