import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evidenceFiles, keepsEvidence } from "../runner/engine/evidence.ts";

describe("keepsEvidence", () => {
  it("skips a passed step when only failures are recorded", () => {
    assert.equal(keepsEvidence("passed", false), false);
  });

  it("keeps every step that did not pass", () => {
    const kept = (["failed", "for-caller", "unsupported"] as const).filter(
      (status) => keepsEvidence(status, false),
    );
    assert.deepEqual(kept, ["failed", "for-caller", "unsupported"]);
  });

  it("keeps a passed step when every step is recorded", () => {
    assert.equal(keepsEvidence("passed", true), true);
  });
});

describe("evidenceFiles", () => {
  it("names the tree after the step, beside its screenshot", () => {
    assert.deepEqual(evidenceFiles(3), {
      screenshot: "step-3.png",
      tree: "step-3.aria.yml",
    });
  });
});
