import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import type { Page } from "@playwright/test";

/**
 * Judges a visual claim from a screenshot. It may pass the step or hand it back to the caller; it can never fail one.
 * A module named by `QA_VISUAL_JUDGE` provides one as its default export.
 */
export type VisualJudge = (input: {
  claim: string;
  claimNumber: number;
  checklist: string[];
  /**
   * PNG of the full page at CSS scale, `page.screenshot({ fullPage: true, scale: "css" })`: the picture the caller
   * would judge, since a claim such as "no error is shown" can be about anything below the fold. CSS scale keeps a
   * 2× display from quadrupling the image.
   */
  screenshot: Uint8Array;
}) => Promise<{ status: "passed" | "for-caller"; detail: string }>;

export type VisualClaim = { claim: string; claimNumber: number; checklist: string[] };

const HANDED_OVER = "visual claim, handed to the caller with a full-page screenshot";

const loadJudge = async (module: string): Promise<VisualJudge> => {
  if (!isAbsolute(module)) {
    throw new Error(`QA_VISUAL_JUDGE must be an absolute path, not ${module}`);
  }
  const { default: judge } = await import(pathToFileURL(module).href);
  if (typeof judge !== "function") {
    throw new Error(`${module} has no default export function`);
  }
  return judge;
};

/**
 * Asks the judge `QA_VISUAL_JUDGE` names. Without one, or when it fails, the step is handed to the caller with the
 * reason in its detail, so a broken judge costs a picture to look at, never a verdict.
 */
export const judgeVisually = async (
  page: Pick<Page, "screenshot">,
  claim: VisualClaim,
): Promise<{ status: "passed" | "for-caller"; detail: string }> => {
  const module = process.env.QA_VISUAL_JUDGE;
  if (!module) {
    return { status: "for-caller", detail: HANDED_OVER };
  }
  try {
    const judge = await loadJudge(module);
    const { status, detail } = await judge({ ...claim, screenshot: await page.screenshot({ fullPage: true, scale: "css" }) });
    if (status === "passed") {
      return { status, detail: `visual judge: ${detail}` };
    }
    if (status === "for-caller") {
      return { status, detail: `${HANDED_OVER}; visual judge: ${detail}` };
    }
    throw new Error(`returned status "${String(status)}"; a visual judge may only pass a step or hand it back`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "for-caller", detail: `${HANDED_OVER}; visual judge ${module} failed: ${message}` };
  }
};
