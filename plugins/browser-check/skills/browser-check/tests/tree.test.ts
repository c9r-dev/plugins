import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isCopyOf, isUnnamed, lineageOf, nodesOf, parseTree, treeForJev, withContext } from "../runner/engine/tree.ts";

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
  const node = nodesOf(parseTree(TREE)).find((candidate) => candidate.ref === ref);
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

  it("decodes the YAML escapes that JSON lacks", () => {
    const [node] = nodesOf(parseTree(String.raw`- button "\0\a\e\v\N\_\L\P\ \/\U0001F600" [ref=e1]`));
    assert.equal(node?.name, "\0\x07\x1b\v\x85\xa0\u2028\u2029 /\u{1F600}");
  });

  it("refuses an escape YAML does not define, naming it", () => {
    assert.throws(() => parseTree(String.raw`- button "A\q" [ref=e1]`), /invalid escape \\q in YAML scalar/u);
  });

  it("reads a line whose whole key Playwright single-quotes", () => {
    const [node] = nodesOf(parseTree(`- 'button "Don''t: save" [ref=e1]'`));
    assert.deepEqual([node?.ref, node?.label], ["e1", 'button "Don\'t: save"']);
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

const lines = (...printed: string[]) => printed.join("\n");

const sent = (tree: string, offered: string[] = []) =>
  treeForJev(parseTree(tree), { offered: new Set(offered), compact: true });

const faithful = (tree: string, offered: string[] = []) =>
  treeForJev(parseTree(tree), { offered: new Set(offered), compact: false });

describe("treeForJev", () => {
  it("keeps the refs offered and drops every other, leaving the rest of each line", () => {
    assert.equal(
      sent(TREE, ["e3", "e13"]).split("\n").slice(0, 3).join("\n"),
      lines("- main:", " - button [ref=e3]:", "  - paragraph: Credit Budgets"),
    );
  });

  it("drops the pointer mark and keeps every other annotation", () => {
    assert.equal(
      sent('- button "Save" [ref=e1] [disabled] [cursor=pointer]', ["e1"]),
      '- button "Save" [ref=e1] [disabled]',
    );
  });

  it("indents one space per level", () => {
    assert.equal(
      sent(lines("- list:", "  - listitem:", '    - link "Home"')),
      lines("- list:", " - listitem:", '  - link "Home"'),
    );
  });

  it("keeps a property line as printed", () => {
    assert.equal(
      sent(lines('- link "Reports" [ref=e1]:', "  - /url: /reports")),
      lines('- link "Reports":', " - /url: /reports"),
    );
  });

  it("drops a text leaf an enclosing name holds", () => {
    const tree = lines(
      '- group "Option 3 (X-3)":',
      "  - list:",
      "    - paragraph: Option 3",
      "    - paragraph: X-3",
      '    - link "More"',
    );
    assert.equal(sent(tree), lines('- group "Option 3 (X-3)":', " - list:", '  - link "More"'));
  });

  it("drops a text leaf a sibling's name holds and keeps one it does not", () => {
    assert.equal(
      sent(lines("- row:", '  - checkbox "Option 3 (X-3)"', "  - text: X-3", "  - text: Selected")),
      lines("- row:", ' - checkbox "Option 3 (X-3)"', " - text: Selected"),
    );
  });

  it("keeps a text leaf that is only part of a word in the name", () => {
    assert.equal(
      sent(lines('- group "Option 13":', "  - text: 3", "  - text: Option 1")),
      lines('- group "Option 13":', " - text: 3", " - text: Option 1"),
    );
  });

  it("drops a text leaf the name holds as a whole token between punctuation", () => {
    assert.equal(
      sent(lines('- group "Option 3 (X-3)":', "  - text: 3", '  - link "More"')),
      lines('- group "Option 3 (X-3)":', ' - link "More"'),
    );
  });

  it("keeps an empty text leaf, since an empty text holds no words", () => {
    assert.equal(sent(lines('- generic "Card":', '  - paragraph: ""')), lines('- generic "Card":', ' - paragraph: ""'));
  });

  it("keeps a control whose value the enclosing name holds", () => {
    assert.equal(
      sent(lines('- group "hello world":', "  - textbox: hello")),
      lines('- group "hello world":', " - textbox: hello"),
    );
  });

  it("keeps a text leaf whose ref is offered", () => {
    assert.equal(
      sent(lines('- group "Option 3 (X-3)":', "  - paragraph [ref=e2]: X-3"), ["e2"]),
      lines('- group "Option 3 (X-3)":', " - paragraph [ref=e2]: X-3"),
    );
  });

  it("drops a name a child repeats, keeping the node's other annotations and offered ref", () => {
    assert.equal(
      sent(
        lines('- generic "Option 3 (X-3)" [expanded] [ref=e1]:', '  - checkbox "Option 3 (X-3)" [ref=e2]'),
        ["e1", "e2"],
      ),
      lines("- generic [expanded] [ref=e1]:", ' - checkbox "Option 3 (X-3)" [ref=e2]'),
    );
  });

  it("puts a bare generic's only child in its place and drops a childless one", () => {
    assert.equal(
      sent(lines("- list:", "  - generic:", '    - link "Home"', "  - generic")),
      lines("- list:", ' - link "Home"'),
    );
  });

  it("keeps a bare generic that groups two entries", () => {
    assert.equal(
      sent(lines("- generic:", '  - link "Home"', '  - link "Help"')),
      lines("- generic:", ' - link "Home"', ' - link "Help"'),
    );
  });

  it("keeps a generic around one entry when its ref is offered", () => {
    assert.equal(
      sent(lines("- generic [ref=e1]:", '  - link "Home"'), ["e1"]),
      lines("- generic [ref=e1]:", ' - link "Home"'),
    );
  });

  it("keeps echoed text and repeated names in the faithful form", () => {
    const tree = lines(
      '- generic "Option 3 (X-3)" [ref=e1] [cursor=pointer]:',
      '  - checkbox "Option 3 (X-3)" [ref=e2]',
      "  - generic:",
      "    - paragraph: Option 3",
      "    - paragraph: X-3",
    );
    assert.equal(
      faithful(tree, ["e2"]),
      lines(
        '- generic "Option 3 (X-3)":',
        ' - checkbox "Option 3 (X-3)" [ref=e2]',
        " - generic:",
        "  - paragraph: Option 3",
        "  - paragraph: X-3",
      ),
    );
  });

  it("splices a bare generic of one entry in the faithful form too", () => {
    assert.equal(faithful(lines("- list:", "  - generic:", '    - link "Home"')), lines("- list:", ' - link "Home"'));
  });

  it("keeps each option's sub-options in their own group", () => {
    const options = lines(
      "- generic [ref=e0]:",
      "  - generic [ref=e1]:",
      '    - generic "Option 3 (X-3)" [ref=e2] [cursor=pointer]:',
      '      - checkbox "Option 3 (X-3)" [ref=e3]',
      "      - generic [ref=e4]:",
      "        - paragraph [ref=e5]: Option 3",
      "        - paragraph [ref=e6]: X-3",
      '    - button "Sub-options of Option 3" [expanded] [ref=e7] [cursor=pointer]',
      "  - generic [ref=e8]:",
      '    - generic "Option 3.1 (X-3.1)" [ref=e9] [cursor=pointer]:',
      '      - checkbox "Option 3.1 (X-3.1)" [checked] [ref=e10]',
      '    - generic "Option 3.2 (X-3.2)" [ref=e11] [cursor=pointer]:',
      '      - checkbox "Option 3.2 (X-3.2)" [ref=e12]',
    );
    assert.equal(
      sent(options, ["e3", "e7", "e10", "e12"]),
      lines(
        "- generic:",
        " - generic:",
        '  - checkbox "Option 3 (X-3)" [ref=e3]',
        '  - button "Sub-options of Option 3" [expanded] [ref=e7]',
        " - generic:",
        '  - checkbox "Option 3.1 (X-3.1)" [checked] [ref=e10]',
        '  - checkbox "Option 3.2 (X-3.2)" [ref=e12]',
      ),
    );
  });
});

describe("withContext", () => {
  /** The context labels `withContext` gives the copies `refs`, in a choice that also offers `others`. */
  const labelled = (tree: string, refs: string[], others: string[] = []) => {
    const parsed = parseTree(tree);
    const copies = nodesOf(parsed).filter(({ ref }) => refs.includes(ref));
    return withContext(parsed, copies, new Set([...refs, ...others])).map(({ label }) => label);
  };

  it("tells copies apart by the heading each follows, and adds no part it does not need", () => {
    const tree = lines(
      '- main "Docs":',
      '  - heading "Install" [level=2]',
      '  - button "Copy" [ref=e1]',
      '  - heading "Usage" [level=2]',
      '  - button "Copy" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      'button "Copy" — under heading "Install"',
      'button "Copy" — under heading "Usage"',
    ]);
  });

  it("drops a heading once the walk leaves the container it sits in", () => {
    const tree = lines(
      "- main:",
      '  - heading "Install" [level=2]',
      '  - button "Copy" [ref=e1]',
      "- contentinfo:",
      '  - button "Copy" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), ['button "Copy" — under heading "Install"', 'button "Copy"']);
  });

  it("keeps a heading in a generic wrapper over what follows the wrapper", () => {
    const tree = lines(
      "- generic:",
      '  - heading "Install" [level=2]',
      '- button "Copy" [ref=e1]',
      "- generic:",
      '  - heading "Usage" [level=2]',
      '- button "Copy" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      'button "Copy" — under heading "Install"',
      'button "Copy" — under heading "Usage"',
    ]);
  });

  it("tells copies under one heading apart by their nearest named ancestor", () => {
    const tree = lines(
      '- heading "Examples" [level=2]',
      '- group "Basic":',
      '  - button "Copy" [ref=e1]',
      '- group "Advanced":',
      '  - button "Copy" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      'button "Copy" — in group "Basic"',
      'button "Copy" — in group "Advanced"',
    ]);
  });

  it("uses heading and ancestor together when neither alone tells every copy apart", () => {
    const tree = lines(
      '- heading "First" [level=2]',
      '- group "Demo":',
      '  - button "Copy" [ref=e1]',
      '- heading "Second" [level=2]',
      '- group "Demo":',
      '  - button "Copy" [ref=e2]',
      '- group "Other":',
      '  - button "Copy" [ref=e3]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2", "e3"]), [
      'button "Copy" — under heading "First", in group "Demo"',
      'button "Copy" — under heading "Second", in group "Demo"',
      'button "Copy" — under heading "Second", in group "Other"',
    ]);
  });

  it("gives copies that nothing tells apart their fullest context, so they read the same", () => {
    const tree = lines(
      '- group "Table":',
      '  - row "Alice 42" [ref=e1]',
      '  - row "Alice 42" [ref=e2]',
      '- group "Archive":',
      '  - row "Alice 42" [ref=e3]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2", "e3"]), [
      'row "Alice 42" — in group "Table"',
      'row "Alice 42" — in group "Table"',
      'row "Alice 42" — in group "Archive"',
    ]);
  });

  it("names a heading by its own text, without its anchor or the controls beside it", () => {
    const tree = lines(
      "- heading [level=2]:",
      '  - link "Install":',
      '    - /url: "#install"',
      '    - text: "#"',
      "  - text: Install",
      '  - button "Post a comment"',
      '- button "Copy" [ref=e1]',
      "- heading [level=2]:",
      '  - link "Usage":',
      '    - /url: "#usage"',
      '  - button "Post a comment"',
      '- button "Copy" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      'button "Copy" — under heading "Install"',
      'button "Copy" — under heading "Usage"',
    ]);
  });

  it("places a node inside a heading in it rather than under the heading before", () => {
    const tree = lines(
      '- heading "Install" [level=2]:',
      '  - link "#" [ref=e1]',
      '- heading "Usage" [level=2]:',
      '  - link "#" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      'link "#" — in heading "Install"',
      'link "#" — in heading "Usage"',
    ]);
  });

  it("names a row that prints unnamed by its cells, without the candidates it holds", () => {
    const tree = lines(
      "- row [ref=e1]:",
      "  - gridcell [ref=e5]:",
      '    - checkbox "Select row" [ref=e2]',
      '  - gridcell "Purchase order" [ref=e6]',
      '  - gridcell [ref=e7]:',
      '    - button "Open menu" [ref=e8]',
      "- row [ref=e3]:",
      "  - gridcell [ref=e9]:",
      '    - checkbox "Select row" [ref=e4]',
      '  - gridcell "Invoice" [ref=e10]',
      '  - gridcell [ref=e11]:',
      '    - button "Open menu" [ref=e12]',
    );
    assert.deepEqual(labelled(tree, ["e2", "e4"], ["e8", "e12"]), [
      'checkbox "Select row" — in row "Purchase order"',
      'checkbox "Select row" — in row "Invoice"',
    ]);
  });

  it("keeps a row's whole text, so a cell that tells it apart late in the row stays", () => {
    const prefix = "Quarterly revenue report for the northern sales region, final draft";
    const tree = lines(
      "- row:",
      `  - gridcell "${prefix}"`,
      '  - gridcell "March"',
      '  - button "Open" [ref=e1]',
      "- row:",
      `  - gridcell "${prefix}"`,
      '  - gridcell "April"',
      '  - button "Open" [ref=e2]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2"]), [
      `button "Open" — in row "${prefix} March"`,
      `button "Open" — in row "${prefix} April"`,
    ]);
  });

  it("counts copies apart by their labels with context, so copies of different labels need less", () => {
    const tree = lines(
      '- heading "Line" [level=3]',
      '- treeitem "plus-square parent 1-2" [ref=e1]',
      '- heading "Icons" [level=3]',
      '- treeitem "down parent 1-2" [ref=e2]',
      '- generic "parent 1-2" [ref=e3]',
    );
    assert.deepEqual(labelled(tree, ["e1", "e2", "e3"]), [
      'treeitem "plus-square parent 1-2" — under heading "Line"',
      'treeitem "down parent 1-2" — under heading "Icons"',
      'generic "parent 1-2" — under heading "Icons"',
    ]);
  });

  it("skips an ancestor named as the copy itself", () => {
    const tree = lines(
      '- group "Stealth":',
      '  - generic "Option 3 (X-3)" [ref=e1]:',
      '    - checkbox "Option 3 (X-3)" [ref=e2]',
      '- group "Persistence":',
      '  - generic "Option 3 (X-3)" [ref=e3]:',
      '    - checkbox "Option 3 (X-3)" [ref=e4]',
    );
    assert.deepEqual(labelled(tree, ["e2", "e4"]), [
      'checkbox "Option 3 (X-3)" — in group "Stealth"',
      'checkbox "Option 3 (X-3)" — in group "Persistence"',
    ]);
  });
});

