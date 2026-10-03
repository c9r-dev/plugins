import type { Plugin } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import type { ShellParse } from "../types/index";
import { intercept, WRAPPED } from "./host";

const CARGO = "# heavy\ncargo (test|build|clippy|bench|run)( |$)\n";

describe("the Bash tool.call hook", () => {
  test("wraps a gated command in the plugin's own cpu-lock.sh, with the maximum timeout", async ($, on) => {
    const last = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: "cargo test --workspace" });
    expect(last().command).toMatch(WRAPPED("cargo test --workspace"));
    expect(last().timeout).toEqual(600000);
  });

  test("wraps nothing in a repo without a cpu-lock file", async ($, on) => {
    const last = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "cargo test --workspace" });
    expect(last()).toEqual({ command: "cargo test --workspace", timeout: undefined, run_in_background: undefined });
  });

  test("wraps nothing outside a repo", async ($, on) => {
    const last = intercept(on, { gates: CARGO, outsideRepo: true });
    await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(last().command).toEqual("cargo test");
  });

  test("passes a command it cannot parse through unchanged", async ($, on) => {
    const last = intercept(on, { gates: CARGO });
    await $.tool.call({ tool: "Bash", command: `cargo test "unterminated` });
    expect(last().command).toEqual(`cargo test "unterminated`);
  });

  test("notes the live holder and the live runs queued ahead of a run it wraps", async ($, on) => {
    mock.clock(on, { now: 1_120_000 });
    const last = intercept(on, {
      gates: CARGO,
      lock: {
        holder: "pid:      4242\nworktree: /work/worktrees/3-green\ncommand:  nx test:e2e app\nepoch:    1000\nbudget:   900\n",
        waiters: ["5000", "5001"],
        alive: ["4242", "5000"],
      },
    });
    const result = await $.tool.call({ tool: "Bash", command: "cargo test" });
    const wrapper = WRAPPED("cargo test").exec(last().command)?.[1];
    expect(result.context).toEqual([
      "cpu-lock: when this call started, 3-green's `nx test:e2e app` held the lock for 120s of a 900s budget, " +
        `with 1 more queued ahead. This run waits until those finish; \`${wrapper} --status\` shows the queue.`,
    ]);
  });

  test("notes nothing when the holder's pid is dead", async ($, on) => {
    mock.clock(on, { now: 1_120_000 });
    intercept(on, {
      gates: CARGO,
      lock: { holder: "pid: 4242\ncommand: nx test:e2e app\n", waiters: [], alive: [] },
    });
    const result = await $.tool.call({ tool: "Bash", command: "cargo test" });
    expect(result.context).toEqual(undefined);
  });

  test("notes nothing on a call it did not wrap", async ($, on) => {
    mock.clock(on, { now: 1_120_000 });
    intercept(on, { gates: CARGO, lock: { holder: "pid: 4242\n", waiters: [], alive: ["4242"] } });
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
    const last = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "A=1 nx build app | tee out" });
    const parsed = JSON.parse(last().command) as ShellParse;
    expect(parsed.ok && parsed.segments.map((s) => s.words[s.commandIndex]?.value)).toEqual(["nx", "tee"]);
  });

  test("answers a failure as data rather than throwing", { plugins: [CONSUMER] }, async ($, on) => {
    const last = intercept(on, {});
    await $.tool.call({ tool: "Bash", command: "echo 'open" });
    expect(JSON.parse(last().command)).toEqual({ ok: false, error: "unterminated single quote" });
  });
});
