import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { Report, ReportedFinding } from "../report.ts";

const respond = join(import.meta.dirname, "..", "hooks", "respond.ts");

const finding: ReportedFinding = { path: "src/a.ts", line: 4, rule: "swallowed", score: 0.93, cutoff: 0.8, question: "Swallowed?" };

const ran = (findings: ReportedFinding[], reasons: string[] = []): Report => ({
  durationMs: 812,
  model: "cloudflare:typesafe/jev",
  files: 1,
  hunks: 2,
  requests: 2,
  gatewayHits: 1,
  findings,
  unchecked: reasons.length > 0 ? ["src/a.ts"] : [],
  reasons,
});

function runRespond(report: Report, exit: number, dataDir: string | undefined) {
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  if (dataDir !== undefined) {
    env.CLAUDE_PLUGIN_DATA = dataDir;
  }
  const result = spawnSync(process.execPath, [respond, "/repo", "src/a.ts", String(exit)], {
    input: JSON.stringify(report),
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "soft-lint-respond-"));

/** The run log's lines, parsed, with `time` checked to be ISO and then dropped so the rest compares exactly. */
function logLines(dataDir: string): Record<string, unknown>[] {
  return readFileSync(join(dataDir, "runs.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const { time, ...rest } = JSON.parse(line) as Record<string, unknown>;
      assert.equal(new Date(String(time)).toISOString(), time);
      return rest;
    });
}

describe("after-edit respond", () => {
  test("hands each finding to the agent as PostToolUse context", () => {
    const { stdout } = runRespond(ran([finding]), 1, undefined);
    const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /advisory.*\nsrc\/a\.ts:4:1: \[swallowed\] 0\.93 >= 0\.80: Swallowed\?$/su,
    );
  });

  test("says nothing to the agent when there are no findings", () => {
    assert.equal(runRespond(ran([]), 0, undefined).stdout, "");
  });

  test("appends one line per run to runs.jsonl", () => {
    const dataDir = scratch();
    runRespond(ran([finding]), 1, dataDir);
    runRespond(ran([]), 0, dataDir);
    assert.deepStrictEqual(logLines(dataDir), [
      {
        repo: "/repo",
        file: "src/a.ts",
        model: "cloudflare:typesafe/jev",
        exit: 1,
        durationMs: 812,
        hunks: 2,
        requests: 2,
        gatewayHits: 1,
        findings: [{ rule: "swallowed", line: 4, score: 0.93 }],
      },
      {
        repo: "/repo",
        file: "src/a.ts",
        model: "cloudflare:typesafe/jev",
        exit: 0,
        durationMs: 812,
        hunks: 2,
        requests: 2,
        gatewayHits: 1,
        findings: [],
      },
    ]);
  });

  test("an incomplete run logs every reason as its error, keeping the findings it got", () => {
    const dataDir = scratch();
    runRespond(ran([finding], ["timed out", "HTTP 400"]), 2, dataDir);
    const [entry] = logLines(dataDir);
    assert.deepStrictEqual(
      { error: entry?.error, findings: entry?.findings },
      { error: "timed out; HTTP 400", findings: [{ rule: "swallowed", line: 4, score: 0.93 }] },
    );
  });

  test("a run that could not start logs its error, with no model or counts", () => {
    const dataDir = scratch();
    runRespond({ durationMs: 40, error: "no credentials" }, 2, dataDir);
    assert.deepStrictEqual(logLines(dataDir), [
      {
        repo: "/repo",
        file: "src/a.ts",
        model: null,
        exit: 2,
        durationMs: 40,
        hunks: null,
        requests: null,
        gatewayHits: null,
        findings: [],
        error: "no credentials",
      },
    ]);
  });

  test("an incomplete run leaves one line on stderr naming the file and why", () => {
    const { stderr } = runRespond({ durationMs: 40, error: "no credentials" }, 2, undefined);
    assert.equal(stderr, "soft-lint: could not run on src/a.ts: no credentials\n");
  });

  test("without CLAUDE_PLUGIN_DATA it logs nothing and says nothing about it", () => {
    const { status, stderr } = runRespond(ran([]), 0, undefined);
    assert.deepStrictEqual({ status, stderr }, { status: 0, stderr: "" });
  });

  test("a log it cannot write still leaves the agent's context intact", () => {
    const blocker = join(scratch(), "a-file");
    writeFileSync(blocker, "");
    const { status, stdout, stderr } = runRespond(ran([finding]), 1, join(blocker, "data"));
    assert.deepStrictEqual(
      { status, toldAgent: stdout.includes("[swallowed]"), reported: stderr.startsWith("soft-lint: could not write the run log:") },
      { status: 0, toldAgent: true, reported: true },
    );
  });
});
