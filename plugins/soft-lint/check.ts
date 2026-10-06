import type { Hunk } from "./diff.ts";
import { classify } from "./classifier.ts";
import type { Model, NoulQuestion, Usage } from "./classifier.ts";
import type { Rule } from "./rules.ts";

export type Finding = {
  path: string;
  line: number;
  rule: Rule;
  score: number;
};

/** The classifier request a hunk cost, and whether AI Gateway answered it from its shared cache. */
export type ClassifierRequest = { usage: Usage | null; gatewayHit: boolean };

export type HunkCheck =
  | { ok: true; findings: Finding[]; request: ClassifierRequest }
  | { ok: false; path: string; reason: string };

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[...truncated]`;

const instructionsFor = (question: string): string =>
  `Judge only the added lines (those starting with "+") of state.hunk, a hunk of the unified diff of state.path; ` +
  `use its other lines only as context. ${question}`;

/** The state and questions of the one request that asks about a hunk. */
export type HunkRequest = {
  state: { path: string; hunk: string };
  questions: Record<string, NoulQuestion>;
};

/**
 * The one request that asks about a hunk: every rule given, keyed by rule id in id order. It depends on nothing but
 * the hunk and the rules, so everyone sharing a gateway sends the same request for the same change.
 */
export function requestInput(
  path: string,
  hunkText: string,
  rules: readonly Rule[],
): HunkRequest {
  const ordered = rules.toSorted((a, b) => (a.id < b.id ? -1 : 1));
  return {
    state: { path, hunk: hunkText },
    questions: Object.fromEntries(
      ordered.map((rule) => [
        rule.id,
        { type: "noul", instructions: instructionsFor(rule.question) },
      ]),
    ),
  };
}

/** One hunk and the rules whose globs match its path; at least one, or there is nothing to ask. */
export type HunkToCheck = { path: string; hunk: Hunk; rules: Rule[] };

type CheckOptions = { model: Model; maxHunkChars: number; timeoutMs: number };

async function ask(
  { path, hunk, rules }: HunkToCheck,
  options: CheckOptions,
): Promise<HunkCheck> {
  const { state, questions } = requestInput(
    path,
    truncate(hunk.text, options.maxHunkChars),
    rules,
  );
  const reply = await classify(
    process.env,
    options.model,
    { state, questions },
    { timeoutMs: options.timeoutMs },
  );
  const findings = rules.flatMap((rule) => {
    const score = reply.answers[rule.id]?.noul;
    return score !== undefined && score >= rule.cutoff
      ? [{ path, line: hunk.firstAddedLine, rule, score }]
      : [];
  });
  return {
    ok: true,
    findings,
    request: { usage: reply.usage, gatewayHit: reply.gatewayHit },
  };
}

/**
 * Asks the classifier every rule about one hunk in a single request. A failure to ask comes back as a reason, not a
 * throw.
 */
export async function checkHunk(
  toCheck: HunkToCheck,
  options: CheckOptions,
): Promise<HunkCheck> {
  try {
    return await ask(toCheck, options);
  } catch (error) {
    /* Not swallowed: the caller reports the reason and fails the run. */
    return {
      ok: false,
      path: toCheck.path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The run's exit code: 2 when any hunk could not be checked, since an incomplete check is no verdict even when other
 * hunks have findings; else 1 for findings and 0 for none.
 */
export function exitCode({ unchecked, findings }: { unchecked: number; findings: number }): 0 | 1 | 2 {
  if (unchecked > 0) {
    return 2;
  }
  return findings > 0 ? 1 : 0;
}
