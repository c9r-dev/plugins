import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Slice } from "../runner/engine/choice.ts";
import {
  NONE,
  choiceAmong,
  copiesOf,
  copyDecisionOf,
  halvesOf,
  picksOf,
  probeOf,
  refsOf,
  requestOf,
  runOffAmong,
} from "../runner/engine/choice.ts";

/** `count` checkboxes, as a large grid offers them: e1, e2, … */
const checkboxes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ref: `e${index + 1}`,
    label: `checkbox "Option ${index + 1}"`,
    name: `Option ${index + 1}`,
  }));

/** Jev's limit on the labels of one choice question. */
const JEV_MAX_LABELS = 255;

/** The options a slice asks among, as its request puts them to Jev. */
const criteriaOf = (slice: Slice) => requestOf([slice]).questions[slice.name]?.criteria ?? {};

/** The refs a slice offers, without the way out. */
const refsIn = (slice: Slice) => Object.keys(criteriaOf(slice)).filter((ref) => ref !== NONE);

describe("choiceAmong", () => {
  it("asks up to 250 candidates as one question", () => {
    assert.deepEqual(
      choiceAmong("click", "Which?", checkboxes(250)).slices.map(({ name }) => name),
      ["click0"],
    );
  });

  it("asks a 251st candidate in a second question", () => {
    assert.deepEqual(
      choiceAmong("click", "Which?", checkboxes(251)).slices.map(({ name }) => name),
      ["click0", "click1"],
    );
  });

  it("offers every candidate of a larger page, in questions Jev accepts", () => {
    const { slices } = choiceAmong("click", "Which?", checkboxes(552));
    assert.deepEqual(
      slices.flatMap(refsIn),
      checkboxes(552).map(({ ref }) => ref),
    );
    assert.ok(slices.every((slice) => Object.keys(criteriaOf(slice)).length <= JEV_MAX_LABELS));
  });

  it("gives every question the option that no element matches", () => {
    assert.ok(choiceAmong("click", "Which?", checkboxes(300)).slices.every((slice) => NONE in criteriaOf(slice)));
  });

  it("has no slice to ask when there are no candidates", () => {
    assert.deepEqual(choiceAmong("click", "Which?", []).slices, []);
  });
});

describe("runOffAmong", () => {
  it("offers only the picks, with no way out", () => {
    const { slices } = runOffAmong("click", "Which?", checkboxes(2));
    assert.deepEqual(
      slices.map((slice) => Object.keys(criteriaOf(slice))),
      [["e1", "e2"]],
    );
  });

  it("keeps no way out when its slice is split", () => {
    const halves = halvesOf(runOffAmong("click", "Which?", checkboxes(4)).slices);
    assert.ok(halves?.flat().every((slice) => !(NONE in criteriaOf(slice))));
  });
});

describe("requestOf", () => {
  const click = choiceAmong("click", "Which?", checkboxes(260));
  const type = choiceAmong("type", "Which?", [{ ref: "e900", label: 'textbox "Search"', name: "Search" }]);
  const slices = [click.slices[0], type.slices[0]].filter((slice) => slice !== undefined);

  it("asks each slice under its own name", () => {
    assert.deepEqual(Object.keys(requestOf(slices).questions), ["click0", "type0"]);
  });

  it("offers the refs of its slices only", () => {
    const { offered } = requestOf(slices);
    assert.deepEqual(
      [offered.has("e1"), offered.has("e250"), offered.has("e900"), offered.has("e251"), offered.has(NONE)],
      [true, true, true, false, false],
    );
  });
});

describe("halvesOf", () => {
  const click = choiceAmong("click", "Which?", checkboxes(5));
  const type = choiceAmong("type", "Which?", [{ ref: "e900", label: 'textbox "Search"', name: "Search" }]);
  const slices = [click.slices[0], type.slices[0]].filter((slice) => slice !== undefined);

  it("splits the request's candidates across its slices into a first and a second half, named apart", () => {
    const halves = halvesOf(slices);
    assert.deepEqual(
      halves?.map((half) => half.map((slice) => [slice.name, refsIn(slice)])),
      [
        [["click0a", ["e1", "e2", "e3"]]],
        [
          ["click0b", ["e4", "e5"]],
          ["type0b", ["e900"]],
        ],
      ],
    );
  });

  it("splits slices of one candidate each apart", () => {
    const single = choiceAmong("click", "Which?", checkboxes(1)).slices;
    const halves = halvesOf([...single, ...type.slices]);
    assert.deepEqual(
      halves?.map((half) => half.map((slice) => [slice.name, refsIn(slice)])),
      [[["click0a", ["e1"]]], [["type0b", ["e900"]]]],
    );
  });

  it("keeps the way out in every half", () => {
    assert.ok(halvesOf(slices)?.flat().every((slice) => NONE in criteriaOf(slice)));
  });

  it("keeps each half in its choice", () => {
    assert.deepEqual(
      halvesOf(slices)?.flat().map(({ choice }) => choice),
      ["click", "click", "type"],
    );
  });

  it("splits down to one candidate per slice, then gives up", () => {
    let current = [click.slices[0]].filter((slice) => slice !== undefined);
    const sizes: number[][] = [];
    for (let halves = halvesOf(current); halves !== undefined; halves = halvesOf(current)) {
      current = halves[0];
      sizes.push(current.map((slice) => refsIn(slice).length));
    }
    assert.deepEqual(sizes, [[3], [2], [1]]);
  });
});

