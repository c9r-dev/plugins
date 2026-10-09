/*
 * Value imports carry their extension so this module also loads under Node's type stripping, for its tests;
 * Playwright's loader accepts both.
 */
import type { Node } from "./tree.ts";
import { countsOf } from "./tree.ts";

/*
 * A choice is scored only against the other options, so without a way out the classifier picks the least-bad element
 * even when the step names one the page does not have ("Sign up" clicked "Learn more" at 0.88).
 */
export const NONE = "none";

/** Jev accepts at most 255 labels in one choice question, `none` among them. */
const MAX_CANDIDATES = 250;

export type Candidate = Pick<Node, "ref" | "label" | "name">;

/**
 * One choice question: some of a choice's candidates, under the name it is asked by. Its way out is `none`, the
 * option that no element matches, or nothing for a run-off. The classifier has the tree in the state, so a label
 * needs no row context.
 */
export type Slice = {
  choice: string;
  name: string;
  instructions: string;
  candidates: Candidate[];
  wayOut: "none" | "run-off";
};

/**
 * One element choice. Its candidates are asked as consecutive slices of at most `MAX_CANDIDATES`, named
 * `<name><index>`, so a page with more candidates than one question takes keeps every one on offer.
 */
export type Choice = {
  name: string;
  instructions: string;
  slices: Slice[];
};

const NO_MATCH = "No element on the page is the one the step names";

const slicedAmong = (
  name: string,
  instructions: string,
  candidates: Candidate[],
  wayOut: Slice["wayOut"],
): Choice => {
  const slices: Slice[] = [];
  for (let start = 0; start < candidates.length; start += MAX_CANDIDATES) {
    const inSlice = candidates.slice(start, start + MAX_CANDIDATES);
    slices.push({ choice: name, name: `${name}${slices.length}`, instructions, candidates: inSlice, wayOut });
  }
  return { name, instructions, slices };
};

export const choiceAmong = (name: string, instructions: string, candidates: Candidate[]): Choice =>
  slicedAmong(name, instructions, candidates, "none");

/**
 * A run-off among elements questions have already named. It offers no way out: each option was picked, so "no
 * element" would only throw away an element the step was found to name.
 */
export const runOffAmong = (name: string, instructions: string, picks: Candidate[]): Choice =>
  slicedAmong(name, instructions, picks, "run-off");

/** The ref of every candidate `slices` offer. */
export const refsOf = (slices: Slice[]) =>
  new Set(slices.flatMap(({ candidates }) => candidates.map(({ ref }) => ref)));

/** The questions `slices` ask in one request, and the refs they offer: the only refs that request's tree needs. */
export const requestOf = (slices: Slice[]) => ({
  questions: Object.fromEntries(
    slices.map(({ name, instructions, candidates, wayOut }) => [
      name,
      {
        type: "choice" as const,
        instructions,
        criteria: {
          ...Object.fromEntries(candidates.map(({ ref, label }) => [ref, label])),
          ...(wayOut === "none" ? { [NONE]: NO_MATCH } : {}),
        },
      },
    ]),
  ),
  offered: refsOf(slices),
});

/**
 * The two requests to ask instead of one that was past the classifier's input limit: the first and the second half
 * of its candidates, taken across its slices in order. Each half asks its share of a slice under the slice's name
 * suffixed `a` or `b`, so the questions of both halves keep distinct names. Undefined when the request offers fewer
 * than two candidates, since then the tree alone is past the limit.
 */
export const halvesOf = (slices: Slice[]): [Slice[], Slice[]] | undefined => {
  const total = slices.reduce((sum, { candidates }) => sum + candidates.length, 0);
  if (total < 2) {
    return undefined;
  }
  const middle = Math.ceil(total / 2);
  const first: Slice[] = [];
  const second: Slice[] = [];
  let start = 0;
  for (const slice of slices) {
    const { candidates, name } = slice;
    const cut = Math.min(Math.max(middle - start, 0), candidates.length);
    if (cut > 0) {
      first.push({ ...slice, name: `${name}a`, candidates: candidates.slice(0, cut) });
    }
    if (cut < candidates.length) {
      second.push({ ...slice, name: `${name}b`, candidates: candidates.slice(cut) });
    }
    start += candidates.length;
  }
  return [first, second];
};

/**
 * A question of one candidate, the first of `slices`, with its slice's way out: whether a request this small fits
 * says whether the tree alone is past the classifier's input limit.
 */
export const probeOf = (slices: Slice[]): Slice[] =>
  slices
    .slice(0, 1)
    .map((slice) => ({ ...slice, name: `${slice.name}probe`, candidates: slice.candidates.slice(0, 1) }));

/** The candidates of `choice`, across all its slices, that `isCopy` takes for copies of one element. */
export const copiesOf = ({ slices }: Choice, isCopy: (candidate: Candidate) => boolean): Candidate[] =>
  slices.flatMap(({ candidates }) => candidates.filter(isCopy));

/**
 * What the copies of `pick`, each labelled with its place on the page, allow:
 * - `indistinguishable`: no decision, when another copy reads the same as the pick;
 * - `run-off` among the copies whose labels no other copy shares, the pick among them;
 * - `unique`: keep the pick, when no other copy is set apart from it.
 */
export const copyDecisionOf = (
  pick: Candidate,
  labelled: Candidate[],
):
  | { kind: "unique" }
  | { kind: "run-off"; copies: Candidate[] }
  | { kind: "indistinguishable"; count: number } => {
  const counts = countsOf(labelled.map(({ label }) => label));
  const own = labelled.find(({ ref }) => ref === pick.ref);
  if (own === undefined) {
    return { kind: "unique" };
  }
  const ownCount = counts.get(own.label) ?? 0;
  if (ownCount > 1) {
    return { kind: "indistinguishable", count: ownCount };
  }
  const copies = labelled.filter(({ label }) => counts.get(label) === 1);
  return copies.length < 2 ? { kind: "unique" } : { kind: "run-off", copies };
};

export type Finalist = Candidate & { confidence: number };

/** The classifier's answers to choice questions, by question name. */
export type Answers = Partial<Record<string, { choice: string; confidence: number }>>;

/**
 * The element each slice chose, in slice order. A slice is scored only against its own candidates, so when more
 * than one names an element the step's element is still to be chosen among these finalists.
 */
export const picksOf = (slices: Slice[], answers: Answers): Finalist[] =>
  slices.flatMap(({ name, candidates }) => {
    const answer = answers[name];
    const candidate = candidates.find(({ ref }) => ref === answer?.choice);
    return answer === undefined || candidate === undefined ? [] : [{ ...candidate, confidence: answer.confidence }];
  });
