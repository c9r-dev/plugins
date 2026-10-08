import { matchesGlob } from "node:path";

import { parseModel } from "./classifier.ts";

/** One plain-English yes/no question about the added lines of a hunk. "Yes" at or above `cutoff` is a finding. */
export type Rule = {
  id: string;
  question: string;
  cutoff: number;
  /** Globs matched against the diff's new-side path; the rule applies to a file that matches any of them. */
  files: string[];
};

export type RulesFile = {
  /**
   * The repo's classifier, provider-qualified (`typesafe:jev-latest`); undefined leaves the choice to the shared
   * default. The cutoffs are tuned to it.
   */
  model: string | undefined;
  timeoutMs: number;
  maxHunkChars: number;
  rules: Rule[];
};

const DEFAULTS = {
  timeoutMs: 30_000,
  /*
   * Tuned on Jev (cloudflare:typesafe/jev) on 2026-10-07 with a 15-rule set for a Vue and TypeScript codebase, at
   * 1000, 2000, 4000, 8000, 16000, 32000 and 64000. Data: 29 planted hits and 36 clean cases, 3 real feature branches,
   * 7 repro cases for one template rule, and 20 plants at the start, middle and end of 34k and 49k character files. No size
   * judged measurably better: the few findings that came and went between sizes moved a few hundredths around their
   * cutoff, in both directions, which is the classifier's run-to-run noise. 4000 sends the median hunk (1-3k) whole and
   * needs fewer requests than smaller windows, each of which repeats every matching rule's question. Jev rejects a
   * request over about 101k characters.
   */
  maxHunkChars: 4000,
} satisfies Omit<RulesFile, "model" | "rules">;

function fail(message: string): never {
  throw new Error(`soft-lint rules: ${message}`);
}

/* A rules file and a rule as JSON delivers them: every field present or not, and of any type, until checked. */
type RawRulesFile = {
  readonly model?: unknown;
  readonly timeoutMs?: unknown;
  readonly maxHunkChars?: unknown;
  readonly rules?: unknown;
};

type RawRule = {
  readonly id?: unknown;
  readonly question?: unknown;
  readonly cutoff?: unknown;
  readonly files?: unknown;
};

/* Any non-array object fits both raw shapes, whose fields are all optional and unknown. */
const isRawObject = (value: unknown): value is RawRulesFile & RawRule =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1;

function rejectUnknownKeys(
  keys: readonly string[],
  allowed: readonly string[],
  where: string,
): void {
  for (const key of keys) {
    if (!allowed.includes(key)) {
      fail(`${where} has an unknown key "${key}"`);
    }
  }
}

function parseRule(raw: RawRule, where: string): Rule {
  rejectUnknownKeys(
    Object.keys(raw),
    ["id", "question", "cutoff", "files"],
    where,
  );
  const { files } = raw;
  if (!isNonEmptyString(raw.id)) {
    fail(`${where}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.question)) {
    fail(`${where}.question must be a non-empty string`);
  }
  if (!isProbability(raw.cutoff)) {
    fail(`${where}.cutoff must be a number from 0 to 1`);
  }
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(isNonEmptyString)
  ) {
    fail(`${where}.files must be a non-empty array of glob strings`);
  }
  return { id: raw.id, question: raw.question, cutoff: raw.cutoff, files };
}

/** Parses and checks a rules file's JSON. Throws, naming the offending field, on anything it does not accept. */
export function parseRules(text: string): RulesFile {
  const raw: unknown = JSON.parse(text);
  if (!isRawObject(raw)) {
    fail("the file must hold a JSON object");
  }
  rejectUnknownKeys(
    Object.keys(raw),
    ["model", "timeoutMs", "maxHunkChars", "rules"],
    "the file",
  );
  const {
    model,
    timeoutMs = DEFAULTS.timeoutMs,
    maxHunkChars = DEFAULTS.maxHunkChars,
    rules: entries,
  } = raw;
  if (model !== undefined) {
    if (!isNonEmptyString(model)) {
      fail("model must be a non-empty string");
    }
    parseModel(model);
  }
  if (!isPositiveInteger(timeoutMs)) {
    fail("timeoutMs must be a positive integer");
  }
  if (!isPositiveInteger(maxHunkChars)) {
    fail("maxHunkChars must be a positive integer");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("rules must be a non-empty array");
  }
  const rules = entries.map((entry, index) => {
    const where = `rules[${index}]`;
    if (!isRawObject(entry)) {
      fail(`${where} must be an object`);
    }
    return parseRule(entry, where);
  });
  const ids = new Set<string>();
  for (const { id } of rules) {
    if (ids.has(id)) {
      fail(`rule id "${id}" is used more than once`);
    }
    ids.add(id);
  }
  return { model, timeoutMs, maxHunkChars, rules };
}

/** The rules with a `files` glob that matches `path`. */
export const rulesFor = (rules: readonly Rule[], path: string): Rule[] =>
  rules.filter(({ files }) => files.some((glob) => matchesGlob(path, glob)));

/**
 * The model to ask: `SOFT_LINT_MODEL` when set, else the rules file's `model`, else undefined for the shared default.
 */
export const modelFor = (env: Partial<Record<string, string>>, { model }: RulesFile): string | undefined =>
  env.SOFT_LINT_MODEL || model;
