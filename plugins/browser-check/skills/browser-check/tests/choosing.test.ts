import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NONE, choiceAmong } from "../runner/engine/choice.ts";
import type { Ask } from "../runner/engine/choosing.ts";
import { chooserFor, fittingForm } from "../runner/engine/choosing.ts";
import { ClassifierError } from "../runner/engine/classifier.ts";
import { nodesOf, parseTree } from "../runner/engine/tree.ts";

const TREE = parseTree(
  Array.from({ length: 600 }, (_, index) => `- checkbox "Option ${index + 1}" [ref=e${index + 1}]`).join("\n"),
);

/** The first `count` checkboxes of `TREE`: e1, e2, … */
const checkboxes = (count: number) => nodesOf(TREE).slice(0, count);

/** Jev's answer to a request past its input limit. */
const overflow = () =>
  new ClassifierError(
    'jev request failed after 1 attempt: HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
    400,
    "max_tokens_exceeded",
  );

type Call = { names: string[]; offered: number; wayOut: boolean };

/**
 * A classifier that refuses, as Jev does a request past its input limit, any request offering more than `limit`
 * elements or that `overflows` names. A question offering `target` picks it; one with the way out picks that; a
 * run-off, which has none, picks its first option.
 */
const fakeClassifier = ({
  limit,
  target,
  overflows = () => false,
}: {
  limit: number;
  target: string;
  overflows?: (call: Call) => boolean;
}) => {
  const calls: Call[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const ask: Ask = async (offered, questions) => {
    const call = {
      names: Object.keys(questions),
      offered: offered.size,
      wayOut: Object.values(questions).some(({ criteria }) => NONE in criteria),
    };
    calls.push(call);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (offered.size > limit || overflows(call)) {
      throw overflow();
    }
    return Object.fromEntries(
      Object.entries(questions).map(([name, { criteria }]) => {
        const [first = NONE] = Object.keys(criteria);
        const choice = target in criteria ? target : NONE in criteria ? NONE : first;
        return [name, { choice, confidence: 0.9 }];
      }),
    );
  };
  return { ask, calls, mostInFlight: () => mostInFlight };
};

const click = (count: number) => choiceAmong("click", "Which?", checkboxes(count));

const isProbe = ({ names }: Call) => names.some((name) => name.endsWith("probe"));

describe("chooserFor", () => {
  it("finds an element in the second half of a split request", async () => {
    const { ask } = fakeClassifier({ limit: 60, target: "e90" });
    assert.equal((await chooserFor(ask, TREE).decide(click(100)))?.ref, "e90");
  });

  it("asks whether one candidate fits once per tree, however often requests split", async () => {
    const { ask, calls } = fakeClassifier({ limit: 10, target: "e90" });
    const chooser = chooserFor(ask, TREE);
    await chooser.decide(click(100));
    await chooser.decide(click(100));
    assert.equal(calls.filter(isProbe).length, 1);
  });

  it("fails at once when one candidate does not fit beside the tree", async () => {
    const { ask, calls } = fakeClassifier({ limit: 0, target: "e90" });
    await assert.rejects(
      chooserFor(ask, TREE).decide(click(100)),
      /past Jev's input limit even with one candidate/,
    );
    assert.equal(calls.length, 2);
  });

  it("asks split halves one after the other", async () => {
    const { ask, mostInFlight } = fakeClassifier({ limit: 10, target: "e90" });
    await chooserFor(ask, TREE).decide(click(100));
    assert.equal(mostInFlight(), 1);
  });

  it("asks extra questions with the first half only, and merges both halves' answers", async () => {
    const { ask } = fakeClassifier({ limit: 60, target: "e90" });
    const kind = { type: "choice" as const, instructions: "What kind?", criteria: { click: "Click" } };
    const { answers } = await chooserFor(ask, TREE).askSlices(click(100).slices, { kind });
    assert.deepEqual(
      [answers.kind?.choice, answers.click0a?.choice, answers.click0b?.choice],
      ["click", NONE, "e90"],
    );
  });

  it("fails a run-off past the limit rather than split it", async () => {
    /* Each of two slices names an element; the run-off between them, which offers no way out, overflows. */
    const { ask, calls } = fakeClassifier({ limit: 250, target: "e300", overflows: ({ wayOut }) => !wayOut });
    const firstPicks: Ask = async (offered, questions) => {
      const answers = await ask(offered, questions);
      return { ...answers, click0: { choice: "e1", confidence: 0.9 } };
    };
    await assert.rejects(chooserFor(firstPicks, TREE).decide(click(300)), /max_tokens_exceeded/);
    assert.equal(calls.length, 3);
  });

  it("offers a run-off no way out, so it settles on one of the picks", async () => {
    const { ask, calls } = fakeClassifier({ limit: 300, target: "e300" });
    const firstPicks: Ask = async (offered, questions) => {
      const answers = await ask(offered, questions);
      const isFirstSlice = NONE in (questions.click0?.criteria ?? {});
      return isFirstSlice ? { ...answers, click0: { choice: "e1", confidence: 0.9 } } : answers;
    };
    const pick = await chooserFor(firstPicks, TREE).decide(click(300));
    assert.deepEqual([pick?.ref, calls.at(-1)?.wayOut], ["e300", false]);
  });
});

describe("chooserFor copy run-off", () => {
  const tree = parseTree(
    [
      '- heading "Tree with line" [level=3]',
      '- treeitem "plus-square parent 1-2" [ref=e1]:',
      '  - generic "parent 1-2" [ref=e2]',
      '- heading "Custom icons" [level=3]',
      '- treeitem "down parent 1-2" [ref=e3]:',
      '  - generic "parent 1-2" [ref=e4]',
    ].join("\n"),
  );
  const candidates = nodesOf(tree);

  it("asks again among copies whose names hold one another, and keeps the chosen copy's own label", async () => {
    const asked: string[][] = [];
    const ask: Ask = async (_offered, questions) => {
      asked.push(Object.values(questions).flatMap(({ criteria }) => Object.values(criteria).map(String)));
      return Object.fromEntries(
        Object.entries(questions).map(([name, { criteria }]) => {
          const first = NONE in criteria ? "e3" : (Object.keys(criteria).find((ref) => ref === "e2") ?? NONE);
          return [name, { choice: first, confidence: 0.9 }];
        }),
      );
    };
    const pick = await chooserFor(ask, tree).decide(choiceAmong("click", "Which?", candidates));
    assert.deepEqual(
      [pick?.ref, pick?.label, asked.at(-1)?.every((label) => label.includes(" — "))],
      ["e2", 'generic "parent 1-2"', true],
    );
  });
});

describe("chooserFor copies", () => {
  it("asks no run-off between a control and its own wrapper", async () => {
    const tree = parseTree(
      ['- heading "Demo" [level=2]', '- generic "Option 3" [ref=e1]:', '  - checkbox "Option 3" [ref=e2]'].join("\n"),
    );
    const candidates = nodesOf(tree);
    let requests = 0;
    const ask: Ask = async (_offered, questions) => {
      requests += 1;
      return Object.fromEntries(Object.keys(questions).map((name) => [name, { choice: "e2", confidence: 0.9 }]));
    };
    const pick = await chooserFor(ask, tree).decide(choiceAmong("click", "Which?", candidates));
    assert.deepEqual([pick?.ref, requests], ["e2", 1]);
  });
});

describe("chooserFor copy decisions", () => {
  const answering =
    (pickRef: string, pickConfidence: number, copyRef: string): Ask =>
    async (_offered, questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([name, { criteria }]) =>
          NONE in criteria
            ? [name, { choice: pickRef, confidence: pickConfidence }]
            : [name, { choice: copyRef, confidence: 1 }],
        ),
      );

  it("refuses when another copy reads the same as the pick in its place", async () => {
    const tree = parseTree(
      ['- heading "Edit" [level=1]', '- button "Remove" [ref=e1]', '- button "Remove" [ref=e2]'].join("\n"),
    );
    const candidates = nodesOf(tree);
    await assert.rejects(
      chooserFor(answering("e1", 0.9, "e1"), tree).decide(choiceAmong("click", "Which?", candidates)),
      /2 elements read as button "Remove"/,
    );
  });

  const sections = parseTree(
    [
      '- heading "Install" [level=2]',
      '- button "Copy" [ref=e1]',
      '- heading "Usage" [level=2]',
      '- button "Copy" [ref=e2]',
      '- heading "Notes" [level=2]',
      '- button "Copy" [ref=e3]',
      '- button "Copy" [ref=e4]',
    ].join("\n"),
  );
  const copies = choiceAmong("click", "Which?", nodesOf(sections));

  it("settles which copy, at the first pick's confidence when the run-off is surer", async () => {
    const pick = await chooserFor(answering("e1", 0.95, "e2"), sections).decide(copies);
    assert.deepEqual([pick?.ref, pick?.confidence], ["e2", 0.95]);
  });

  it("leaves an unsure first pick unsure, however sure the run-off among its copies", async () => {
    const pick = await chooserFor(answering("e1", 0.59, "e2"), sections).decide(copies);
    assert.ok((pick?.confidence ?? 1) < 0.7);
  });

  it("leaves out of the run-off the copies that read the same as each other", async () => {
    const offered: string[][] = [];
    const ask: Ask = async (refs, questions) => {
      offered.push([...refs]);
      return answering("e1", 0.9, "e2")(refs, questions);
    };
    await chooserFor(ask, sections).decide(copies);
    assert.deepEqual(offered.at(-1), ["e1", "e2"]);
  });
});

