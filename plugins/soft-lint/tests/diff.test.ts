import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseDiff } from "../diff.ts";

/*
 * Real `git diff` output between two trees: a binary change, a deletion, new files, a rename with an edit, a
 * no-newline change, a deletion-only hunk, two hunks in one file, and paths with a space and a non-ASCII character.
 */
const edgeCases = readFileSync(new URL("edge-cases.diff", import.meta.url), "utf8");
const byPath = new Map(parseDiff(edgeCases).map((file) => [file.path, file]));

const firstLines = (path: string): number[] | undefined =>
  byPath.get(path)?.hunks.map(({ firstAddedLine }) => firstAddedLine);

describe("parseDiff", () => {
  test("keeps only files that survive the diff with added lines, in diff order", () => {
    assert.deepStrictEqual(
      [...byPath.keys()],
      ["café.ts", "multi.txt", "new.ts", "nonl.txt", "renamed-new.ts", "with space.ts"],
    );
  });

  test("a renamed file is reported under its new path", () => {
    assert.deepStrictEqual(firstLines("renamed-new.ts"), [2]);
  });

  test("a quoted non-ASCII path is decoded", () => {
    assert.deepStrictEqual(firstLines("café.ts"), [1]);
  });

  test("the tab git appends to a path holding a space is not part of the path", () => {
    assert.deepStrictEqual(firstLines("with space.ts"), [2]);
  });

  test("each hunk of a file reports its own first added line on the new side", () => {
    assert.deepStrictEqual(firstLines("multi.txt"), [3, 25]);
  });

  test("a new file's first added line is line 1", () => {
    assert.deepStrictEqual(firstLines("new.ts"), [1]);
  });

  test("a no-newline marker stays in the hunk text and does not shift line numbers", () => {
    assert.deepStrictEqual(byPath.get("nonl.txt")?.hunks, [
      {
        firstAddedLine: 2,
        text: [
          "@@ -1,2 +1,3 @@",
          " a",
          "-b",
          String.raw`\ No newline at end of file`,
          "+b",
          "+c",
          String.raw`\ No newline at end of file`,
        ].join("\n"),
      },
    ]);
  });

  test("hunk lines that look like file headers are read as content", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,2 @@",
      "--- old comment",
      "+++ new comment",
      " select 1;",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseDiff(diff), [
      {
        path: "q.sql",
        hunks: [
          {
            firstAddedLine: 1,
            text: ["@@ -1,2 +1,2 @@", "--- old comment", "+++ new comment", " select 1;"].join("\n"),
          },
        ],
      },
    ]);
  });

  test("a diff made without the b/ prefix is rejected", () => {
    const diff = "--- x.ts\n+++ x.ts\n@@ -0,0 +1 @@\n+x\n";
    assert.throws(() => parseDiff(diff), /"b\/" path prefix/u);
  });
});
