/*
 * The after-edit hook's response to one soft-lint run: reads the run's `--json` report on stdin and
 *
 * - prints the findings to stdout as PostToolUse additionalContext, or nothing when there are none;
 * - on exit 2, writes one line to stderr saying why soft-lint could not run;
 * - appends one JSON line describing the run to `$CLAUDE_PLUGIN_DATA/runs.jsonl`, when that variable is set.
 *
 *   node respond.ts <repo root> <repo-relative path> <soft-lint exit code> < report.json
 *
 * The context goes out before the log is written, so a log that cannot be written never changes it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import type { Report, ReportedFinding } from "../report.ts";

const formatFinding = ({ path, line, rule, score, cutoff, question }: ReportedFinding): string =>
  `${path}:${line}:1: [${rule}] ${score.toFixed(2)} >= ${cutoff.toFixed(2)}: ${question}`;

const findingsOf = (report: Report): ReportedFinding[] => ("error" in report ? [] : report.findings);

/** Why the run gave no verdict: the error that stopped it, else every reason a hunk went unchecked. */
const errorOf = (report: Report): string => ("error" in report ? report.error : report.reasons.join("; "));

function printContext(report: Report, path: string): void {
  const findings = findingsOf(report);
  if (findings.length === 0) {
    return;
  }
  const additionalContext =
    `soft-lint findings on your edit to ${path}. They are advisory: a classifier's yes/no on the added lines, not a ` +
    `lint error. Fix the ones you agree with; ignore the rest.\n${findings.map(formatFinding).join("\n")}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));
}

type RunLogEntry = {
  time: string;
  repo: string;
  file: string;
  model: string | null;
  exit: number;
  durationMs: number;
  hunks: number | null;
  requests: number | null;
  gatewayHits: number | null;
  findings: { rule: string; line: number; score: number }[];
  error?: string;
};

function runLogEntry(report: Report, repo: string, file: string, exit: number): RunLogEntry {
  const ran = "error" in report ? null : report;
  const entry: RunLogEntry = {
    time: new Date().toISOString(),
    repo,
    file,
    model: ran?.model ?? null,
    exit,
    durationMs: report.durationMs,
    hunks: ran?.hunks ?? null,
    requests: ran?.requests ?? null,
    gatewayHits: ran?.gatewayHits ?? null,
    findings: findingsOf(report).map(({ rule, line, score }) => ({ rule, line, score })),
  };
  return exit === 2 ? { ...entry, error: errorOf(report) } : entry;
}

function appendRunLog(entry: RunLogEntry, dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, "runs.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    /* Reported, not raised: the run log must never change what the hook tells the agent. */
    console.error(`soft-lint: could not write the run log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const [repo, file, exitArg] = process.argv.slice(2);
if (repo === undefined || file === undefined || exitArg === undefined) {
  throw new Error("usage: node respond.ts <repo root> <repo-relative path> <soft-lint exit code> < report.json");
}
const exit = Number(exitArg);
/* soft-lint's own output, so its shape is trusted; anything else in stdin is a soft-lint crash, which JSON.parse names. */
const report: Report = JSON.parse(await text(process.stdin));
printContext(report, file);
if (exit === 2) {
  console.error(`soft-lint: could not run on ${file}: ${errorOf(report)}`);
}
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
if (dataDir) {
  appendRunLog(runLogEntry(report, repo, file, exit), dataDir);
}
