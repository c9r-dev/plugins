/*
 * Reads a unified diff, as `git diff` prints it, into the changed files and the hunks that add lines. Paths and line
 * numbers are the new side's: what a reader opens after the change.
 */

/** A hunk that adds at least one line. `text` is the hunk as the diff printed it, `@@` header included. */
export type Hunk = { text: string; firstAddedLine: number };

/** A file the diff leaves in place, with the hunks that add lines to it. */
export type ChangedFile = { path: string; hunks: Hunk[] };

type OpenHunk = {
  lines: string[];
  oldLeft: number;
  newLeft: number;
  nextNewLine: number;
  firstAddedLine: number | null;
};

/* `null` path: the diff deletes the file, so nothing on its new side can be reported. */
type OpenFile = { path: string | null; hunks: OpenHunk[] };

const HUNK_HEADER =
  /^@@ -\d+(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/u;

const C_ESCAPES = new Map([
  ["a", 7],
  ["b", 8],
  ["t", 9],
  ["n", 10],
  ["v", 11],
  ["f", 12],
  ["r", 13],
  ['"', 34],
  ["\\", 92],
]);

/** Decodes a path git wrapped in quotes: C escapes, with octal escapes for the bytes of non-ASCII characters. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/u.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const escaped = C_ESCAPES.get(body.charAt(i + 1));
    if (escaped === undefined) {
      throw new Error(`soft-lint: unknown escape in diff path ${quoted}`);
    }
    bytes.push(escaped);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The new-side path from a `+++ ` line, or null for a deleted file. */
function newPath(header: string): string | null {
  /* git ends the line with a tab when the name holds a space, for GNU patch. */
  const raw = header.slice("+++ ".length).replace(/\t$/u, "");
  if (raw === "/dev/null") {
    return null;
  }
  const path = raw.startsWith('"') ? unquote(raw) : raw;
  if (!path.startsWith("b/")) {
    throw new Error(
      `soft-lint: expected a "b/" path prefix, got ${header}. Run git diff without --no-prefix or --dst-prefix.`,
    );
  }
  return path.slice("b/".length);
}

function openHunk(header: string): OpenHunk {
  const groups = HUNK_HEADER.exec(header)?.groups;
  if (groups?.newStart === undefined) {
    throw new Error(`soft-lint: unsupported hunk header ${header}`);
  }
  return {
    lines: [header],
    oldLeft: Number(groups.oldCount ?? 1),
    newLeft: Number(groups.newCount ?? 1),
    nextNewLine: Number(groups.newStart),
    firstAddedLine: null,
  };
}

/** Whether `line` still belongs to `hunk`: the header's line counts are not used up, or it is a no-newline marker. */
const continues = (hunk: OpenHunk, line: string): boolean =>
  hunk.oldLeft > 0 || hunk.newLeft > 0 || line.startsWith("\\");

function consume(hunk: OpenHunk, line: string): void {
  hunk.lines.push(line);
  const marker = line.charAt(0);
  if (marker === "+") {
    hunk.firstAddedLine ??= hunk.nextNewLine;
    hunk.newLeft -= 1;
    hunk.nextNewLine += 1;
  } else if (marker === "-") {
    hunk.oldLeft -= 1;
  } else if (marker === " " || marker === "") {
    /* An empty line is a context line whose leading space was trimmed on the way. */
    hunk.oldLeft -= 1;
    hunk.newLeft -= 1;
    hunk.nextNewLine += 1;
  } else if (marker !== "\\") {
    throw new Error(`soft-lint: unexpected line in hunk: ${line}`);
  }
}

/** The files `diff` leaves in place, each with its hunks that add lines. Files with no such hunk are left out. */
export function parseDiff(diff: string): ChangedFile[] {
  const files: OpenFile[] = [];
  let file: OpenFile | null = null;
  let hunk: OpenHunk | null = null;
  for (const line of diff.split("\n")) {
    if (hunk !== null && continues(hunk, line)) {
      consume(hunk, line);
      continue;
    }
    hunk = null;
    if (line.startsWith("diff ")) {
      file = null;
    } else if (line.startsWith("+++ ")) {
      file = { path: newPath(line), hunks: [] };
      files.push(file);
    } else if (line.startsWith("@@")) {
      if (file === null) {
        throw new Error(`soft-lint: hunk before any +++ header: ${line}`);
      }
      hunk = openHunk(line);
      file.hunks.push(hunk);
    }
  }
  return files.flatMap(({ path, hunks }) => {
    const added = hunks.flatMap(({ lines, firstAddedLine }) =>
      firstAddedLine === null
        ? []
        : [{ text: lines.join("\n"), firstAddedLine }],
    );
    return path === null || added.length === 0 ? [] : [{ path, hunks: added }];
  });
}

/**
 * The new-side line number of each line of a hunk's text after its header, as `parseDiff` counts them: a removed line
 * gets the number of the next line on the new side.
 */
export function newSideLineNumbers(text: string): number[] {
  const [header = "", ...body] = text.split("\n");
  const hunk = openHunk(header);
  return body.map((line) => {
    const number = hunk.nextNewLine;
    consume(hunk, line);
    return number;
  });
}
