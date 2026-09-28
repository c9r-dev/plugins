import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StepResult } from "../runner/engine/runner.ts";
import { verdict } from "../runner/engine/verdict.ts";

const step = (number: number, fields: Partial<StepResult>): StepResult => ({
  number,
  step: `step ${number}`,
  kind: "verify",
  status: "passed",
  detail: "",
  elapsed_ms: 0,
  flag: "ok",
  settle_ms: 0,
  ...fields,
});

const handedOver = (number: number) =>
  step(number, {
    status: "for-caller",
    flag: "visual",
    screenshot: `/out/run/step-${number}.png`,
  });

describe("verdict", () => {
  it("lists each visual step with its screenshot's path, apart from the advisory steps", () => {
    const steps = [step(1, {}), handedOver(2), step(3, { flag: "transient" }), handedOver(4)];
    assert.equal(
      verdict(steps),
      "[qa] verdict PASS: 1 of 1 decisive steps passed; for you to judge: 2 → /out/run/step-2.png, 4 → /out/run/step-4.png; advisory, not decisive: 3",
    );
  });

  it("keeps flagged and unsupported steps advisory", () => {
    const steps = [
      step(1, {}),
      step(2, { flag: "derived", status: "failed" }),
      step(3, { kind: "other", status: "unsupported" }),
    ];
    assert.equal(
      verdict(steps),
      "[qa] verdict PASS: 1 of 1 decisive steps passed; advisory, not decisive: 2, 3",
    );
  });

  it("fails on a decisive step only, never on a step handed to the caller", () => {
    const steps = [step(1, { status: "failed" }), step(2, {}), handedOver(3)];
    assert.equal(
      verdict(steps),
      "[qa] verdict FAIL: 1 of 2 decisive steps passed (failed: 1); for you to judge: 3 → /out/run/step-3.png",
    );
  });
});
