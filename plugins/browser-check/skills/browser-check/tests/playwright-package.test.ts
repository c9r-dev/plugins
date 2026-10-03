import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "runner", "playwright-package.mjs");

/** A checkout whose node_modules holds @playwright/test at `version`, with an empty subdirectory `app/`. */
function checkoutWith(version: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "playwright-package-")));
  const pkg = join(root, "node_modules", "@playwright", "test");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(root, "app"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", version }));
  return { root, pkg };
}

/** Runs the script with an empty PATH apart from node's own directory, so no global `playwright` is found. */
function resolve(checkout: string) {
  return spawnSync(process.execPath, [SCRIPT, checkout], {
    encoding: "utf8",
    env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` },
  });
}

describe("playwright-package", () => {
  test("prints the package a parent directory's node_modules provides", () => {
    const { root, pkg } = checkoutWith("1.59.0");
    const result = resolve(join(root, "app"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg);
  });

  test("accepts a later major version whose minor is below 59", () => {
    const { root, pkg } = checkoutWith("2.3.0");
    const result = resolve(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg);
  });

  test("refuses a version older than 1.59", () => {
    const { root } = checkoutWith("1.58.2");
    const result = resolve(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /1\.58\.2 .* is too old; browser-check needs 1\.59 or newer/);
  });

  test("stops with how to install one when neither the checkout nor PATH has it", () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "playwright-package-")));
    const result = resolve(empty);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no @playwright\/test in .* or on PATH.*npm install/);
  });
});
