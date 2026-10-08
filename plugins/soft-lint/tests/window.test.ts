import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseDiff } from "../diff.ts";
import type { Hunk } from "../diff.ts";
import { windowsOf } from "../window.ts";

const onlyHunk = (diff: string): Hunk => {
  const hunk = parseDiff(diff)[0]?.hunks[0];
  assert.ok(hunk, "the diff has a hunk");
  return hunk;
};

const addedLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("+"));

/*
 * A Vue file: `git diff -W` finds no function around a template change, so the hunk is the whole file, and the one
 * added element sits near its end, at new-side line 302.
 */
const vueHunk = onlyHunk(readFileSync(new URL("vue-template.diff", import.meta.url), "utf8"));
const vueAdded = '+      <StatusText class="ml-2 text-red-500" size="small" text="Over budget" />';

/* A new file of `count` added lines, each `width` characters with its "+". */
function newFile(count: number, width: number): Hunk {
  const lines = Array.from({ length: count }, (_, index) => `+${String(index + 1).padEnd(width - 1, ".")}`);
  return onlyHunk(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,${count} @@
${lines.join("\n")}
`);
}

describe("windowsOf", () => {
  test("a hunk that fits is sent as it is", () => {
    assert.deepStrictEqual(windowsOf(vueHunk, vueHunk.text.length), [vueHunk]);
  });

  test("an added line past the first maxHunkChars characters of a hunk is in a window", () => {
    assert.ok(vueHunk.text.indexOf(vueAdded) > 4000);
    const windows = windowsOf(vueHunk, 4000);
    assert.deepStrictEqual(windows.flatMap(({ text }) => addedLines(text)), [vueAdded]);
  });

  test("a window reports its own first added line, not the hunk's start", () => {
    assert.deepStrictEqual(
      windowsOf(vueHunk, 4000).map(({ firstAddedLine }) => firstAddedLine),
      [302],
    );
  });

  test("a window fills the limit with context nearest its added lines and marks the lines it leaves out", () => {
    const [window] = windowsOf(vueHunk, 4000);
    const lines = window?.text.split("\n") ?? [];
    const added = lines.indexOf(vueAdded);
    assert.deepStrictEqual(
      {
        header: lines[0],
        before: lines[1],
        after: lines.at(-1),
        nearest: [lines[added - 1], lines[added + 1]],
        full: (window?.text.length ?? 0) > 3900,
      },
      {
        header: "@@ -1,336 +1,337 @@",
        /* The hunk ends 35 lines after the added one, so the rest of the limit goes to the lines before it. */
        before: "… 201 lines omitted …",
        after: ' <script setup lang="ts">',
        nearest: ["       <span>{{ t('row.100') }}</span>", "     </div>"],
        full: true,
      },
    );
  });

  test("an all-added hunk several times the limit splits into windows that keep every added line once", () => {
    const hunk = newFile(400, 50);
    const windows = windowsOf(hunk, 4000);
    assert.deepStrictEqual(
      { many: windows.length >= 5, added: windows.flatMap(({ text }) => addedLines(text)) },
      { many: true, added: addedLines(hunk.text) },
    );
  });

  test("every window is within the limit", () => {
    const lengths = [...windowsOf(newFile(400, 50), 4000), ...windowsOf(vueHunk, 1000)].map(({ text }) => text.length);
    assert.deepStrictEqual(lengths.filter((length) => length > 4000), []);
  });

  test("each window of a new file reports the new-side line of its first added line", () => {
    const windows = windowsOf(newFile(400, 50), 4000);
    const expected = windows.map(({ text }) => Number(addedLines(text)[0]?.slice(1).replace(/\.+$/u, "")));
    assert.deepStrictEqual(
      windows.map(({ firstAddedLine }) => firstAddedLine),
      expected,
    );
  });

  test("an added line longer than the limit goes alone in a window, cut at the limit and marked", () => {
    const long = `+${"x".repeat(10_000)}`;
    const hunk = onlyHunk(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,4 @@
 const a = 1;
+const b = 2;
${long}
 export { a };
`);
    const windows = windowsOf(hunk, 1000);
    assert.deepStrictEqual(
      windows.map(({ text, firstAddedLine }) => ({ firstAddedLine, length: text.length, lines: text.split("\n") })),
      [
        {
          firstAddedLine: 2,
          length: "@@ -1,2 +1,4 @@\n const a = 1;\n+const b = 2;\n… 2 lines omitted …".length,
          lines: ["@@ -1,2 +1,4 @@", " const a = 1;", "+const b = 2;", "… 2 lines omitted …"],
        },
        {
          firstAddedLine: 3,
          length: 1000,
          lines: [
            "@@ -1,2 +1,4 @@",
            "… 2 lines omitted …",
            `${long.slice(0, 1000 - "@@ -1,2 +1,4 @@\n… 2 lines omitted …\n\n… 1 line omitted …".length - "…truncated".length)}…truncated`,
            "… 1 line omitted …",
          ],
        },
      ],
    );
  });

  test("a limit too small to hold any of a line fails loud rather than dropping it", () => {
    assert.throws(() => windowsOf(newFile(3, 50), 20), /maxHunkChars 20 cannot hold any of line 1/u);
  });
});
