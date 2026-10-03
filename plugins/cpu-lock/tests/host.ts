/** A fake host beneath the plugin, for the tests that go through `$.tool.call` and `$.session.end`. */
import type { On } from "claude-code";

const REPO = "/work/app";

export type Host = {
  /** The text of `<repo>/.claude/cpu-lock`; absent when the repo has none. */
  readonly gates?: string;
  /** The session runs outside any git repo. */
  readonly outsideRepo?: boolean;
  /** What `cpu-lock.sh --status` reports while a run holds the lock; absent while it is free. */
  readonly held?: string;
};

type Seen = { command: string; timeout?: number; run_in_background?: boolean };

export type Fake = {
  /** What the last Bash call saw after the plugin had its turn. */
  readonly lastCall: () => Seen;
  /** The argv of every process the plugin ran, in order. */
  readonly runs: () => readonly (readonly string[])[];
};

const ran = (exitCode: number, stdout = "") => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

/** Fakes the host beneath the plugin from `host`, so nothing runs, and records what reached it. */
export function intercept(on: On, host: Host): Fake {
  const seen: Seen[] = [];
  const runs: (readonly string[])[] = [];
  const gatesFile = `${REPO}/.claude/cpu-lock`;
  on("session.cwd", () => ({ value: REPO }));
  on("process.run", (_$, e) => {
    runs.push(e.argv);
    if (e.argv[0] === "git") return host.outsideRepo === true ? ran(128) : ran(0, `${REPO}\n`);
    if (e.argv[1] === "--status") return host.held === undefined ? ran(0, "cpu lock is free.\n") : ran(3, host.held);
    return ran(0);
  });
  on("fs.exists", (_$, e) => ({ value: host.gates !== undefined && e.path === gatesFile }));
  on("fs.read", (_$, e) => {
    if (host.gates !== undefined && e.path === gatesFile) return { value: host.gates };
    throw new Error(`ENOENT: ${e.path}`);
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    seen.push({ command: e.command, timeout: e.timeout, run_in_background: e.run_in_background });
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  return {
    lastCall: () => {
      const last = seen.at(-1);
      if (last === undefined) throw new Error("no Bash call reached the bottom hook");
      return last;
    },
    runs: () => runs,
  };
}

/** The plugin's own `cpu-lock.sh` as the wrapper, by absolute path, before `rest`. */
export const WRAPPED = (rest: string) => new RegExp(`^(/[^ ]*/cpu-lock\\.sh) ${rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
