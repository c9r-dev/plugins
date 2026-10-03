import type { CoreEngineInterface, Register } from "claude-code";
import { parse } from "./shell";
import { gatePatterns, queueNote, shellWord, wrapGated, wrappedTimeout } from "./wrap";

type Engine = Pick<CoreEngineInterface, "process" | "fs" | "ui">;

/** What `cpu-lock.sh --status` exits with while a run holds the lock; it exits 0 while it is free. */
const HELD_STATUS = 3;

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

    const script = `${$.plugin.root}/cpu-lock.sh`;
    const wrapper = shellWord(script);
    const command = wrapGated(e.command, parsed.segments, patterns, wrapper);
    if (command === null) return next(e);

    $.ui.log(`cpu-lock: ${clip(e.command)} → ${clip(command)}`);
    const status = await heldStatus($, script);
    const timeout = wrappedTimeout(e);
    const result = await next({ ...e, command, ...(timeout === undefined ? {} : { timeout }) });

    if (status === null || result.deny !== undefined) return result;
    return { ...result, context: [...(result.context ?? []), queueNote(status, wrapper)] };
  });

  // Only an exit ends the process; /clear and /resume keep its background runs alive.
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") return next(e);
    // Detached, so the cancels finish after Claude has gone: a cancel can take seconds, and
    // session.end has 1.5 s. The script and the id are arguments, never spliced into the program.
    await $.process.run([
      "sh",
      "-c",
      `nohup "$0" --cancel-session "$1" >/dev/null 2>&1 &`,
      `${$.plugin.root}/cpu-lock.sh`,
      e.sessionId,
    ]);
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

/** What `cpu-lock.sh --status` reports while a run holds the lock; null while it is free. */
async function heldStatus($: Engine, script: string): Promise<string | null> {
  const status = await $.process.run([script, "--status"]);
  if (status.exitCode === HELD_STATUS) return status.stdout;
  if (status.exitCode !== 0) {
    $.ui.log(`cpu-lock: ${script} --status exited ${status.exitCode}: ${status.stderr.trim()}`);
  }
  return null;
}

function clip(command: string): string {
  const flat = command.replaceAll("\n", "⏎");
  return flat.length <= LOG_WIDTH ? flat : `${flat.slice(0, LOG_WIDTH)}…`;
}
