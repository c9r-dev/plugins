// usage: node playwright-package.mjs <checkout>
// Prints the directory of the @playwright/test a --url run uses: the one the checkout resolves (its own or a hoisted
// one in a parent), else the one behind `playwright` on PATH. Exits 2 with what to do when there is none, or when it
// predates ariaSnapshot({ mode: "ai" }), which the runner reads every page through.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MINIMUM = [1, 59];

function stop(message) {
  console.error(`browser-check: ${message}`);
  process.exit(2);
}

/** The package directory @playwright/test resolves to from `dir`, or undefined when Node finds none there. */
function resolveFrom(dir) {
  try {
    return dirname(createRequire(join(dir, "noop.js")).resolve("@playwright/test/package.json"));
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/** The directory of the `playwright` command on PATH with symlinks followed, or undefined when there is none. */
function commandDir() {
  try {
    const command = execFileSync("sh", ["-c", "command -v playwright"], { encoding: "utf8" }).trim();
    return dirname(realpathSync(command));
  } catch (error) {
    if (error.status === 1) return undefined;
    throw error;
  }
}

const checkout = process.argv[2] ?? stop("pass the checkout directory");
const onPath = commandDir();
const pkg = resolveFrom(checkout) ?? (onPath && resolveFrom(onPath));
if (!pkg) {
  stop(
    `no @playwright/test in ${checkout} or on PATH. Pass --worktree for a checkout that has one, ` +
      `or install it: npm install --save-dev @playwright/test (in the checkout) or npm install --global @playwright/test`,
  );
}

const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const [major, minor] = version.split(".").map(Number);
if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) {
  stop(`@playwright/test ${version} at ${pkg} is too old; browser-check needs ${MINIMUM.join(".")} or newer`);
}
console.log(pkg);
