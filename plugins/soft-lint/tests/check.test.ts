import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { exitCode, requestInput } from "../check.ts";

const rule = (id: string, question: string) => ({ id, question, cutoff: 0.8, files: ["**/*.ts"] });

describe("requestInput", () => {
  const rules = [rule("b-rule", "Is it B?"), rule("a-rule", "Is it A?")];

  test("asks every rule about the one hunk, keyed by rule id in id order", () => {
    const input = requestInput("src/a.ts", "@@ -1 +1 @@\n+x", rules);
    assert.deepStrictEqual(
      { state: input.state, ids: Object.keys(input.questions) },
      { state: { path: "src/a.ts", hunk: "@@ -1 +1 @@\n+x" }, ids: ["a-rule", "b-rule"] },
    );
  });

  test("the request does not depend on the order the rules were given in", () => {
    const forward = requestInput("src/a.ts", "+x", rules);
    const reversed = requestInput("src/a.ts", "+x", rules.toReversed());
    assert.equal(JSON.stringify(reversed.questions), JSON.stringify(forward.questions));
  });

  test("each question limits the classifier to the added lines and carries the rule's question", () => {
    const question = requestInput("src/a.ts", "+x", rules).questions["a-rule"];
    assert.match(String(question?.instructions), /^Judge only the added lines .* of state\.hunk.*Is it A\?$/u);
  });
});

describe("exitCode", () => {
  test("everything checked with nothing found is 0", () => {
    assert.equal(exitCode({ unchecked: 0, findings: 0 }), 0);
  });

  test("everything checked with findings is 1", () => {
    assert.equal(exitCode({ unchecked: 0, findings: 3 }), 1);
  });

  test("an unchecked hunk is 2 even beside findings, since an incomplete check is no verdict", () => {
    assert.equal(exitCode({ unchecked: 1, findings: 3 }), 2);
  });
});
