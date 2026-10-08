import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const cli = join(import.meta.dirname, "..", "cli.ts");
const fake = join(import.meta.dirname, "fake-classifier.ts");

const rule = { id: "swallowed", question: "Do the added lines swallow an error?", cutoff: 0.8, files: ["**/*.ts"] };

function rulesFile(settings: { maxHunkChars?: number } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), "soft-lint-cli-")), "rules.json");
  writeFileSync(path, JSON.stringify({ model: "typesafe:jev-latest", ...settings, rules: [rule] }));
  return path;
}

/* Two files, one hunk each; only a.ts matches the rule. */
const diff = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+try { run(); } catch {}
 export { a };
diff --git a/notes.md b/notes.md
index 3333333..4444444 100644
--- a/notes.md
+++ b/notes.md
@@ -1 +1,2 @@
 # Notes
+more
`;

function runJson(fakeEnv: Record<string, string>, rules = rulesFile(), input = diff) {
  const result = spawnSync(process.execPath, ["--import", fake, cli, "--json", rules], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "key", ...fakeEnv },
  });
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("soft-lint --json", () => {
  test("a finding reports its rule, line, score and cutoff, and exits 1", () => {
    const { status, report } = runJson({ FAKE_CLASSIFIER_NOUL: "0.9" });
    assert.deepStrictEqual(
      { status, findings: report.findings },
      {
        status: 1,
        findings: [{ path: "a.ts", line: 2, rule: "swallowed", score: 0.9, cutoff: 0.8, question: rule.question }],
      },
    );
  });

  test("counts every hunk, and a request only for each hunk a rule matched", () => {
    const { report } = runJson({ FAKE_CLASSIFIER_NOUL: "0.1" });
    assert.deepStrictEqual(
      { model: report.model, files: report.files, hunks: report.hunks, requests: report.requests, gatewayHits: report.gatewayHits },
      { model: "typesafe:jev-latest", files: 2, hunks: 2, requests: 1, gatewayHits: 0 },
    );
  });

  test("a hunk longer than maxHunkChars is one request per window, each finding at its window's first added line", () => {
    const body = Array.from({ length: 40 }, (_, index) => `+const line${index + 1} = ${"0".repeat(40)};`);
    const newFile = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,40 @@
${body.join("\n")}
`;
    const { report } = runJson({ FAKE_CLASSIFIER_NOUL: "0.9" }, rulesFile({ maxHunkChars: 1000 }), newFile);
    const findings = report.findings as { line: number }[];
    assert.deepStrictEqual(
      { hunks: report.hunks, requests: report.requests, lines: findings.map(({ line }) => line) },
      /* 16 of these 57-58 character lines fit in 1,000 beside the header and omission markers. */
      { hunks: 1, requests: 3, lines: [1, 17, 33] },
    );
  });

  test("a score below the cutoff is no finding, and exits 0", () => {
    const { status, report } = runJson({ FAKE_CLASSIFIER_NOUL: "0.1" });
    assert.deepStrictEqual({ status, findings: report.findings }, { status: 0, findings: [] });
  });

  test("a hunk the classifier refused is unchecked with its reason, and exits 2", () => {
    const { status, report } = runJson({ FAKE_CLASSIFIER_STATUS: "400" });
    assert.deepStrictEqual(
      { status, unchecked: report.unchecked, reasons: report.reasons },
      {
        status: 2,
        unchecked: ["a.ts"],
        reasons: ["typesafe:jev-latest request failed after 1 attempt: HTTP 400: refused by the fake classifier"],
      },
    );
  });

  test("a run that cannot start reports only its error, and exits 2", () => {
    const { status, report } = runJson({}, "/nonexistent/rules.json");
    assert.deepStrictEqual(
      { status, keys: Object.keys(report).toSorted(), missingFile: String(report.error).includes("ENOENT") },
      { status: 2, keys: ["durationMs", "error"], missingFile: true },
    );
  });

  test("prints nothing on stderr, so stdout is the whole result", () => {
    assert.equal(runJson({ FAKE_CLASSIFIER_STATUS: "400" }).stderr, "");
  });
});
