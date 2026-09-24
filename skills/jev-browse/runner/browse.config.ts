import { defineConfig, devices } from "@playwright/test";

/*
 * Standalone config for browse.spec.ts; the app manifests run under their own project's Playwright config. One
 * project per device so `--project` selects the browser and viewport, with the same names the app configs use.
 */
const PROJECTS = {
  "Desktop-Chromium": devices["Desktop Chrome"],
  "Desktop-Firefox": devices["Desktop Firefox"],
  "Desktop-Webkit": devices["Desktop Safari"],
  "Mobile-Chromium": devices["Pixel 5"],
  "Mobile-Webkit-iPad": devices["iPad (gen 6)"],
  "Mobile-Webkit-iPhone": devices["iPhone 14"],
};

/** `QA_VIEWPORT` as `WIDTHxHEIGHT` overrides the device's own viewport, for checking a specific breakpoint. */
const override = process.env.QA_VIEWPORT?.split("x").map(Number);
const viewport =
  override?.length === 2 && override.every(Boolean)
    ? { width: override[0]!, height: override[1]! }
    : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "browse.spec.ts",
  outputDir: "./test-results",
  reporter: "list",
  workers: 1,
  projects: Object.entries(PROJECTS).map(([name, device]) => ({
    name,
    use: { ...device, ...(viewport ? { viewport } : {}) },
  })),
});
