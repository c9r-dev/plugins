import { expect, test } from "@playwright/test";
import { runChecklist } from "./engine/checklist";

/*
 * Any page by URL, with no app fixtures: an app without a login fixture, a preview another worktree serves, a
 * third-party site. The caller owns everything about the target — that it is served, seeded and reachable.
 * `QA_STORAGE_STATE` names a Playwright storage-state file when the caller has prepared a logged-in session;
 * without it the run is anonymous.
 */
/* The browser and viewport come from the config's projects; video must be chosen when the context is created. */
test.use({
  ignoreHTTPSErrors: true,
  storageState: process.env.QA_STORAGE_STATE,
  video: process.env.QA_VIDEO ? "on" : "off",
});

test("QA checklist", async ({ page }, testInfo) => {
  test.setTimeout(10 * 60 * 1000);
  const startUrl = process.env.QA_START_URL;
  if (!startUrl) {
    throw new Error("Set QA_START_URL to the page the checklist starts on");
  }
  await page.goto(startUrl);
  const failures = await runChecklist(page, testInfo);
  /* `QA_HOLD` hands the page to a person where the checklist left it; the run ends when they close it. */
  if (process.env.QA_HOLD && !page.isClosed()) {
    test.setTimeout(0);
    await page.waitForEvent("close", { timeout: 0 });
  }
  expect(failures).toEqual([]);
});
