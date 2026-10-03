import { describe, expect, test } from "claude-code/testing";
import { parse } from "../hooks/shell";
import { gatePatterns, parseLockRecord, queueNote, shellWord, wrapGated, wrappedTimeout } from "../hooks/wrap";

const W = "/opt/cpu-lock/cpu-lock.sh";

const NX = gatePatterns(
  [
    "# Long-lived servers stay unlocked.",
    "((npx|yarn( run)?) )?nx (test|typecheck|lint|build|e2e|affected|run-many)(:| |$)",
    "((npx|yarn( run)?) )?nx run (format|check)( |$)",
  ].join("\n"),
);

const CARGO = gatePatterns("cargo (test|build|clippy|bench|run)( |$)");

/** The command wrapped under `patterns`, or the original when nothing is gated. */
function wrap(command: string, patterns = NX): string {
  const parsed = parse(command);
  if (!parsed.ok) throw new Error(`did not parse: ${parsed.error}`);
  return wrapGated(command, parsed.segments, patterns, W) ?? command;
}

describe("wrapping", () => {
  test("wraps a gated command at its command word", () => {
    expect(wrap("nx test:unit app")).toEqual(`${W} nx test:unit app`);
  });

  test("wraps the spellings a pattern names", () => {
    expect(wrap("yarn run nx build app")).toEqual(`${W} yarn run nx build app`);
    expect(wrap("npx nx test:unit app")).toEqual(`${W} npx nx test:unit app`);
  });

  test("wraps `nx run format`", () => {
    expect(wrap("nx run format")).toEqual(`${W} nx run format`);
  });

  test("matches words the source spaced unevenly", () => {
    expect(wrap("nx   build\tapp")).toEqual(`${W} nx   build\tapp`);
  });

  test("keeps a pipeline outside the wrapper's own arguments", () => {
    expect(wrap("cargo test --workspace 2>&1 | tee /tmp/t.txt", CARGO)).toEqual(
      `${W} cargo test --workspace 2>&1 | tee /tmp/t.txt`,
    );
  });

  test("wraps every gated segment, not only the first", () => {
    expect(wrap("nx build a && nx build b")).toEqual(`${W} nx build a && ${W} nx build b`);
  });

  test("wraps a gated run inside a loop at its command word", () => {
    expect(wrap("for p in a b; do nx build $p; done")).toEqual(`for p in a b; do ${W} nx build $p; done`);
  });

  test("wraps after a leading assignment, env, the time keyword and a redirection", () => {
    expect(wrap("NX_DAEMON=false nx build app")).toEqual(`NX_DAEMON=false ${W} nx build app`);
    expect(wrap("env NX_DAEMON=false nx build app")).toEqual(`env NX_DAEMON=false ${W} nx build app`);
    expect(wrap("time nx build app")).toEqual(`time ${W} nx build app`);
    expect(wrap("2>/dev/null nx build app")).toEqual(`2>/dev/null ${W} nx build app`);
  });

  test("wraps nothing no pattern matches", () => {
    expect(wrap("nx dev app")).toEqual("nx dev app");
  });

  test("wraps nothing without patterns", () => {
    expect(wrap("nx build app", [])).toEqual("nx build app");
  });

  test("leaves a command named only inside a quoted string or a heredoc body alone", () => {
    expect(wrap(`echo "run nx test:unit app"`)).toEqual(`echo "run nx test:unit app"`);
    const heredoc = "cat <<'EOF' > ci.sh\nnx build app\nEOF";
    expect(wrap(heredoc)).toEqual(heredoc);
  });
});

describe("an already wrapped command", () => {
  test("is not wrapped again, by this wrapper's path or another's", () => {
    expect(wrap(`${W} nx test:unit app`)).toEqual(`${W} nx test:unit app`);
    expect(wrap("~/.claude/scripts/cpu-lock.sh cargo test", CARGO)).toEqual(
      "~/.claude/scripts/cpu-lock.sh cargo test",
    );
  });

  test("is not wrapped again behind an assignment", () => {
    expect(wrap(`NX_DAEMON=false ${W} nx build app`)).toEqual(`NX_DAEMON=false ${W} nx build app`);
  });

  test("leaves the unwrapped segment beside it to be wrapped", () => {
    expect(wrap(`${W} nx build a && nx build b`)).toEqual(`${W} nx build a && ${W} nx build b`);
  });
});

describe("the wrapper's path", () => {
  test("stands bare when the shell would read nothing in it", () => {
    expect(shellWord("/Users/a/.claude/plugins/cache/cpu-lock/cpu-lock/0.1.0/cpu-lock.sh")).toEqual(
      "/Users/a/.claude/plugins/cache/cpu-lock/cpu-lock/0.1.0/cpu-lock.sh",
    );
  });

  test("is single-quoted when it holds a space or a quote", () => {
    expect(shellWord("/opt/it's here/cpu-lock.sh")).toEqual(`'/opt/it'\\''s here/cpu-lock.sh'`);
  });

  test("quoted, still parses back to the path", () => {
    const path = "/opt/it's here/cpu-lock.sh";
    const parsed = parse(`${shellWord(path)} cargo test`);
    expect(parsed.ok && parsed.segments[0]?.words[0]?.value).toEqual(path);
  });
});

describe("the timeout", () => {
  test("is the Bash maximum for a foreground call that set none", () => {
    expect(wrappedTimeout({})).toEqual(600000);
  });

  test("is the caller's own when it set one", () => {
    expect(wrappedTimeout({ timeout: 90_000 })).toEqual(90_000);
  });

  test("is left unset on a backgrounded run", () => {
    expect(wrappedTimeout({ run_in_background: true })).toEqual(undefined);
  });
});

describe("patterns", () => {
  test("skip comments and blank lines, and anchor each at the command's start", () => {
    expect(gatePatterns("# heavy\n\ncargo test( |$)\n").map((p) => p.source)).toEqual(["^(cargo test( |$))"]);
  });
});

describe("the queue note", () => {
  const holder = parseLockRecord(
    "pid:      4242\nworktree: /Users/c/projects/app/worktrees/3-green\ncommand:  nx test:e2e app\nepoch:    1000\nbudget:   900\n",
  );

  test("names the holder, how long it has held, its budget and the queue ahead", () => {
    expect(queueNote({ holder, waiting: 2, nowSeconds: 1120 }, W)).toEqual(
      "cpu-lock: when this call started, 3-green's `nx test:e2e app` held the lock for 120s of a 900s budget, " +
        `with 2 more queued ahead. This run waits until those finish; \`${W} --status\` shows the queue.`,
    );
  });

  test("leaves out what the holder's record does not say", () => {
    expect(queueNote({ holder: { command: "cargo test" }, waiting: 0, nowSeconds: 1120 }, W)).toEqual(
      "cpu-lock: when this call started, ?'s `cargo test` held the lock. This run waits until those finish; " +
        `\`${W} --status\` shows the queue.`,
    );
  });
});
