/**
 * The bash lexer behind the `shell` noun: enough structure to find a command word and its
 * arguments, and enough source offsets that a rewrite splices the original text and leaves every
 * byte it did not target alone. The types and what each field means are in `types/index.d.ts`.
 */

import type { ShellParse, ShellSegment as Segment, ShellToken as Token } from "../types/index";

/** A construct the lexer cannot account for; `parse` answers it as `{ ok: false }`. */
class ShellParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellParseError";
  }
}

/** A word naming `cpu-lock.sh` by any path, which runs the command after it. */
export function namesWrapper(word: Token): boolean {
  return !word.expands && word.value.split("/").at(-1) === "cpu-lock.sh";
}

/** Splits `command` into simple commands, or says why it cannot. */
export function parse(command: string): ShellParse {
  try {
    return { ok: true, segments: segments(command) };
  } catch (error) {
    if (error instanceof ShellParseError) return { ok: false, error: error.message };
    throw error;
  }
}

const CONTROL_OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "\n"] as const;

/**
 * Shell keywords that introduce a command rather than being one. `commandWord` looks past them so
 * `do sleep 10` reports `sleep`.
 */
const KEYWORDS = new Set(["do", "then", "else", "elif", "!", "{", "}", "time"]);

const isBlank = (c: string): boolean => c === " " || c === "\t";

const isAssignment = (token: Token): boolean =>
  token.kind === "word" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text);

/**
 * Reads one word starting at `i`, stopping at unquoted whitespace or an operator. Returns the word
 * and the offset just past it.
 */
function readWord(source: string, from: number): { token: Token; next: number } {
  let i = from;
  let value = "";
  let quoted = false;
  let expands = false;

  while (i < source.length) {
    const c = source[i] as string;

    if (isBlank(c) || c === "\n") break;
    if (c === "<" || c === ">") break;
    if (c === "(" || c === ")") break;
    if (CONTROL_OPERATORS.some((op) => source.startsWith(op, i))) break;

    if (c === "\\") {
      const escaped = source[i + 1];
      if (escaped === undefined) throw new ShellParseError("trailing backslash");
      quoted = true;
      value += escaped;
      i += 2;
      continue;
    }

    if (c === "'") {
      const close = source.indexOf("'", i + 1);
      if (close === -1) throw new ShellParseError("unterminated single quote");
      quoted = true;
      value += source.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === '"') {
      quoted = true;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const d = source[i] as string;
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === "\\") {
          const escaped = source[i + 1];
          if (escaped === undefined) throw new ShellParseError("trailing backslash");
          value += escaped;
          i += 2;
          continue;
        }
        if (d === "$" || d === "`") expands = true;
        value += d;
        i += 1;
      }
      if (!closed) throw new ShellParseError("unterminated double quote");
      continue;
    }

    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      if (close === -1) throw new ShellParseError("unterminated backtick");
      expands = true;
      value += source.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    if (c === "$" && source[i + 1] === "(") {
      const close = matchParen(source, i + 1);
      expands = true;
      value += source.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    if (c === "$") expands = true;
    value += c;
    i += 1;
  }

  if (i === from) throw new ShellParseError(`empty word at offset ${from}`);

  return {
    token: { kind: "word", text: source.slice(from, i), start: from, end: i, value, quoted, expands },
    next: i,
  };
}

/** Returns the offset of the `)` closing the `(` at `open`, treating quotes as opaque. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === "'" || c === '"') {
      const close = source.indexOf(c, i + 1);
      if (close === -1) throw new ShellParseError("unterminated quote in substitution");
      i = close + 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new ShellParseError("unterminated command substitution");
}

const REDIRECT = /^(?:[0-9]+)?(?:&>>|&>|>>|>\||<<<|<<-|<<|<>|>&|<&|>|<)/;

/** A redirection that names its target inside itself, so no following word belongs to it. */
const SELF_CONTAINED_REDIRECT = /^(?:[0-9]+)?(?:>&|<&)(?:[0-9]+|-)/;

type HeredocPending = { readonly tag: string; readonly stripTabs: boolean };