describe("probeOf", () => {
  it("asks about the first candidate of the first slice alone, with the way out", () => {
    const { slices } = choiceAmong("click", "Which?", checkboxes(300));
    const probe = probeOf(slices);
    assert.deepEqual(
      probe.map((slice) => [slice.name, Object.keys(criteriaOf(slice))]),
      [["click0probe", ["e1", NONE]]],
    );
  });
});

describe("picksOf", () => {
  const { slices } = choiceAmong("click", "Which?", checkboxes(300));

  it("takes each slice's chosen element with its confidence, and skips a slice that chose none", () => {
    const finalists = picksOf(slices, {
      click0: { choice: "e12", confidence: 0.6 },
      click1: { choice: NONE, confidence: 0.9 },
    });
    assert.deepEqual(finalists, [{ ref: "e12", label: 'checkbox "Option 12"', name: "Option 12", confidence: 0.6 }]);
  });

  it("keeps one finalist per slice that chose an element", () => {
    const finalists = picksOf(slices, {
      click0: { choice: "e12", confidence: 0.6 },
      click1: { choice: "e290", confidence: 0.8 },
    });
    assert.deepEqual(
      finalists.map(({ ref }) => ref),
      ["e12", "e290"],
    );
  });

  it("ignores an answer naming a ref its slice did not offer", () => {
    assert.deepEqual(picksOf(slices, { click0: { choice: "e290", confidence: 0.9 } }), []);
  });

  it("reads the answers of split halves by their own names", () => {
    const halves = halvesOf(slices.slice(0, 1)) ?? [[], []];
    const finalists = picksOf([...halves[0], ...halves[1]], {
      click0a: { choice: "e3", confidence: 0.7 },
      click0b: { choice: "e200", confidence: 0.8 },
    });
    assert.deepEqual(
      finalists.map(({ ref }) => ref),
      ["e3", "e200"],
    );
  });
});

describe("refsOf", () => {
  it("collects every candidate's ref across slices, without the way out", () => {
    const refs = refsOf(choiceAmong("click", "Which?", checkboxes(300)).slices);
    assert.deepEqual([refs.size, refs.has("e300"), refs.has(NONE)], [300, true, false]);
  });
});

describe("copiesOf", () => {
  const candidates = [
    ...checkboxes(260),
    { ref: "e900", label: 'button "Copy"', name: "Copy" },
    { ref: "e901", label: 'button "Copy"', name: "Copy" },
  ];
  const choice = choiceAmong("click", "Which?", [{ ref: "e899", label: 'button "Copy"', name: "Copy" }, ...candidates]);

  it("finds every candidate `isCopy` takes, across slices", () => {
    assert.deepEqual(
      copiesOf(choice, ({ label }) => label === 'button "Copy"').map(({ ref }) => ref),
      ["e899", "e900", "e901"],
    );
  });
});

describe("copyDecisionOf", () => {
  const pick = { ref: "e1", label: 'button "Copy"', name: "Copy" };

  it("keeps a pick with no copy", () => {
    const alone = [{ ref: "e1", label: 'button "Copy" — under heading "Install"', name: "Copy" }];
    assert.deepEqual(copyDecisionOf(pick, alone), { kind: "unique" });
  });

  it("runs off a pick its place gave no context, while its label still differs", () => {
    const labelled = [
      { ref: "e1", label: 'button "Copy"', name: "Copy" },
      { ref: "e2", label: 'button "Copy" — under heading "Usage"', name: "Copy" },
    ];
    assert.deepEqual(copyDecisionOf(pick, labelled), { kind: "run-off", copies: labelled });
  });

  it("decides nothing when the pick and another copy have no context at all", () => {
    const labelled = [
      { ref: "e1", label: 'button "Copy"', name: "Copy" },
      { ref: "e2", label: 'button "Copy"', name: "Copy" },
    ];
    assert.deepEqual(copyDecisionOf(pick, labelled), { kind: "indistinguishable", count: 2 });
  });

  it("runs off the copies set apart, leaving out those that read the same as each other", () => {
    const labelled = [
      { ref: "e1", label: 'button "Copy" — under heading "Install"', name: "Copy" },
      { ref: "e2", label: 'button "Copy" — under heading "Usage"', name: "Copy" },
      { ref: "e3", label: 'button "Copy" — under heading "Notes"', name: "Copy" },
      { ref: "e4", label: 'button "Copy" — under heading "Notes"', name: "Copy" },
    ];
    assert.deepEqual(copyDecisionOf(pick, labelled), { kind: "run-off", copies: labelled.slice(0, 2) });
  });

  it("decides nothing when another copy reads the same as the pick", () => {
    const labelled = [
      { ref: "e1", label: 'button "Remove" — under heading "Edit Group"', name: "Remove" },
      { ref: "e2", label: 'button "Remove" — under heading "Edit Group"', name: "Remove" },
      { ref: "e3", label: 'button "Remove" — in listitem "PowerShell"', name: "Remove" },
    ];
    assert.deepEqual(copyDecisionOf({ ref: "e1", label: 'button "Remove"', name: "Remove" }, labelled), {
      kind: "indistinguishable",
      count: 2,
    });
  });
});
