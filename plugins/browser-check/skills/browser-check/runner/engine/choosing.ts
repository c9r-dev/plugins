/*
 * Value imports carry their extension so this module also loads under Node's type stripping, for its tests;
 * Playwright's loader accepts both.
 */
import type { Answers, Candidate, Choice, Finalist, Slice } from "./choice.ts";
import { copiesOf, copyDecisionOf, halvesOf, picksOf, probeOf, refsOf, requestOf, runOffAmong } from "./choice.ts";
import type { ChoiceQuestion, EntryType } from "./classifier.ts";
import { ClassifierError } from "./classifier.ts";
import type { ParsedTree } from "./tree.ts";
import { isCopyOf, lineageOf, withContext } from "./tree.ts";

type Questions = Record<string, ChoiceQuestion<Record<string, EntryType>>>;

/** One request to the classifier: `questions` about the page, with refs in its tree on the `offered` elements only. */
export type Ask = (offered: ReadonlySet<string>, questions: Questions) => Promise<Answers>;

/** Slices asked, possibly split into halves along the way, and their answers. `covers` names the slices first asked. */
type Asked = { covers: string[]; slices: Slice[]; answers: Answers };

/** Jev's answer to a request past its input limit. */
export const isOverflow = (error: unknown) => error instanceof ClassifierError && error.code === "max_tokens_exceeded";

/**
 * A step's way of fitting its requests to the input limit: each is asked with the faithful tree first; when one is
 * past the limit it is asked again compact, and the step stays compact from then on rather than overflow once more on
 * each later request. An overflow in the compact form is the caller's to handle.
 */
export const fittingForm = () => {
  let compact = false;
  return async <Reply>(attempt: (compact: boolean) => Promise<Reply>): Promise<Reply> => {
    const asCompact = compact;
    try {
      return await attempt(asCompact);
    } catch (error) {
      if (asCompact || !isOverflow(error)) {
        throw error;
      }
      compact = true;
      return attempt(true);
    }
  };
};

/**
 * How a step chooses elements on one page tree, every request going through `ask`. The candidates of a choice are
 * asked one slice per request, side by side: a handful of requests, one per 250 candidates. A request past the
 * classifier's input limit is split in halves asked one after the other, since splitting can multiply requests into
 * the hundreds and a burst that size is dropped by the network; whether one candidate fits at all is asked once per
 * tree first, so a page whose tree alone is past the limit fails at once.
 */
export const chooserFor = (ask: Ask, tree: ParsedTree) => {
  let oneCandidateFits: Promise<boolean> | undefined;

  const fitsOneCandidate = (slices: Slice[]) => {
    oneCandidateFits ??= (async () => {
      const { questions, offered } = requestOf(probeOf(slices));
      try {
        await ask(offered, questions);
        return true;
      } catch (error) {
        if (isOverflow(error)) {
          return false;
        }
        throw error;
      }
    })();
    return oneCandidateFits;
  };

  /*
   * Ask `slices` in one request, and `extra` questions beside them. A request past the input limit is asked again as
   * two, the first and then the second half of its candidates, `extra` with the first; halves are split again as
   * needed.
   */
  const askSlices = async (slices: Slice[], extra: Questions = {}): Promise<Asked> => {
    const covers = slices.map(({ name }) => name);
    const { questions, offered } = requestOf(slices);
    try {
      return { covers, slices, answers: await ask(offered, { ...extra, ...questions }) };
    } catch (error) {
      const halves = isOverflow(error) ? halvesOf(slices) : undefined;
      if (halves === undefined) {
        throw error;
      }
      if (!(await fitsOneCandidate(slices))) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`the page is past Jev's input limit even with one candidate on offer: ${reason}`, {
          cause: error,
        });
      }
      const first = await askSlices(halves[0], extra);
      const second = await askSlices(halves[1]);
      return {
        covers,
        slices: [...first.slices, ...second.slices],
        answers: { ...second.answers, ...first.answers },
      };
    }
  };

  /*
   * The element a run-off settles on. Its options are all picks already, so it is never split: halves would pick
   * each of them again. One past the input limit fails the step with the classifier's error.
   */
  const runOff = async (choice: Choice): Promise<Finalist | undefined> => {
    const asked = await Promise.all(
      choice.slices.map(async (slice) => {
        const { questions, offered } = requestOf([slice]);
        return picksOf([slice], await ask(offered, questions));
      }),
    );
    return settle(choice.name, choice.instructions, asked.flat());
  };

  /** One pick stands; more go to a run-off among them, since each was scored only against its own slice. */
  const settle = async (name: string, instructions: string, picks: Finalist[]): Promise<Finalist | undefined> =>
    picks.length > 1 ? runOff(runOffAmong(name, instructions, picks)) : picks[0];

  /* The candidate `choice` settles on. Its slices `first` has not covered are asked one request each, side by side. */
  const candidateFor = async (choice: Choice, first?: Asked): Promise<Finalist | undefined> => {
    const rest = await Promise.all(
      choice.slices
        .filter(({ name }) => !(first?.covers.includes(name) ?? false))
        .map((slice) => askSlices([slice])),
    );
    const finalists = [...(first === undefined ? [] : [first]), ...rest].flatMap(({ slices, answers }) =>
      picksOf(
        slices.filter((slice) => slice.choice === choice.name),
        answers,
      ),
    );
    return settle(choice.name, choice.instructions, finalists);
  };

  /** The copies of `pick` a run-off is to tell apart, each labelled with its place on the page. */
  const placedCopiesOf = (choice: Choice, pick: Candidate) => {
    const lookalikes = copiesOf(choice, (candidate) => isCopyOf(pick, candidate));
    if (lookalikes.length < 2) {
      return [];
    }
    const sameControl = lineageOf(tree, pick.ref);
    const copies = lookalikes.filter(({ ref }) => !sameControl.has(ref));
    return copies.length < 2 ? [] : withContext(tree, copies, refsOf(choice.slices));
  };

  /*
   * The element `choice` settles on. The classifier matches labels literally, so when the pick has copies ("View
   * Code" under every example), those its place on the page tells apart go to a run-off, each labelled with that
   * place, at no more than the pick's own confidence; a pick that reads the same as another copy is refused.
   */
  const decide = async (choice: Choice, first?: Asked): Promise<Finalist | undefined> => {
    const pick = await candidateFor(choice, first);
    if (pick === undefined) {
      return undefined;
    }
    const placed = placedCopiesOf(choice, pick);
    const decision = copyDecisionOf(pick, placed);
    if (decision.kind === "unique") {
      return pick;
    }
    if (decision.kind === "indistinguishable") {
      throw new Error(`${decision.count} elements read as ${pick.label} where it sits on the page`);
    }
    const copy = await runOff(runOffAmong(choice.name, choice.instructions, decision.copies));
    const plain = copiesOf(choice, ({ ref }) => ref === copy?.ref)[0];
    if (copy === undefined || plain === undefined) {
      return undefined;
    }
    /*
     * The run-off says which copy, not whether the pick named the right element: a pick the classifier was unsure of
     * (the parent of the checkbox the step names, at 0.59) came back from a run-off among its own copies at 1.00.
     */
    return { ...plain, confidence: Math.min(copy.confidence, pick.confidence) };
  };

  return { askSlices, decide };
};
