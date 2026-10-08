import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NONE, choiceAmong, finalistsOf, offeredRefs, questionsFor } from "../runner/engine/choice.ts";

/** `count` checkboxes, as a large grid offers them: e1, e2, … */
const checkboxes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ ref: `e${index + 1}`, label: `checkbox "Option ${index + 1}"` }));

/** Jev's limit on the labels of one choice question. */
const JEV_MAX_LABELS = 255;

describe("choiceAmong", () => {
  it("asks up to 250 candidates as one question", () => {
    assert.deepEqual(Object.keys(questionsFor(choiceAmong("click", "Which?", checkboxes(250)))), ["click0"]);
  });

  it("offers every candidate of a larger page, in questions Jev accepts", () => {
    const questions = Object.values(questionsFor(choiceAmong("click", "Which?", checkboxes(552))));
    const offered = questions.flatMap(({ criteria }) => Object.keys(criteria).filter((ref) => ref !== NONE));
    assert.deepEqual(offered, checkboxes(552).map(({ ref }) => ref));
    assert.ok(questions.every(({ criteria }) => Object.keys(criteria).length <= JEV_MAX_LABELS));
  });

  it("gives every question the option that no element matches", () => {
    const questions = Object.values(questionsFor(choiceAmong("click", "Which?", checkboxes(300))));
    assert.ok(questions.every(({ criteria }) => NONE in criteria));
  });

  it("asks nothing when there are no candidates", () => {
    assert.deepEqual(questionsFor(choiceAmong("click", "Which?", [])), {});
  });
});

describe("offeredRefs", () => {
  it("collects the refs of every slice of every choice", () => {
    const refs = offeredRefs([
      choiceAmong("click", "Which?", checkboxes(260)),
      choiceAmong("type", "Which?", [{ ref: "e900", label: 'textbox "Search"' }]),
    ]);
    assert.ok(refs.has("e1") && refs.has("e260") && refs.has("e900"));
    assert.equal(refs.has("e261"), false);
  });
});

describe("finalistsOf", () => {
  const choice = choiceAmong("click", "Which?", checkboxes(300));

  it("takes each slice's chosen element with its confidence, and skips a slice that chose none", () => {
    const finalists = finalistsOf(choice, {
      click0: { choice: "e12", confidence: 0.6 },
      click1: { choice: NONE, confidence: 0.9 },
    });
    assert.deepEqual(finalists, [{ ref: "e12", label: 'checkbox "Option 12"', confidence: 0.6 }]);
  });

  it("keeps one finalist per slice that chose an element", () => {
    const finalists = finalistsOf(choice, {
      click0: { choice: "e12", confidence: 0.6 },
      click1: { choice: "e290", confidence: 0.8 },
    });
    assert.deepEqual(
      finalists.map(({ ref }) => ref),
      ["e12", "e290"],
    );
  });

  it("ignores an answer naming a ref its slice did not offer", () => {
    assert.deepEqual(finalistsOf(choice, { click0: { choice: "e290", confidence: 0.9 } }), []);
  });
});
