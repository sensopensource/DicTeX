import { test } from "node:test";
import assert from "node:assert/strict";

import { diffWords } from "./textDiff.js";

function render(segments: ReturnType<typeof diffWords>): string {
  return segments.map((segment) => `[${segment.kind}:${segment.text}]`).join("");
}

test("diffWords: identical strings produce a single equal segment", () => {
  const segments = diffWords("x au carré", "x au carré");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "equal");
  assert.equal(segments[0].text, "x au carré");
});

test("diffWords: the design doc's own example (regex handles 'au carré', not 'plus deux')", () => {
  // Matches docs/dataset-and-normalization-design.md §7's worked example.
  const before = "retour à la ligne x au carré plus deux";
  const after = "retour à la ligne x² plus deux";
  const segments = diffWords(before, after);

  // "retour à la ligne " and " plus deux" are shared; "x au carré" -> "x²" is
  // one whole-token substitution (word-level diff never matches "x" against
  // "x²" as a partial token).
  const removedText = segments
    .filter((segment) => segment.kind === "removed")
    .map((segment) => segment.text)
    .join("");
  assert.ok(removedText.includes("au carré"), render(segments));
  const addedText = segments
    .filter((segment) => segment.kind === "added")
    .map((segment) => segment.text)
    .join("");
  assert.ok(addedText.includes("²"));
  const equalText = segments
    .filter((segment) => segment.kind === "equal")
    .map((segment) => segment.text)
    .join("");
  assert.ok(equalText.includes("retour à la ligne"));
  assert.ok(equalText.includes("plus deux"));
});

test("diffWords: a pure addition (dictionary/regex inserted new words)", () => {
  const segments = diffWords("dic tex", "DicTeX");
  const removed = segments.filter((segment) => segment.kind === "removed").map((segment) => segment.text);
  const added = segments.filter((segment) => segment.kind === "added").map((segment) => segment.text);
  assert.ok(removed.join("").includes("dic tex"));
  assert.ok(added.join("").includes("DicTeX"));
});

test("diffWords: empty inputs produce no segments", () => {
  assert.deepEqual(diffWords("", ""), []);
});

test("diffWords: everything removed when 'after' is empty", () => {
  const segments = diffWords("x au carré", "");
  assert.ok(segments.every((segment) => segment.kind === "removed"));
});

test("diffWords: everything added when 'before' is empty", () => {
  const segments = diffWords("", "x²");
  assert.ok(segments.every((segment) => segment.kind === "added"));
});

test("diffWords: adjacent same-kind segments are merged into one run", () => {
  const segments = diffWords("a b c", "a x c");
  // "b" removed and "x" added as single tokens, each its own merged run
  // (surrounding equal text on both sides stays merged too).
  const removedSegments = segments.filter((segment) => segment.kind === "removed");
  const addedSegments = segments.filter((segment) => segment.kind === "added");
  assert.equal(removedSegments.length, 1);
  assert.equal(addedSegments.length, 1);
  assert.equal(removedSegments[0].text, "b");
  assert.equal(addedSegments[0].text, "x");
});
