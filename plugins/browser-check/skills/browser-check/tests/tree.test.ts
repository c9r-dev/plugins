import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isUnnamed, nodesOf, withRefsOnly } from "../runner/engine/tree.ts";

/* Playwright 1.63's AI-mode snapshot: it drops a name computed from content that is still printed as children. */
const TREE = `- main [ref=e2]:
  - button [ref=e3]:
    - paragraph [ref=e7]: Credit Budgets
  - button [ref=e8]:
    - generic [ref=e11]:
      - paragraph [ref=e12]: Theme
      - text: "Off"
  - button "Plain text" [ref=e13]
  - generic [ref=e14]:
    - paragraph [ref=e15]: Section intro
  - textbox "" [ref=e16]
  - link [ref=e17]:
    - /url: /reports
    - img "Reports icon" [ref=e18]:
      - img [ref=e19]
    - text: Monthly reports`;

const labelOf = (ref: string) => {
  const node = nodesOf(TREE).find((candidate) => candidate.ref === ref);
  if (node === undefined) {
    throw new Error(`no node ${ref} in the tree`);
  }
  return node.label;
};

describe("nodesOf", () => {
  it("names a button from the text of its nested paragraph", () => {
    assert.equal(labelOf("e3"), 'button "Credit Budgets"');
  });

  it("names a button from all of its descendants' text, in document order", () => {
    assert.equal(labelOf("e8"), 'button "Theme Off"');
  });

  it("keeps a name the snapshot prints", () => {
    assert.equal(labelOf("e13"), 'button "Plain text"');
  });

  it("takes a named descendant's name rather than its children, and skips properties", () => {
    assert.equal(labelOf("e17"), 'link "Reports icon Monthly reports"');
  });

  it("leaves a container unnamed, since its role never takes a name from content", () => {
    assert.equal(labelOf("e14"), "generic");
    assert.equal(labelOf("e2"), "main");
  });
});

describe("isUnnamed", () => {
  it("refuses a field with an empty name", () => {
    assert.equal(isUnnamed(labelOf("e16")), true);
  });

  it("accepts a button named by its content", () => {
    assert.equal(isUnnamed(labelOf("e3")), false);
  });
});

describe("withRefsOnly", () => {
  it("keeps the refs offered and drops every other, leaving the rest of each line", () => {
    assert.equal(
      withRefsOnly(TREE, new Set(["e3", "e13"])).split("\n").slice(0, 4).join("\n"),
      `- main:
  - button [ref=e3]:
    - paragraph: Credit Budgets
  - button:`,
    );
  });

  it("keeps other annotations on a node whose ref it drops", () => {
    assert.equal(
      withRefsOnly('- generic "Content Injection (T1659)" [ref=e2233] [cursor=pointer]:', new Set()),
      '- generic "Content Injection (T1659)" [cursor=pointer]:',
    );
  });
});
