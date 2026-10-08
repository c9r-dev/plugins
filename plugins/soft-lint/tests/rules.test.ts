import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { modelFor, parseRules, rulesFor } from "../rules.ts";

const rule = { id: "r", question: "Is it?", cutoff: 0.5, files: ["**/*.vue"] };

describe("rulesFor", () => {
  const rules = [rule, { ...rule, id: "ts-or-mts", files: ["**/*.ts", "**/*.mts"] }];
  const idsFor = (path: string): string[] => rulesFor(rules, path).map(({ id }) => id);

  test("a ** glob matches a file at any depth, the top level included", () => {
    assert.deepStrictEqual([idsFor("src/components/A.vue"), idsFor("A.vue")], [["r"], ["r"]]);
  });

  test("a glob matches the whole path, not a prefix of the name", () => {
    assert.deepStrictEqual(idsFor("A.vue.ts"), ["ts-or-mts"]);
  });

  test("a rule applies when any one of its globs matches", () => {
    assert.deepStrictEqual(idsFor("build/vite.svg.mts"), ["ts-or-mts"]);
  });
});

describe("parseRules", () => {
  test("fills the defaults a rules file leaves out", () => {
    assert.deepStrictEqual(parseRules(JSON.stringify({ rules: [rule] })), {
      model: undefined,
      timeoutMs: 30_000,
      maxHunkChars: 4000,
      rules: [rule],
    });
  });

  test("the example rules file loads", () => {
    const example = readFileSync(new URL("../rules.json", import.meta.url), "utf8");
    assert.deepStrictEqual(
      parseRules(example).rules.map(({ id }) => id),
      ["restating-comment", "hidden-write", "swallowed-error", "template-logic"],
    );
  });

  test("an unknown key is rejected, so a typo cannot silently drop a setting", () => {
    assert.throws(() => parseRules(JSON.stringify({ rules: [rule], timeout: 5 })), /unknown key "timeout"/u);
  });

  test("a cutoff above 1 is rejected with the rule's position", () => {
    const text = JSON.stringify({ rules: [{ ...rule, cutoff: 1.5 }] });
    assert.throws(() => parseRules(text), /rules\[0\]\.cutoff/u);
  });

  test("a rule without globs is rejected", () => {
    const text = JSON.stringify({ rules: [{ ...rule, files: [] }] });
    assert.throws(() => parseRules(text), /rules\[0\]\.files/u);
  });

  test("a rule id used twice is rejected, since ids key the questions", () => {
    const text = JSON.stringify({ rules: [rule, rule] });
    assert.throws(() => parseRules(text), /used more than once/u);
  });

  test("a model is read from the file", () => {
    const model = "cloudflare:@cf/cloudflare/clef";
    assert.equal(parseRules(JSON.stringify({ rules: [rule], model })).model, model);
  });

  test("a model without a known provider is rejected", () => {
    assert.throws(() => parseRules(JSON.stringify({ rules: [rule], model: "typesafe/jev" })), /typesafe: or cloudflare:/u);
  });

  test("an empty model is rejected", () => {
    assert.throws(() => parseRules(JSON.stringify({ rules: [rule], model: "" })), /model must be/u);
  });

  test("a ci setting is an unknown key: an unchecked hunk always fails the run", () => {
    assert.throws(() => parseRules(JSON.stringify({ rules: [rule], ci: "skip" })), /unknown key "ci"/u);
  });
});

describe("modelFor", () => {
  const file = parseRules(JSON.stringify({ rules: [rule], model: "typesafe:jev-latest" }));

  test("SOFT_LINT_MODEL overrides the rules file's model", () => {
    assert.equal(modelFor({ SOFT_LINT_MODEL: "cloudflare:typesafe/jev" }, file), "cloudflare:typesafe/jev");
  });

  test("without SOFT_LINT_MODEL the rules file's model is used", () => {
    assert.equal(modelFor({}, file), "typesafe:jev-latest");
  });

  test("with neither, the model is left to the shared default", () => {
    assert.equal(modelFor({}, parseRules(JSON.stringify({ rules: [rule] }))), undefined);
  });
});
