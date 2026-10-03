import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { judgeVisually } from "../runner/engine/visual.ts";

const SCREENSHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const page = { screenshot: async () => Buffer.from(SCREENSHOT) };
const claim = { claim: "Confirm the logo is centred", claimNumber: 3, checklist: ["a", "b", "Confirm the logo is centred"] };

/** Writes a judge module whose default export has `body` as its body, and points QA_VISUAL_JUDGE at it. */
const useJudge = (body: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "visual-judge-")), "judge.mjs");
  writeFileSync(path, `export default async (input) => { ${body} };`);
  process.env.QA_VISUAL_JUDGE = path;
  return path;
};

describe("judgeVisually", () => {
  afterEach(() => {
    delete process.env.QA_VISUAL_JUDGE;
  });

  it("hands the step to the caller when no judge is configured", async () => {
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
  });

  it("passes the step when the judge passes it, given the claim and the screenshot", async () => {
    useJudge(`
      const seen = [input.claim, input.claimNumber, input.checklist.length, [...input.screenshot].join(",")].join("|");
      return { status: "passed", detail: seen };
    `);
    const result = await judgeVisually(page, claim);
    assert.deepEqual(result, { status: "passed", detail: "visual judge: Confirm the logo is centred|3|3|137,80,78,71" });
  });

  it("hands the step back with the judge's detail when the judge hands it back", async () => {
    useJudge(`return { status: "for-caller", detail: "score 0.12" };`);
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
    assert.match(result.detail, /visual judge: score 0\.12$/);
  });

  it("hands the step back with the error when the judge throws", async () => {
    const path = useJudge(`throw new Error("HTTP 413");`);
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
    assert.match(result.detail, new RegExp(`visual judge ${path} failed: HTTP 413$`));
  });

  it("never fails a step, whatever status the judge returns", async () => {
    useJudge(`return { status: "failed", detail: "looks wrong" };`);
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
    assert.match(result.detail, /returned status "failed"/);
  });

  it("hands the step back when the module cannot be loaded", async () => {
    process.env.QA_VISUAL_JUDGE = join(tmpdir(), "no-such-judge.mjs");
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
    assert.match(result.detail, /failed: /);
  });

  it("refuses a relative module path", async () => {
    process.env.QA_VISUAL_JUDGE = "judge.mjs";
    const result = await judgeVisually(page, claim);
    assert.equal(result.status, "for-caller");
    assert.match(result.detail, /must be an absolute path/);
  });
});
