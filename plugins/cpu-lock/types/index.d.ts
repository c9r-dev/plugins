/**
 * The `shell` noun the cpu-lock plugin adds to `$`: a bash lexer that splits a command into simple
 * commands and records where each token sits, so a plugin can splice the original text and leave
 * every byte it did not target alone. A plugin lists `cpu-lock` under `dependencies` in its
 * plugin.json to use it.
 *
 * It is not a shell. A construct it cannot account for comes back as `{ ok: false }`, which a
 * caller should read as "leave this command alone".
 */

export type ShellTokenKind =
  /** A command word or an argument. */
  | "word"
  /** A control operator: `&&`, `||`, `;`, `|`, `&`, a newline, `(`, `)`. */
  | "operator"
  /** A redirection operator (`>`, `2>&1`, `<<TAG`), or the word one consumes. */
  | "redirect"
  /** A heredoc body, from the line after its operator up to and including its tag line. */
  | "heredoc";

export type ShellToken = {
  readonly kind: ShellTokenKind;
  /** The verbatim source slice, quotes and escapes included. */
  readonly text: string;
  /** Offset of the first character in the parsed command. */
  readonly start: number;
  /** Offset just past the last character. */
  readonly end: number;
  /** The text with one level of quoting and escaping removed. */
  readonly value: string;
  /** Any part of the token came from a quote or a backslash escape. */
  readonly quoted: boolean;
  /** The token holds `$…`, `$(…)` or a backtick, so `value` is not the string the shell will see. */
  readonly expands: boolean;
};

/** One simple command: the words between two control operators, with its redirections set aside. */
export type ShellSegment = {
  /** Every token of the segment in source order, redirections and heredoc bodies included. */
  readonly tokens: readonly ShellToken[];
  /** The segment's words alone, in source order. */
  readonly words: readonly ShellToken[];
  /**
   * The index into `words` of the word the segment runs, or -1 when it runs nothing. Leading
   * `VAR=x` assignments, keywords (`do`, `then`, …) and the commands that run the words after them
   * (`env`, `time`, `nice`, `nohup`, a `cpu-lock.sh` wrapper, by any path), with their `-option`
   * words, are looked past, so `env A=1 cpu-lock.sh nx build` runs `nx`. Such a command with nothing
   * after it is the word it runs, as in `cpu-lock.sh --status`. An option's value is not looked
   * past: `nice -n 10 cargo test` reports `10`.
   */
  readonly commandIndex: number;
  readonly start: number;
  readonly end: number;
  /** The control operator that ended the segment, absent on the last one. */
  readonly terminator?: string;
};

/** What `parse` answers: the segments in source order, or why the lexer gave up. */
export type ShellParse =
  | { readonly ok: true; readonly segments: readonly ShellSegment[] }
  | { readonly ok: false; readonly error: string };

export type Shell = {
  /**
   * Splits `command` into simple commands.
   *
   * @example
   * const parsed = await $.shell.parse(e.command)
   * if (!parsed.ok) return next(e)
   */
  parse: (command: string) => Promise<ShellParse>;
};

declare module "claude-code" {
  interface EngineInterface {
    shell: Shell;
  }
}
