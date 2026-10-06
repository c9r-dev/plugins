#!/usr/bin/env node
/*
 * soft-lint: asks a classifier plain-English yes/no questions about the lines a diff adds.
 *
 *   git diff -W origin/main...HEAD | soft-lint rules.json
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
import { modelFor, parseRules, rulesFor } from "./rules.ts";

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
 * The request count, the gateway hits among the answered ones, and token totals. Every hunk with a matching rule is
 * one request. Tokens reported on gateway hits are totalled apart, since whether a hit is billed is unverified.
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

async function main(rulesPath: string): Promise<number> {
  const rulesFile = parseRules(await readFile(rulesPath, "utf8"));
  /* Resolved once up front, so a missing credential or an ambiguous choice stops the run with one message. */
  const model = resolveModel(process.env, modelFor(process.env, rulesFile), "SOFT_LINT_MODEL");
  const options = { ...rulesFile, model };
  const files = parseDiff(await text(process.stdin));
  const toCheck: HunkToCheck[] = files.flatMap(({ path, hunks }) => {
    const rules = rulesFor(options.rules, path);
    return rules.length === 0
      ? []
      : hunks.map((hunk) => ({ path, hunk, rules }));
  });
  const checks: HunkCheck[] = await mapConcurrently(
    toCheck,
    CONCURRENT_REQUESTS,
    async (hunk) => await checkHunk(hunk, options),
  );
  const reasons = new Set<string>();
  const unchecked = new Set<string>();
  const answered: ClassifierRequest[] = [];
  let findings = 0;
  for (const check of checks) {
    if (!check.ok) {
      reasons.add(check.reason);
      unchecked.add(check.path);
      continue;
    }
    answered.push(check.request);
    findings += check.findings.length;
    for (const finding of check.findings) {
      console.log(formatFinding(finding));
    }
  }
  for (const reason of reasons) {
    console.error(`soft-lint: could not ask the classifier: ${reason}`);
  }
  console.error(
    `soft-lint: ${files.length} changed files, ${describeRequests(model.name, toCheck.length, answered)}, ${unchecked.size} files not fully checked, ${findings} findings`,
  );
  return exitCode({ unchecked: unchecked.size, findings });
}

/** The exit code; 2 when soft-lint could not run, e.g. on an unreadable rules file or an unparseable diff. */
async function run(args: readonly string[]): Promise<number> {
  const [rulesPath] = args;
  if (rulesPath === undefined) {
    console.error(
      "usage: git diff -W <base>...HEAD | soft-lint <rules.json>",
    );
    return 2;
  }
  try {
    return await main(rulesPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = await run(process.argv.slice(2));
