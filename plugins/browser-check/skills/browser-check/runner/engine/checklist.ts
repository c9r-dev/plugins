import { readFileSync, writeFileSync } from "node:fs";

import type { Page, TestInfo } from "@playwright/test";

import type { QaReport, StepResult } from "./runner";
import { runQaSteps } from "./runner";
import { isDecisive, verdict } from "./verdict";

const pad = (value: string | number, width: number) =>
  String(value).padEnd(width);

const formatRow = ({
  number,
  status,
  kind,
  elapsed_ms,
  settle_ms,
  flag,
  step,
  detail,
}: StepResult) =>
  [
    pad(number, 3),
    pad(flag === "ok" ? status : `${status} (${flag})`, 22),
    pad(kind, 7),
    pad(`${elapsed_ms}ms`, 8),
    pad(`settle ${settle_ms}ms`, 14),
    pad(step.slice(0, 90), 92),
    detail,
  ].join(" ");

const formatReport = ({ steps, usage }: QaReport) =>
  [
    ...steps.map(formatRow),
    `Classifier: ${usage.calls} calls, ${usage.input_tokens} input tokens, ${usage.output_tokens} output tokens`,
  ].join("\n");

/**
 * Run the checklist named by `QA_STEPS_FILE` (one step per line) against `page`, print the report, attach it to
 * the test, and return the steps that decide the result: failed steps the classifier could judge. A flagged step is advisory
 * or handed to the caller, so it is reported but never returned.
 */
export const runChecklist = async (page: Page, testInfo: TestInfo) => {
  const stepsFile = process.env.QA_STEPS_FILE;
  if (!stepsFile) {
    throw new Error(
      "Set QA_STEPS_FILE to the absolute path of a checklist, one step per line",
    );
  }
  const lines = readFileSync(stepsFile, "utf8").split(/\r?\n/);
  /* A trace (DOM snapshots, screenshots, network, per action) can start on any context, so it works in both modes. */
  const tracing = Boolean(process.env.QA_TRACE);
  if (tracing) {
    await page.context().tracing.start({ screenshots: true, snapshots: true });
  }
  const report = await runQaSteps(page, lines, testInfo);
  if (tracing) {
    const path = testInfo.outputPath("qa-trace.zip");
    await page.context().tracing.stop({ path });
    await testInfo.attach("qa-trace", { path, contentType: "application/zip" });
  }

  console.log(formatReport(report));
  const reportPath = testInfo.outputPath("qa-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach("qa-report", {
    path: reportPath,
    contentType: "application/json",
  });
  console.log(`[qa] artifacts in ${testInfo.outputDir}`);
  console.log(verdict(report.steps));
  return report.steps.filter(
    (step) => isDecisive(step) && step.status === "failed",
  );
};
