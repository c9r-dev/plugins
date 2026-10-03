import { existsSync } from "node:fs";
import { expect, test, type PlaywrightWorkerArgs } from "@playwright/test";
import { version } from "@playwright/test/package.json";
import { runChecklist } from "./engine/checklist";

/*
 * Any page by URL, with no app fixtures: an app without a login fixture, a preview another worktree serves, a
 * third-party site. The caller owns everything about the target — that it is served, seeded and reachable.
 * `QA_STORAGE_STATE` names a Playwright storage-state file when the caller has prepared a logged-in session;
 * without it the run is anonymous.
 */
type BrowserName = "chromium" | "firefox" | "webkit";

/**
 * The browser a project runs in, from what is already installed: Playwright's own build for this version, else for
 * Chromium projects the installed Google Chrome (a separate instance with a fresh temporary profile). Nothing is
 * installed for the caller; with neither present the run stops with the one command that fixes it.
 */
async function channelFor(browserName: BrowserName, playwright: PlaywrightWorkerArgs["playwright"]) {
  const install = `npx playwright@${version} install ${browserName}`;
  if (existsSync(playwright[browserName].executablePath())) {
    /* The "chromium" channel runs headless on the full build just checked, not the separate headless shell. */
    return browserName === "chromium" ? "chromium" : undefined;
  }
  if (browserName !== "chromium") {
    throw new Error(`Playwright ${version} has no ${browserName} build installed. Install it: ${install}`);
  }
  try {
    await (await playwright.chromium.launch({ channel: "chrome" })).close();
  } catch (error) {
    throw new Error(
      `Playwright ${version} has no Chromium build installed, and Google Chrome did not launch. Install Playwright's Chromium: ${install}`,
      { cause: error },
    );
  }
  return "chrome";
}

/* The browser and viewport come from the config's projects; video must be chosen when the context is created. */
test.use({
  channel: [
    async ({ browserName, playwright }, use) => {
      const channel = await channelFor(browserName, playwright);
      console.log(`[qa] browser ${channel === "chrome" ? "Google Chrome" : `Playwright ${version} ${browserName}`}`);
      await use(channel);
    },
    { scope: "worker" },
  ],
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