/** Splits `command` into tokens, in source order, with offsets into `command`. */
function tokenize(command: string): readonly Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: HeredocPending[] = [];
  let i = 0;
  /** The next word is the target of a redirection, so it is not an argument. */
  let expectRedirectTarget = false;

  while (i < command.length) {
    const c = command[i] as string;

    if (isBlank(c)) {
      i += 1;
      continue;
    }

    if (c === "\n") {
      tokens.push(operatorToken(i, "\n"));
      i += 1;
      i = consumeHeredocBodies(command, i, pendingHeredocs, tokens);
      expectRedirectTarget = false;
      continue;
    }

    if (c === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }

    // Every other position has been handled above, so a `#` here starts a word, and an unquoted
    // `#` at a word start comments out the rest of the line.
    if (c === "#" && !expectRedirectTarget) {
      const lineEnd = command.indexOf("\n", i);
      i = lineEnd === -1 ? command.length : lineEnd;
      continue;
    }

    const redirect = expectRedirectTarget ? null : REDIRECT.exec(command.slice(i));
    if (redirect !== null) {
      const op = redirect[0];
      if (op.startsWith("<<") && !op.startsWith("<<<")) {
        i = readHeredocOperator(command, i, op, tokens, pendingHeredocs);
        continue;
      }
      const whole = SELF_CONTAINED_REDIRECT.exec(command.slice(i));
      if (whole !== null) {
        const text = whole[0];
        tokens.push({
          kind: "redirect",
          text,
          start: i,
          end: i + text.length,
          value: text,
          quoted: false,
          expands: false,
        });
        i += text.length;
        continue;
      }
      tokens.push({
        kind: "redirect",
        text: op,
        start: i,
        end: i + op.length,
        value: op,
        quoted: false,
        expands: false,
      });
      i += op.length;
      expectRedirectTarget = true;
      continue;
    }

    const control = CONTROL_OPERATORS.find((op) => op !== "\n" && command.startsWith(op, i));
    if (control !== undefined && !expectRedirectTarget) {
      tokens.push(operatorToken(i, control));
      i += control.length;
      continue;
    }

    if ((c === "(" || c === ")") && !expectRedirectTarget) {
      tokens.push(operatorToken(i, c));
      i += 1;
      continue;
    }

    const { token, next } = readWord(command, i);
    tokens.push(expectRedirectTarget ? { ...token, kind: "redirect" } : token);
    expectRedirectTarget = false;
    i = next;
  }

  if (pendingHeredocs.length > 0) throw new ShellParseError("unterminated heredoc");

  return tokens;
}

function operatorToken(start: number, text: string): Token {
  return {
    kind: "operator",
    text,
    start,
    end: start + text.length,
    value: text,
    quoted: false,
    expands: false,
  };
}

/** Reads a `<<TAG` operator and its tag, queueing the body to be read at the next newline. */
function readHeredocOperator(
  command: string,
  at: number,
  op: string,
  tokens: Token[],
  pending: HeredocPending[],
): number {
  let i = at + op.length;
  while (i < command.length && isBlank(command[i] as string)) i += 1;
  const { token } = readWord(command, i);
  if (token.value === "") throw new ShellParseError("heredoc without a tag");
  pending.push({ tag: token.value, stripTabs: op.endsWith("-") });
  tokens.push({
    kind: "redirect",
    text: command.slice(at, token.end),
    start: at,
    end: token.end,
    value: token.value,
    quoted: token.quoted,
    expands: false,
  });
  return token.end;
}

/** Consumes every queued heredoc body starting at `from`, emitting one token each. */
function consumeHeredocBodies(
  command: string,
  from: number,
  pending: HeredocPending[],
  tokens: Token[],
): number {
  let i = from;
  while (pending.length > 0) {
    const doc = pending.shift() as HeredocPending;
    const start = i;
    let end = -1;
    while (i <= command.length) {
      const lineEnd = command.indexOf("\n", i);
      const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd);
      const compared = doc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (compared === doc.tag) {
        end = lineEnd === -1 ? command.length : lineEnd;
        i = end;
        break;
      }
      if (lineEnd === -1) throw new ShellParseError("unterminated heredoc");
      i = lineEnd + 1;
    }
    if (end === -1) throw new ShellParseError("unterminated heredoc");
    const text = command.slice(start, end);
    tokens.push({
      kind: "heredoc",
      text,
      start,
      end,
      value: text,
      quoted: true,
      expands: false,
    });
  }
  return i;
}

/** Splits `command` into simple commands, one per run of tokens between control operators. */
function segments(command: string): readonly Segment[] {
  const tokens = tokenize(command);
  const result: Segment[] = [];
  let current: Token[] = [];

  const flush = (terminator?: Token): void => {
    if (current.length === 0 && terminator === undefined) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    const words = current.filter((t) => t.kind === "word");
    result.push({
      tokens: current,
      words,
      commandIndex: findCommandIndex(words),
      start: first.start,
      end: last.end,
      ...(terminator === undefined ? {} : { terminator: terminator.text }),
    });
    current = [];
  };

  for (const token of tokens) {
    if (token.kind === "operator" && token.text !== "(" && token.text !== ")") {
      flush(token);
      continue;
    }
    if (token.kind === "operator") {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();

  return result;
}

/**
 * The index into `words` of the word the segment runs: leading `VAR=x` assignments, an `env` and
 * the assignments it carries, shell keywords and a `cpu-lock.sh` wrapper with a command after it
 * are looked past. -1 when the segment runs nothing.
 */
function findCommandIndex(words: readonly Token[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Token;
    if (isAssignment(word)) {
      i += 1;
      continue;
    }
    if (!word.quoted && !word.expands && KEYWORDS.has(word.value)) {
      i += 1;
      continue;
    }
    if (!word.quoted && !word.expands && word.value === "env") {
      i += 1;
      while (i < words.length && isAssignment(words[i] as Token)) i += 1;
      continue;
    }
    if (isWrapperBefore(word, words[i + 1])) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * `word` names the wrapper and `next` is the command it runs. A word starting with `-` is one of
 * the wrapper's own options (`--status`), so the wrapper itself is what runs.
 */
function isWrapperBefore(word: Token, next: Token | undefined): boolean {
  return namesWrapper(word) && next !== undefined && !next.value.startsWith("-");
}
