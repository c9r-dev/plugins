/*
 * Splits a hunk longer than a request may carry into windows that each fit, so every added line is judged. `git diff -W`
 * widens a hunk to its enclosing function, or to the whole file when it finds none (a Vue template, a new file), so a
 * small change can sit thousands of characters into its hunk.
 */
import { newSideLineNumbers } from "./diff.ts";
import type { Hunk } from "./diff.ts";

const TRUNCATED = "…truncated";

const omitted = (count: number): string => `… ${count} ${count === 1 ? "line" : "lines"} omitted …`;

/**
 * The hunk itself when it fits in `maxChars`; else windows of it, each at most `maxChars`, in hunk order. Every added
 * line is in exactly one window, together with the added lines after it that fit, then as much context around them as
 * fits, nearest lines first. A window keeps the hunk's header and marks the lines it leaves out on either side. An added
 * line too long for any window goes alone and is cut, with a `…truncated` marker: the only text soft-lint ever cuts.
 * Throws when `maxChars` cannot hold even the start of such a line beside the header and markers.
 */
export function windowsOf(hunk: Hunk, maxChars: number): Hunk[] {
  if (hunk.text.length <= maxChars) {
    return [hunk];
  }
  const [header = "", ...body] = hunk.text.split("\n");
  const lineNumbers = newSideLineNumbers(hunk.text);
  const added = body.flatMap((line, index) => (line.startsWith("+") ? [index] : []));
  /* offsets[i] is the length of body lines 0..i-1, each with the newline that joins it on. */
  const offsets = [0];
  for (const line of body) {
    offsets.push((offsets.at(-1) ?? 0) + line.length + 1);
  }
  const at = (index: number): number => offsets[index] ?? 0;
  const markerLength = (count: number): number => (count === 0 ? 0 : omitted(count).length + 1);
  /* The length of the window holding body lines start..end-1. */
  const length = (start: number, end: number): number =>
    header.length + at(end) - at(start) + markerLength(start) + markerLength(body.length - end);
  const render = (start: number, end: number, lines: readonly string[]): string =>
    [
      header,
      ...(start > 0 ? [omitted(start)] : []),
      ...lines,
      ...(end < body.length ? [omitted(body.length - end)] : []),
    ].join("\n");

  const windows: Hunk[] = [];
  let next = 0;
  while (next < added.length) {
    const first = added[next] ?? 0;
    const firstAddedLine = lineNumbers[first] ?? 0;
    const line = body[first] ?? "";
    /* Context may reach back past the previous window's added lines, but never take one in. */
    const floor = next === 0 ? 0 : (added[next - 1] ?? 0) + 1;
    next += 1;
    if (length(first, first + 1) > maxChars) {
      const room = maxChars - (length(first, first + 1) - line.length) - TRUNCATED.length;
      if (room < 1) {
        throw new Error(`soft-lint: maxHunkChars ${maxChars} cannot hold any of line ${firstAddedLine} of its hunk`);
      }
      windows.push({ text: render(first, first + 1, [`${line.slice(0, room)}${TRUNCATED}`]), firstAddedLine });
      continue;
    }
    let end = first + 1;
    while (next < added.length && length(first, (added[next] ?? 0) + 1) <= maxChars) {
      end = (added[next] ?? 0) + 1;
      next += 1;
    }
    const ceiling = next < added.length ? (added[next] ?? 0) : body.length;
    let start = first;
    let grew = true;
    while (grew) {
      grew = false;
      if (start > floor && length(start - 1, end) <= maxChars) {
        start -= 1;
        grew = true;
      }
      if (end < ceiling && length(start, end + 1) <= maxChars) {
        end += 1;
        grew = true;
      }
    }
    windows.push({ text: render(start, end, body.slice(start, end)), firstAddedLine });
  }
  return windows;
}
