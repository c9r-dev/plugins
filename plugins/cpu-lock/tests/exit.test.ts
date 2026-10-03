import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";

const HOME = "/home/a";
const SESSION = "this-session";

type Lock = {
  /** The text of `cpu.holder`; absent when nobody holds the lock. */
  readonly holder?: string;
  /** Each waiter's pid, its file's name, with the file's text. */
  readonly waiters: Readonly<Record<string, string>>;
  /** The pids `kill -0` finds alive. */
  readonly alive: readonly string[];
};

const record = (pid: string, session: string) => `pid:      ${pid}\nsession:  ${session}\ncommand:  cargo test\n`;

/**
 * Fakes the host beneath the plugin, with the lock's records under `lockDir`, and hands back the
 * argv of each `sh` it ran.
 */
function host(on: On, lock: Lock, lockDir = `${HOME}/.cache/cpu-lock`): () => readonly (readonly string[])[] {
  const shells: (readonly string[])[] = [];
  const ran = (exitCode: number) => ({
    value: { exitCode, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
  });
  on("process.run", (_$, e) => {
    if (e.argv[0] === "kill") return ran(lock.alive.includes(e.argv[2] ?? "") ? 0 : 1);
    if (e.argv[0] === "sh") shells.push(e.argv);
    return ran(0);
  });
  on("fs.exists", (_$, e) => ({
    value: (e.path === `${lockDir}/cpu.holder` && lock.holder !== undefined) || e.path === `${lockDir}/waiters`,
  }));
  on("fs.list", () => ({
    value: Object.keys(lock.waiters).map((name) => ({ name, kind: "file", size: 0, mtimeMs: 0, isLink: false })),
  }));
  on("fs.read", (_$, e) => {
    if (e.path === `${lockDir}/cpu.holder` && lock.holder !== undefined) return { value: lock.holder };
    const waiter = lock.waiters[e.path.slice(`${lockDir}/waiters/`.length)];
    if (waiter === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: waiter };
  });
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  return () => shells;
}

const end = (reason: "prompt_input_exit" | "clear" | "resume") => ({
  reason,
  sessionId: SESSION,
  resume: { id: SESSION },
});

/** The pids the one detached `sh` was handed to cancel, waiters first. */
function cancelled(shells: readonly (readonly string[])[]): readonly string[] {
  expect(shells.length).toEqual(1);
  const [argv] = shells;
  expect(argv?.[3]).toMatch(/^\/.*\/cpu-lock\.sh$/);
  return argv?.slice(4) ?? [];
}

describe("on exit", () => {
  test("cancels this session's live waiters, then its live holder, and no one else's", async ($, on) => {
    mock.env(on, { HOME });
    const shells = host(on, {
      holder: record("100", SESSION),
      waiters: { "200": record("200", SESSION), "300": record("300", "other"), "400": record("400", SESSION) },
      alive: ["100", "200", "300"],
    });
    await $.session.end(end("prompt_input_exit"));
    expect(cancelled(shells())).toEqual(["200", "100"]);
  });

  test("detaches the cancels, so they outlive the session's last 1.5 s", async ($, on) => {
    mock.env(on, { HOME });
    const shells = host(on, { holder: record("100", SESSION), waiters: {}, alive: ["100"] });
    await $.session.end(end("prompt_input_exit"));
    expect(shells()[0]?.slice(0, 3)).toEqual([
      "sh",
      "-c",
      `nohup sh -c 'for p in "$@"; do "$0" --cancel "$p"; done' "$0" "$@" >/dev/null 2>&1 &`,
    ]);
  });

  test("reads the records where XDG_CACHE_HOME puts them", async ($, on) => {
    mock.env(on, { HOME, XDG_CACHE_HOME: "/cache" });
    const shells = host(on, { holder: record("100", SESSION), waiters: {}, alive: ["100"] }, "/cache/cpu-lock");
    await $.session.end(end("prompt_input_exit"));
    expect(cancelled(shells())).toEqual(["100"]);
  });

  test("cancels nothing on /clear or /resume, which keep the process and its runs", async ($, on) => {
    mock.env(on, { HOME });
    const shells = host(on, { holder: record("100", SESSION), waiters: {}, alive: ["100"] });
    await $.session.end(end("clear"));
    await $.session.end(end("resume"));
    expect(shells()).toEqual([]);
  });

  test("cancels nothing when the session holds no place in the lock", async ($, on) => {
    mock.env(on, { HOME });
    const shells = host(on, { holder: record("100", "other"), waiters: {}, alive: ["100"] });
    await $.session.end(end("prompt_input_exit"));
    expect(shells()).toEqual([]);
  });

  test("cancels nothing for a record whose run has died", async ($, on) => {
    mock.env(on, { HOME });
    const shells = host(on, { holder: record("100", SESSION), waiters: { "200": record("200", SESSION) }, alive: [] });
    await $.session.end(end("prompt_input_exit"));
    expect(shells()).toEqual([]);
  });
});
