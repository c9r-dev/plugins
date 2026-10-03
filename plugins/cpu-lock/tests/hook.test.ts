import type { Plugin } from "claude-code/testing";
import { describe, expect, test } from "claude-code/testing";
import type { ShellParse } from "../types/index";
import { intercept, WRAPPED } from "./host";

const CARGO = "# heavy\ncargo (test|build|clippy|bench|run)( |$)\n";

describe("the Bash tool.call hook", () => {
  test("wraps a gated command in the plugin's own cpu-lock.sh, with the maximum timeout", async ($, on) => {
    const { lastCall } = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: "cargo test --workspace" });
    expect(lastCall().command).toMatch(WRAPPED("cargo test --workspace"));
    expect(lastCall().timeout).toEqual(600000);
  });

  test("wraps nothing in a repo without a cpu-lock file", async ($, on) => {
    const { lastCall } = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "cargo test --workspace" });
    expect(lastCall()).toEqual({ command: "cargo test --workspace", timeout: undefined, run_in_background: undefined });
  });

  test("wraps nothing outside a repo", async ($, on) => {
    const { lastCall } = intercept(on, { gates: CARGO, outsideRepo: true });
    await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(lastCall().command).toEqual("cargo test");
  });

  test("passes a command it cannot parse through unchanged", async ($, on) => {
    const { lastCall } = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: `cargo test "unterminated` });
    expect(lastCall().command).toEqual(`cargo test "unterminated`);
  });

  test("notes, on a run it wraps while the lock is held, that it queues and what --status said", async ($, on) => {
    const held = "holding the cpu lock:\nmain  nx test:e2e app\n    held for 120s\nnothing queued.\n";
    const { lastCall } = intercept(on, { gates: CARGO, held });
    const result = await $.tool.call({ tool: "Bash", command: "cargo test" });
    const wrapper = WRAPPED("cargo test").exec(lastCall().command)?.[1];
    expect(result.context).toEqual([
      "cpu-lock: another run held the lock when this call started, so this run waits until the runs ahead of " +
        `it finish. \`${wrapper} --status\` said then:\n${held.trimEnd()}`,
    ]);
  });

  test("notes nothing while the lock is free", async ($, on) => {
    intercept(on, { gates: CARGO });
    const result = await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(result.context).toEqual(undefined);
  });

  test("notes nothing on a call it did not wrap", async ($, on) => {
    intercept(on, { gates: CARGO, held: "holding the cpu lock:\n" });
    const result = await $.tool.call({ tool: "Bash", command: "cargo fmt" });
    expect(result.context).toEqual(undefined);
  });
});

/**
 * A plugin that depends on this one: it runs each Bash command's parse in its place, as JSON, so
 * the test reads what crossed the noun. A test's own `$` holds only the engine's nouns.
 */
const CONSUMER: Plugin = {
  name: "consumer",
  register(on) {
    on("tool.call", { tool: "Bash" }, async ($, e, next) =>
      next({ ...e, command: JSON.stringify(await $.shell.parse(e.command)) }),
    );
  },
};

describe("the shell noun, to another plugin", () => {
  test("answers segments as plain data", { plugins: [CONSUMER] }, async ($, on) => {
    const { lastCall } = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "A=1 nx build app | tee out" });
    const parsed = JSON.parse(lastCall().command) as ShellParse;
    expect(parsed.ok && parsed.segments.map((s) => s.words[s.commandIndex]?.value)).toEqual(["nx", "tee"]);
  });

  test("answers a failure as data rather than throwing", { plugins: [CONSUMER] }, async ($, on) => {
    const { lastCall } = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "echo 'open" });
    expect(JSON.parse(lastCall().command)).toEqual({ ok: false, error: "unterminated single quote" });
  });
});