describe("isCopyOf", () => {
  /** The node a snapshot line prints, label and accessible name. */
  const node = (line: string) => {
    const [printed] = nodesOf(parseTree(`- ${line} [ref=e1]`));
    if (printed === undefined) {
      throw new Error(`no node in ${line}`);
    }
    return printed;
  };
  const isCopy = (line: string, other: string) => isCopyOf(node(line), node(other));

  it("takes a name holding another as whole words for a copy, whatever the roles", () => {
    assert.deepEqual(
      [
        isCopy('treeitem "down parent 1-2"', 'generic "parent 1-2"'),
        isCopy('generic "parent 1-2"', 'treeitem "plus-square parent 1-2"'),
      ],
      [true, true],
    );
  });

  it("does not take a name that only shares part of a word", () => {
    assert.equal(isCopy('checkbox "Option 1"', 'checkbox "Option 13"'), false);
  });

  it("does not take different names for copies", () => {
    assert.equal(isCopy('link "Install"', 'link "Usage"'), false);
  });

  it("does not take an empty name for a copy of a named one", () => {
    assert.equal(isCopy('textbox ""', 'button "Save"'), false);
  });

  it("takes the same label for a copy, unnamed ones included", () => {
    assert.deepEqual([isCopy("checkbox", "checkbox"), isCopy("checkbox", "radio")], [true, false]);
  });
});

describe("lineageOf", () => {
  const tree = lines(
    '- row "Frozen yoghurt 159" [ref=e1]:',
    '  - cell [ref=e2]:',
    '    - button "expand row" [ref=e3]',
    '  - cell "Frozen yoghurt" [ref=e4]',
    '- generic "Option 3 (X-3)" [ref=e5]:',
    '  - checkbox "Option 3 (X-3)" [ref=e6]',
    '- generic "Option 3 (X-3)" [ref=e7]:',
    '  - checkbox "Option 3 (X-3)" [ref=e8]',
  );

  it("holds a row's own expand button", () => {
    assert.ok(lineageOf(parseTree(tree), "e1").has("e3"));
  });

  it("holds a checkbox's own wrapper", () => {
    assert.ok(lineageOf(parseTree(tree), "e6").has("e5"));
  });

  it("leaves out the same name in a sibling subtree", () => {
    const lineage = lineageOf(parseTree(tree), "e6");
    assert.deepEqual([lineage.has("e7"), lineage.has("e8")], [false, false]);
  });
});
