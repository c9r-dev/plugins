#!/usr/bin/env node
/*
 * soft-lint: asks a classifier plain-English yes/no questions about the lines a diff adds.
 *
 *   git diff -W origin/main...HEAD | soft-lint [--json] rules.json
 *
 * Exit 0: everything checked, no findings. Exit 1: everything checked, findings. Exit 2: soft-lint could not run, or
 * could not check some hunk; any findings it did get are still printed.
 */
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";

import { checkHunk, exitCode } from "./check.ts";
import type { Finding, HunkCheck, HunkToCheck, ClassifierRequest } from "./check.ts";
import { parseDiff } from "./diff.ts";
import { resolveModel } from "./classifier.ts";
import type { Model } from "./classifier.ts";
import type { Report } from "./report.ts";
import { modelFor, parseRules, rulesFor } from "./rules.ts";
import { windowsOf } from "./window.ts";

const CONCURRENT_REQUESTS = 8;

/** Runs `work` over `items`, at most `limit` at a time, keeping the results in input order. */
async function mapConcurrently<T, Result>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  const queue = items.entries();
  /* Workers share one iterator, so each item is taken exactly once; each worker takes the next when it finishes. */
  const worker = async (): Promise<void> => {
    const next = queue.next();
    if (next.done) {
      return;
    }
    const [index, item] = next.value;
    results[index] = await work(item);
    await worker();
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

const formatFinding = ({ path, line, rule, score }: Finding): string =>
  `${path}:${line}:1: [${rule.id}] ${score.toFixed(2)} >= ${rule.cutoff.toFixed(2)}: ${rule.question}`;

const count = (value: number): string => value.toLocaleString("en-GB");

/** Token totals over requests, or null when none reported usage. A request with no reported usage is not zero. */
function tokenTotals(requests: readonly ClassifierRequest[]): string | null {
  const reported = requests.flatMap(({ usage }) =>
    usage === null ? [] : [usage],
  );
  if (reported.length === 0) {
    return null;
  }
  const input = reported.reduce((sum, usage) => sum + usage.input, 0);
  const output = reported.reduce((sum, usage) => sum + usage.output, 0);
  const largest = Math.max(...reported.map((usage) => usage.input));
  const unreported = requests.length - reported.length;
  const gap = unreported > 0 ? `, ${unreported} reported no usage` : "";
  return `input ${count(input)} tokens, output ${count(output)} tokens, largest request ${count(largest)} input tokens${gap}`;
}

/**
 * The request count, the gateway hits among the answered ones, and token totals. Every window of a hunk with a
 * matching rule is one request. Tokens reported on gateway hits are totalled apart, since whether a hit is billed is unverified.
 */
function describeRequests(
  model: string,
  sent: number,
  answered: readonly ClassifierRequest[],
): string {
  const hits = answered.filter(({ gatewayHit }) => gatewayHit);
  const misses = answered.filter(({ gatewayHit }) => !gatewayHit);
  const parts = [`${hits.length} gateway hits`];
  const missTokens = tokenTotals(misses);
  if (missTokens !== null) {
    parts.push(missTokens);
  }
  const hitTokens = tokenTotals(hits);
  if (hitTokens !== null) {
    parts.push(`gateway hits reported ${hitTokens}`);
  }
  return `${sent} requests to ${model} (${parts.join("; ")})`;
}

/**
 * What a run checked: the model asked, the diff's files and hunk count, and each window of a hunk a rule matched with
 * its check.
 */
type Run = {
  model: Model;
  files: number;
  hunks: number;
  toCheck: HunkToCheck[];
  checks: HunkCheck[];
};

async function check(rulesPath: string): Promise<Run> {
  const rulesFile = parseRules(await readFile(rulesPath, "utf8"));
  /* Resolved once up front, so a missing credential or an ambiguous choice stops the run with one message. */
  const model = resolveModel(process.env, modelFor(process.env, rulesFile), "SOFT_LINT_MODEL");
  const options = { ...rulesFile, model };
  const files = parseDiff(await text(process.stdin));
  const toCheck: HunkToCheck[] = files.flatMap(({ path, hunks }) => {
    const rules = rulesFor(options.rules, path);
    return rules.length === 0
      ? []
      : hunks
          .flatMap((hunk) => windowsOf(hunk, options.maxHunkChars))
          .map((window) => ({ path, hunk: window, rules }));
  });
  const checks: HunkCheck[] = await mapConcurrently(
    toCheck,
    CONCURRENT_REQUESTS,
    async (hunk) => await checkHunk(hunk, options),
  );
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  return { model, files: files.length, hunks, toCheck, checks };
}

const findingsOf = (checks: readonly HunkCheck[]): Finding[] =>
  checks.flatMap((check) => (check.ok ? check.findings : []));

const answeredOf = (checks: readonly HunkCheck[]): ClassifierRequest[] =>
  checks.flatMap((check) => (check.ok ? [check.request] : []));

const reasonsOf = (checks: readonly HunkCheck[]): string[] => [
  ...new Set(checks.flatMap((check) => (check.ok ? [] : [check.reason]))),
];

const uncheckedOf = (checks: readonly HunkCheck[]): string[] => [
  ...new Set(checks.flatMap((check) => (check.ok ? [] : [check.path]))),
];

function printHuman({ model, files, toCheck, checks }: Run): void {
  const findings = findingsOf(checks);
  for (const finding of findings) {
    console.log(formatFinding(finding));
  }
  for (const reason of reasonsOf(checks)) {
    console.error(`soft-lint: could not ask the classifier: ${reason}`);
  }
  console.error(
    `soft-lint: ${files} changed files, ${describeRequests(model.name, toCheck.length, answeredOf(checks))}, ${uncheckedOf(checks).length} files not fully checked, ${findings.length} findings`,
  );
}

const reportOf = ({ model, files, hunks, toCheck, checks }: Run, durationMs: number): Report => ({
  durationMs,
  model: model.name,
  files,
  hunks,
  requests: toCheck.length,
  gatewayHits: answeredOf(checks).filter(({ gatewayHit }) => gatewayHit).length,
  findings: findingsOf(checks).map(({ path, line, rule, score }) => ({
    path,
    line,
    rule: rule.id,
    score,
    cutoff: rule.cutoff,
    question: rule.question,
  })),
  unchecked: uncheckedOf(checks),
  reasons: reasonsOf(checks),
});

const USAGE = "usage: git diff -W <base>...HEAD | soft-lint [--json] <rules.json>";

/**
 * The exit code; 2 when soft-lint could not run, e.g. on an unreadable rules file or an unparseable diff. With
 * `--json`, stdout gets one JSON object (a `Report`) in place of the human lines, and stderr nothing.
 */
async function run(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const [rulesPath] = positional;
  if (rulesPath === undefined || positional.length > 1 || positional.some((arg) => arg.startsWith("-"))) {
    console.error(USAGE);
    return 2;
  }
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let checked: Run;
  try {
    checked = await check(rulesPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ durationMs: elapsed(), error: message } satisfies Report));
    } else {
      console.error(message);
    }
    return 2;
  }
  if (json) {
    console.log(JSON.stringify(reportOf(checked, elapsed())));
  } else {
    printHuman(checked);
  }
  return exitCode({ unchecked: uncheckedOf(checked.checks).length, findings: findingsOf(checked.checks).length });
}

process.exitCode = await run(process.argv.slice(2));
