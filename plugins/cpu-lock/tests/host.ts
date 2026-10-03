/** A fake host beneath the plugin, for the tests that go through `$.tool.call`. */
import type { On } from "claude-code";
import { mock } from "claude-code/testing";

const REPO = "/work/app";
const HOME = "/home/a";
const LOCK_DIR = `${HOME}/.cache/cpu-lock`;

export type Host = {
  /** The text of `<repo>/.claude/cpu-lock`; absent when the repo has none. */
  readonly gates?: string;
  /** The session runs outside any git repo. */
  readonly outsideRepo?: boolean;
  /** What `~/.cache/cpu-lock` holds; absent when nobody holds the lock. */
  readonly lock?: {
    readonly holder: string;
    /** The file names in `waiters/`, each a waiting run's pid. */
    readonly waiters: readonly string[];
    /** The pids `kill -0` finds alive. */
    readonly alive: readonly string[];
  };
};

type Seen = { command: string; timeout?: number; run_in_background?: boolean };

const ran = (exitCode: number, stdout = "") => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

/**
 * Fakes the host beneath the plugin from `host` and answers every Bash call there, so nothing
 * runs; hands back what the last call saw after the plugin had its turn.
 */
export function intercept(on: On, host: Host): () => Seen {
  const seen: Seen[] = [];
  const gatesFile = `${REPO}/.claude/cpu-lock`;
  const holderFile = `${LOCK_DIR}/cpu.holder`;
  const waitersDir = `${LOCK_DIR}/waiters`;
  mock.env(on, { HOME });
  on("session.cwd", () => ({ value: REPO }));
  on("process.run", (_$, e) => {
    if (e.argv[0] === "kill") return ran(host.lock?.alive.includes(e.argv[2] ?? "") ? 0 : 1);
    return host.outsideRepo === true ? ran(128) : ran(0, `${REPO}\n`);
  });
  on("fs.exists", (_$, e) => ({
    value:
      (host.gates !== undefined && e.path === gatesFile) ||
      (host.lock !== undefined && (e.path === holderFile || e.path === waitersDir)),
  }));
  on("fs.read", (_$, e) => {
    if (host.gates !== undefined && e.path === gatesFile) return { value: host.gates };
    if (host.lock !== undefined && e.path === holderFile) return { value: host.lock.holder };
    throw new Error(`ENOENT: ${e.path}`);
  });
  on("fs.list", (_$, e) => {
    if (host.lock === undefined || e.path !== waitersDir) throw new Error(`ENOENT: ${e.path}`);
    return { value: host.lock.waiters.map((name) => ({ name, kind: "file", size: 0, mtimeMs: 0, isLink: false })) };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    seen.push({ command: e.command, timeout: e.timeout, run_in_background: e.run_in_background });
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  return () => {
    const last = seen.at(-1);
    if (last === undefined) throw new Error("no Bash call reached the bottom hook");
    return last;
  };
}

/** The plugin's own `cpu-lock.sh` as the wrapper, by absolute path, before `rest`. */
export const WRAPPED = (rest: string) => new RegExp(`^(/[^ ]*/cpu-lock\\.sh) ${rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
