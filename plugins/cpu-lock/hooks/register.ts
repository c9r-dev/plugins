import type { CoreEngineInterface, Register } from "claude-code";
import { parse } from "./shell";
import type { LockQueue, LockRecord } from "./wrap";
import { gatePatterns, parseLockRecord, queueNote, shellWord, wrapGated, wrappedTimeout } from "./wrap";

type Engine = Pick<CoreEngineInterface, "process" | "fs" | "env" | "clock">;

/** How much of a command either side of the arrow the transcript line shows. */
const LOG_WIDTH = 120;

/**
 * The `shell` noun, the wrapping of every Bash call the repo's `.claude/cpu-lock` gates, and the
 * cancelling of this session's runs when it exits.
 */
export const register: Register = (on) => {
  on("engine.create", async (_$, e, next) => {
    const built = await next(e);
    return { ...built, shell: { parse: async (command: string) => parse(command) } };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const patterns = await patternsOf($, await $.session.cwd());
    if (patterns.length === 0) return next(e);
    const parsed = parse(e.command);
    if (!parsed.ok) return next(e);

    const wrapper = shellWord(`${$.plugin.root}/cpu-lock.sh`);
    const command = wrapGated(e.command, parsed.segments, patterns, wrapper);
    if (command === null) return next(e);

    $.ui.log(`cpu-lock: ${clip(e.command)} → ${clip(command)}`);
    const queue = await queueOf($);
    const timeout = wrappedTimeout(e);
    const result = await next({ ...e, command, ...(timeout === undefined ? {} : { timeout }) });

    if (queue === null || result.deny !== undefined) return result;
    return { ...result, context: [...(result.context ?? []), queueNote(queue, wrapper)] };
  });

  // Only an exit ends the process; /clear and /resume keep its background runs alive.
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") return next(e);
    const dir = await lockDirOf($);
    const pids = dir === null ? [] : (await liveRecords($, dir)).flatMap((record) =>
      record["session"] === e.sessionId && record["pid"] !== undefined ? [record["pid"]] : [],
    );
    if (pids.length > 0) {
      // Detached, so the cancels finish after Claude has gone: a cancel can take seconds, and
      // session.end has 1.5 s. The script and pids are arguments, never spliced into the program.
      await $.process.run([
        "sh",
        "-c",
        `nohup sh -c 'for p in "$@"; do "$0" --cancel "$p"; done' "$0" "$@" >/dev/null 2>&1 &`,
        `${$.plugin.root}/cpu-lock.sh`,
        ...pids,
      ]);
    }
    return next(e);
  });
};

/** The patterns of `<git toplevel>/.claude/cpu-lock` for the repo holding `cwd`; none elsewhere. */
async function patternsOf($: Engine, cwd: string): Promise<readonly RegExp[]> {
  const toplevel = await $.process.run(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (toplevel.exitCode !== 0) return [];
  const file = `${toplevel.stdout.trim()}/.claude/cpu-lock`;
  if (!(await $.fs.exists(file))) return [];
  return gatePatterns(await $.fs.read(file));
}

/** Where `cpu-lock.sh` keeps its records: `${XDG_CACHE_HOME:-$HOME/.cache}/cpu-lock`. */
async function lockDirOf($: Engine): Promise<string | null> {
  const cache = await $.env.get("XDG_CACHE_HOME");
  if (cache !== undefined && cache !== "") return `${cache}/cpu-lock`;
  const home = await $.env.get("HOME");
  return home === undefined ? null : `${home}/.cache/cpu-lock`;
}

const isAlive = async ($: Engine, pid: string | undefined): Promise<boolean> =>
  pid !== undefined && pid !== "" && (await $.process.run(["kill", "-0", pid])).exitCode === 0;

/** The holder's record while its run is alive, else null. */
async function liveHolder($: Engine, dir: string): Promise<LockRecord | null> {
  const file = `${dir}/cpu.holder`;
  if (!(await $.fs.exists(file))) return null;
  const holder = parseLockRecord(await $.fs.read(file));
  return (await isAlive($, holder["pid"])) ? holder : null;
}

/** The pids of the runs waiting for the lock, each named by its file in `waiters/`, alive only. */
async function liveWaiterPids($: Engine, dir: string): Promise<readonly string[]> {
  const waiters = `${dir}/waiters`;
  const entries = (await $.fs.exists(waiters)) ? await $.fs.list(waiters) : [];
  const pids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "file" && (await isAlive($, entry.name))) pids.push(entry.name);
  }
  return pids;
}

/** Every live record: the waiters' and the holder's. A crashed run's record is skipped. */
async function liveRecords($: Engine, dir: string): Promise<readonly LockRecord[]> {
  const waiters: LockRecord[] = [];
  for (const pid of await liveWaiterPids($, dir)) {
    waiters.push(parseLockRecord(await $.fs.read(`${dir}/waiters/${pid}`)));
  }
  const holder = await liveHolder($, dir);
  return holder === null ? waiters : [...waiters, holder];
}

/** The lock as the call found it; null when no live run holds it. */
async function queueOf($: Engine): Promise<LockQueue | null> {
  const dir = await lockDirOf($);
  if (dir === null) return null;
  const holder = await liveHolder($, dir);
  if (holder === null) return null;
  const waiting = (await liveWaiterPids($, dir)).length;
  return { holder, waiting, nowSeconds: Math.floor((await $.clock.now()) / 1000) };
}

function clip(command: string): string {
  const flat = command.replaceAll("\n", "⏎");
  return flat.length <= LOG_WIDTH ? flat : `${flat.slice(0, LOG_WIDTH)}…`;
}
