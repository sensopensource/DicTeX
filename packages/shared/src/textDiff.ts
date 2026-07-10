/**
 * Small, dependency-free word-level diff for the Lab dataset builder's
 * Layer 2 prefill (issue #101).
 *
 * A prefilled field invites passive acceptance: showing what the pipeline
 * changed between Layer 1 (the human's literal transcript) and the prefilled
 * Layer 2 (the pipeline's output over Layer 1, with command words spelled
 * out) is what keeps a subtly wrong regex output from being accepted without
 * being seen (see `docs/dataset-and-normalization-design.md` §7).
 *
 * Word-level (not character-level) diff reads closer to how a human parses a
 * correction — a whole word changing (e.g. "carré" -> "²") is one edit, not a
 * handful of confusing single-character ones.
 *
 * Pure and dependency-free (no node built-ins), so it is safe to import from
 * a renderer bundle via the `@dictex/shared/textDiff` subpath. This module
 * never inspects or produces command sentinels — it operates on whatever two
 * strings it is given, after any sentinel handling has already happened.
 */

export type DiffSegmentKind = "equal" | "added" | "removed";

export type DiffSegment = {
  kind: DiffSegmentKind;
  text: string;
};

/** Splits into whitespace runs and non-whitespace runs, keeping both as
 * tokens so segments can be joined back without losing original spacing. */
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * Word-level diff of `before` (e.g. Layer 1) against `after` (e.g. the
 * prefilled Layer 2), via the classic LCS (longest common subsequence)
 * alignment. O(n*m) tokens — plenty fast for one sentence-length transcript,
 * which is all this is ever used on.
 *
 * Returns a flat, ordered list of segments: "removed" (only in `before`),
 * "added" (only in `after`), "equal" (in both). Adjacent segments of the same
 * kind are merged so e.g. a multi-word removal renders as one strikethrough
 * run instead of one per word.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      segments.push({ kind: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      segments.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      segments.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    segments.push({ kind: "removed", text: a[i] });
    i += 1;
  }
  while (j < m) {
    segments.push({ kind: "added", text: b[j] });
    j += 1;
  }

  return mergeAdjacent(segments);
}

function mergeAdjacent(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.kind === segment.kind) {
      last.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}
