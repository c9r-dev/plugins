import { describe, expect, test } from "claude-code/testing";
import type { ShellSegment, ShellToken } from "../types/index";
import { parse } from "../hooks/shell";

function segmentsOf(command: string): readonly ShellSegment[] {
  const parsed = parse(command);
  if (!parsed.ok) throw new Error(`did not parse: ${parsed.error}`);
  return parsed.segments;
}

function tokensOf(command: string): readonly ShellToken[] {
  return segmentsOf(command).flatMap((segment) => segment.tokens);
}

/** The value of the word each segment runs, null where it runs nothing. */
function commandWords(command: string): readonly (string | null)[] {
  return segmentsOf(command).map((segment) => segment.words[segment.commandIndex]?.value ?? null);
}

describe("tokens", () => {
  test("keeps a quoted word whole and records that it was quoted", () => {
    const [, quoted] = tokensOf(`echo "git -C /tmp"`);
    expect([quoted?.value, quoted?.quoted]).toEqual(["git -C /tmp", true]);
  });

  test("marks a word holding a command substitution as expanding", () => {
    expect(tokensOf("echo $(date +%s)")[1]?.expands).toEqual(true);
  });

  test("reads a heredoc body as one token that spans to its tag line", () => {
    const body = tokensOf("cat <<EOF\nsleep 600\nEOF\necho done").find((t) => t.kind === "heredoc");
    expect(body?.text).toEqual("sleep 600\nEOF");
  });

  test("reads a quoted heredoc tag and a tab-stripping heredoc", () => {
    const body = tokensOf("cat <<-'EOF'\n\tls\n\tEOF\n").find((t) => t.kind === "heredoc");
    expect(body?.text).toEqual("\tls\n\tEOF");
  });

  test("reads 2>&1 as one redirection, not a word", () => {
    expect(tokensOf("nx build app 2>&1").map((t) => t.text)).toEqual(["nx", "build", "app", "2>&1"]);
  });

  test("reads a redirection target as a redirection, not a word", () => {
    const [segment] = segmentsOf("grep foo > out.txt");
    expect(segment?.words.map((t) => t.value)).toEqual(["grep", "foo"]);
  });

  test("reads an unquoted # at a word start as a comment to the end of the line", () => {
    const segments = segmentsOf("ls -la # then git -C /tmp status\nls");
    expect(segments.map((s) => s.tokens.map((t) => t.text))).toEqual([["ls", "-la"], ["ls"]]);
  });

  test("keeps a # that is not at a word start", () => {
    expect(tokensOf("git show HEAD#1").map((t) => t.text)).toEqual(["git", "show", "HEAD#1"]);
  });

  test("records each token's offsets into the command", () => {
    const command = "a  'b c'";
    expect(tokensOf(command).map((t) => command.slice(t.start, t.end))).toEqual(["a", "'b c'"]);
  });
});

describe("failures, answered as data", () => {
  test("an unterminated quote", () => {
    expect(parse(`echo "oops`)).toEqual({ ok: false, error: "unterminated double quote" });
  });

  test("an unterminated heredoc", () => {
    expect(parse("cat <<EOF\nbody\n").ok).toEqual(false);
  });

  test("an unterminated command substitution", () => {
    expect(parse("echo $(date").ok).toEqual(false);
  });
});

describe("segments", () => {
  test("an empty command has none", () => {
    expect(segmentsOf("")).toEqual([]);
  });

  test("splits on control operators and records each terminator", () => {
    expect(segmentsOf("cd /x && grep -r foo . | wc -l").map((s) => s.terminator)).toEqual([
      "&&",
      "|",
      undefined,
    ]);
  });

  test("does not split inside a quoted string", () => {
    expect(segmentsOf(`echo "a && b"`).length).toEqual(1);
  });
});

describe("the command word", () => {
  test("looks past leading assignments and env", () => {
    expect(commandWords("env FOO=1 BAR=2 ls -la")).toEqual(["ls"]);
  });

  test("looks past a loop keyword so `do sleep 10` runs sleep", () => {
    expect(commandWords("while true; do sleep 10; done")).toEqual(["while", "sleep", "done"]);
  });

  test("reports `command` itself, so `command ls` is not a bare ls", () => {
    expect(commandWords("command ls -la")).toEqual(["command"]);
  });

  test("is absent from a segment of assignments alone", () => {
    expect(commandWords("A=1 B=2")).toEqual([null]);
  });
});

describe("the cpu-lock.sh wrapper", () => {
  test("is looked past by any path, so the command it runs is the command word", () => {
    expect(commandWords("~/.claude/scripts/cpu-lock.sh npx nx test:unit app")).toEqual(["npx"]);
    expect(commandWords("cpu-lock.sh cargo test")).toEqual(["cargo"]);
  });

  test("is looked past when quoted, as a path with a space must be", () => {
    expect(commandWords("'/opt/my tools/cpu-lock.sh' cargo test")).toEqual(["cargo"]);
  });

  test("is looked past after assignments, env and a keyword", () => {
    expect(commandWords("time env A=1 /x/cpu-lock.sh nx build app")).toEqual(["nx"]);
  });

  test("is the command word when it runs one of its own options", () => {
    expect(commandWords("cpu-lock.sh --status")).toEqual(["cpu-lock.sh"]);
  });

  test("is the command word when nothing follows it", () => {
    expect(commandWords("cpu-lock.sh")).toEqual(["cpu-lock.sh"]);
  });

  test("is not a file that only ends like it", () => {
    expect(commandWords("my-cpu-lock.sh cargo test")).toEqual(["my-cpu-lock.sh"]);
  });
});
