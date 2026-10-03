/** The pure half of the plugin: which segments to wrap, how, and what to tell the model. */

import type { ShellSegment as Segment } from "../types/index";
import { namesWrapper } from "./shell";

/** The Bash tool's maximum. The default of 120000 returns mid-run and reads like a finished run. */
export const MAX_TIMEOUT_MS = 600_000;

/**
 * The patterns of a `.claude/cpu-lock` file, each anchored at the start of a command: one extended
 * regex per line, blank lines and `#` comments skipped.
 */
export function gatePatterns(text: string): readonly RegExp[] {
  return text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => new RegExp(`^(${line})`));
}

/** `path` as one shell word: bare when it holds nothing the shell would read, else single-quoted. */
export function shellWord(path: string): string {
  if (/^[A-Za-z0-9_./+@%:=,-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * `command` with `wrapper` inserted at the command word of every segment a pattern gates, or null
 * when none is gated. A segment that already runs through a `cpu-lock.sh` is left alone.
 *
 * The wrapper goes at the command word, so an assignment, `env` or a keyword before it still
 * applies to the run.
 */
export function wrapGated(
  command: string,
  segments: readonly Segment[],
  patterns: readonly RegExp[],
  wrapper: string,
): string | null {
  const starts = segments.flatMap((segment) => {
    const word = segment.words[segment.commandIndex];
    return word !== undefined && isGated(segment, patterns) ? [word.start] : [];
  });
  if (starts.length === 0) return null;

  // Insert from the end so an earlier insertion does not move a later offset.
  let wrapped = command;
  for (const at of [...starts].reverse()) {
    wrapped = `${wrapped.slice(0, at)}${wrapper} ${wrapped.slice(at)}`;
  }
  return wrapped;
}

/**
 * A pattern matches the segment as `cpu-lock.sh` sees it, its words from the command word on
 * joined by single spaces, and no wrapper precedes the command word already.
 */
function isGated(segment: Segment, patterns: readonly RegExp[]): boolean {
  if (segment.words.slice(0, segment.commandIndex).some(namesWrapper)) return false;
  const text = segment.words
    .slice(segment.commandIndex)
    .map((word) => word.value)
    .join(" ");
  return patterns.some((pattern) => pattern.test(text));
}

/** The timeout a wrapped call runs with: the Bash maximum for a foreground call that set none. */
export function wrappedTimeout(call: {
  readonly timeout?: number;
  readonly run_in_background?: boolean;
}): number | undefined {
  if (call.run_in_background === true || call.timeout !== undefined) return call.timeout;
  return MAX_TIMEOUT_MS;
}

/**
 * What the model should know before a run that will queue: that it waits, and the queue as
 * `cpu-lock.sh --status` reported it when the call started.
 */
export function queueNote(status: string, wrapper: string): string {
  return (
    "cpu-lock: another run held the lock when this call started, so this run waits until the runs " +
    `ahead of it finish. \`${wrapper} --status\` said then:\n${status.trimEnd()}`
  );
}