describe("fittingForm", () => {
  /** A request that fits when its size is within `limit`, the faithful form counting twice the compact one. */
  const sized = (size: number, limit: number, forms: boolean[]) => async (compact: boolean) => {
    forms.push(compact);
    if ((compact ? size : size * 2) > limit) {
      throw overflow();
    }
    return compact;
  };

  it("asks with the faithful tree while it fits", async () => {
    const forms: boolean[] = [];
    await fittingForm()(sized(10, 30, forms));
    assert.deepEqual(forms, [false]);
  });

  it("asks the same request again compact when the faithful tree overflows, and stays compact", async () => {
    const forms: boolean[] = [];
    const inFittingForm = fittingForm();
    await inFittingForm(sized(10, 15, forms));
    await inFittingForm(sized(1, 15, forms));
    assert.deepEqual(forms, [false, true, true]);
  });

  it("leaves an overflow of the compact tree to the caller", async () => {
    await assert.rejects(fittingForm()(sized(10, 5, [])), /max_tokens_exceeded/);
  });

  it("does not retry compact on any other failure", async () => {
    const forms: boolean[] = [];
    const inFittingForm = fittingForm();
    const failing = async (compact: boolean) => {
      forms.push(compact);
      throw new ClassifierError("HTTP 503: unavailable", 503, undefined);
    };
    await assert.rejects(inFittingForm(failing), /503/);
    await inFittingForm(sized(1, 15, forms));
    assert.deepEqual(forms, [false, false]);
  });

  it("probes and splits only once the compact tree overflows too", async () => {
    const inFittingForm = fittingForm();
    const asked: { compact: boolean; probe: boolean }[] = [];
    const { ask } = fakeClassifier({ limit: 1000, target: "e90" });
    const fitting: Ask = (offered, questions) =>
      inFittingForm(async (compact) => {
        asked.push({ compact, probe: Object.keys(questions).some((name) => name.endsWith("probe")) });
        /* Compact holds 40 candidates beside the tree; faithful, none. */
        if (!compact || offered.size > 40) {
          throw overflow();
        }
        return ask(offered, questions);
      });
    assert.equal((await chooserFor(fitting, TREE).decide(click(100)))?.ref, "e90");
    assert.deepEqual(asked.slice(0, 3), [
      { compact: false, probe: false },
      { compact: true, probe: false },
      { compact: true, probe: true },
    ]);
    assert.ok(asked.slice(1).every(({ compact }) => compact));
  });
});
