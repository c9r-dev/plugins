import type { Node } from "./tree";

/*
 * A choice is scored only against the other options, so without a way out the classifier picks the least-bad element
 * even when the step names one the page does not have ("Sign up" clicked "Learn more" at 0.88).
 */
export const NONE = "none";

/** Jev accepts at most 255 labels in one choice question, `none` among them. */
const MAX_CANDIDATES = 250;

type Candidate = Pick<Node, "ref" | "label">;

/**
 * One element choice. Its candidates are asked as consecutive slices of at most `MAX_CANDIDATES`, one question per
 * slice named `<name><index>`, so a page with more candidates than one question takes keeps every one on offer.
 * Each slice maps refs to labels, plus the option that no element matches. The classifier has the tree in the state,
 * so a label needs no row context.
 */
export type Choice = {
  name: string;
  instructions: string;
  slices: Record<string, string>[];
};

export const choiceAmong = (name: string, instructions: string, candidates: Candidate[]): Choice => {
  const slices: Record<string, string>[] = [];
  for (let start = 0; start < candidates.length; start += MAX_CANDIDATES) {
    slices.push({
      ...Object.fromEntries(
        candidates.slice(start, start + MAX_CANDIDATES).map(({ ref, label }) => [ref, label]),
      ),
      [NONE]: "No element on the page is the one the step names",
    });
  }
  return { name, instructions, slices };
};

export const questionsFor = ({ name, instructions, slices }: Choice) =>
  Object.fromEntries(
    slices.map((criteria, index) => [`${name}${index}`, { type: "choice" as const, instructions, criteria }]),
  );

/** Every ref the choices offer: the only refs an answer can name, so the only ones the tree sent needs. */
export const offeredRefs = (choices: Choice[]) =>
  new Set(choices.flatMap(({ slices }) => slices.flatMap((criteria) => Object.keys(criteria))));

export type Finalist = Candidate & { confidence: number };

type Answer = { choice: string; confidence: number };

/**
 * The element each slice chose, in slice order. A slice is scored only against its own candidates, so when more
 * than one names an element the step's element is still to be chosen among these finalists.
 */
export const finalistsOf = (
  { name, slices }: Choice,
  answers: Partial<Record<string, Answer>>,
): Finalist[] =>
  slices.flatMap((criteria, index) => {
    const answer = answers[`${name}${index}`];
    if (answer === undefined || answer.choice === NONE) {
      return [];
    }
    const label = criteria[answer.choice];
    return label === undefined ? [] : [{ ref: answer.choice, label, confidence: answer.confidence }];
  });
