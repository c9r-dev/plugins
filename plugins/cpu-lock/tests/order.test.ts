/**
 * Another plugin that rewrites Bash commands may run before or after this one: hooks of plugins in
 * the same tier have no set order. A stand-in for such a plugin, which drops `npx` before `nx`
 * through `$.shell.parse`, loads once outside this plugin (`prepend`) and once inside it
 * (`append`); the command that runs must be the same either way.
 */
import type { Plugin, PluginTier } from "claude-code/testing";
import { describe, expect, test } from "claude-code/testing";
import { intercept, WRAPPED } from "./host";

function dropNpx(tier: PluginTier): Plugin {
  return {
    name: "drop-npx",
    tier,
    register(on) {
      on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        const parsed = await $.shell.parse(e.command);
        if (!parsed.ok) return next(e);
        let command = e.command;
        for (const segment of [...parsed.segments].reverse()) {
          const word = segment.words[segment.commandIndex];
          const following = segment.words[segment.commandIndex + 1];
          if (word?.value === "npx" && following?.value === "nx") {
            command = command.slice(0, word.start) + command.slice(following.start);
          }
        }
        return next({ ...e, command });
      });
    },
  };
}

const NX = "((npx|yarn( run)?) )?nx (test|typecheck|lint|build|e2e)(:| |$)\n";
const CARGO = "cargo (test|build|clippy|bench|run)( |$)\n";

describe("with the stand-in outside this plugin", () => {
  test("npx nx test:unit runs wrapped, without npx", { plugins: [dropNpx("prepend")] }, async ($, on) => {
    const { lastCall } = intercept(on, { gates: NX });
    await $.tool.call({ tool: "Bash", command: "npx nx test:unit app" });
    expect(lastCall().command).toMatch(WRAPPED("nx test:unit app"));
  });

  test("cargo test runs wrapped", { plugins: [dropNpx("prepend")] }, async ($, on) => {
    const { lastCall } = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(lastCall().command).toMatch(WRAPPED("cargo test"));
  });
});

describe("with the stand-in inside this plugin", () => {
  test("npx nx test:unit runs wrapped, without npx", { plugins: [dropNpx("append")] }, async ($, on) => {
    const { lastCall } = intercept(on, { gates: NX });
    await $.tool.call({ tool: "Bash", command: "npx nx test:unit app" });
    expect(lastCall().command).toMatch(WRAPPED("nx test:unit app"));
  });

  test("cargo test runs wrapped", { plugins: [dropNpx("append")] }, async ($, on) => {
    const { lastCall } = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(lastCall().command).toMatch(WRAPPED("cargo test"));
  });
});
