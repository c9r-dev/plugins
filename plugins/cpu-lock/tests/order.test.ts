/**
 * Another plugin that rewrites Bash commands may run before or after this one: hooks of plugins in
 * the same tier have no set order. A stand-in for such a plugin, which rewrites `make check` to
 * `make test` through `$.shell.parse`, loads once outside this plugin (`prepend`) and once inside
 * it (`append`); the command that runs must be the same either way.
 */
import type { Plugin, PluginTier } from "claude-code/testing";
import { describe, expect, test } from "claude-code/testing";
import { intercept, WRAPPED } from "./host";

function checkToTest(tier: PluginTier): Plugin {
  return {
    name: "check-to-test",
    tier,
    register(on) {
      on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        const parsed = await $.shell.parse(e.command);
        if (!parsed.ok) return next(e);
        let command = e.command;
        for (const segment of [...parsed.segments].reverse()) {
          const word = segment.words[segment.commandIndex];
          const target = segment.words[segment.commandIndex + 1];
          if (word?.value === "make" && target?.value === "check") {
            command = command.slice(0, target.start) + "test" + command.slice(target.end);
          }
        }
        return next({ ...e, command });
      });
    },
  };
}

const MAKE = "make (check|test|build)( |$)\n";

for (const tier of ["prepend", "append"] as const) {
  describe(`with the stand-in ${tier === "prepend" ? "outside" : "inside"} this plugin`, () => {
    test("make check runs wrapped, as make test", { plugins: [checkToTest(tier)] }, async ($, on) => {
      const { lastCall } = intercept(on, { gates: MAKE });
      await $.tool.call({ tool: "Bash", command: "make check" });
      expect(lastCall().command).toMatch(WRAPPED("make test"));
    });

    test("a command the stand-in leaves alone runs wrapped", { plugins: [checkToTest(tier)] }, async ($, on) => {
      const { lastCall } = intercept(on, { gates: MAKE });
      await $.tool.call({ tool: "Bash", command: "make build" });
      expect(lastCall().command).toMatch(WRAPPED("make build"));
    });
  });
}
