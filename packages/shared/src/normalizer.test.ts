import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTranscriptNormalizer, normalizeTranscript, type NormalizeOptions } from "./normalizer.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { canonicalizeLatex } from "./latex.js";

// Points the normalizer at a directory that does not exist: the personal
// dictionary degrades to passthrough (empty) and the rules degrade to the
// built-in `DEFAULT_RULES` — the same pattern `datasetExport.test.ts` and
// `commands.test.ts` use, so this exercises the shipped defaults without
// depending on any on-disk config.
const ABSENT_CONFIG: NormalizeOptions = {
  dictionaryPath: path.join(tmpdir(), "dictex-issue-107-absent", "dictionary.json"),
  rulesPath: path.join(tmpdir(), "dictex-issue-107-absent", "rules.json"),
};

/** Run the full pipeline and return just the regex_rules layer's output — the
 * layer #107 rewrites. Command extraction runs before it (unaffected by this
 * issue) so a literal PUA sentinel can be fed straight in and observed coming
 * back out untouched, exactly like the pipeline serves it in production. */
async function regexLayerOutput(input: string): Promise<string> {
  const result = await normalizeTranscript(input, ABSENT_CONFIG);
  const layer = result.layers.find((entry) => entry.layer === "regex_rules");
  assert.ok(layer, "regex_rules layer present");
  return layer.output;
}

// ── Each default rule emits canonical LaTeX, wrapped in "$…$" (#106/#107) ────
// The expected output of every case here is asserted to be its OWN
// `canonicalizeLatex` fixed point: this is the acceptance criterion from the
// issue ("every rule output survives canonicalizeLatex as a fixed point") and
// it also proves the emitted delimiters/spacing already match §8's style
// subset, so scoring/export never see the rules' output as needing repair.
const RULE_CASES: { name: string; input: string; expected: string }[] = [
  { name: "au carré", input: "x au carré", expected: "$x^{2}$" },
  { name: "au carrée (feminine spelling)", input: "x au carrée", expected: "$x^{2}$" },
  { name: "au cube", input: "x au cube", expected: "$x^{3}$" },
  { name: "puissance n", input: "x puissance n", expected: "$x^{n}$" },
  { name: "racine de", input: "racine de x", expected: "$\\sqrt{x}$" },
  { name: "racine carrée de", input: "racine carrée de x", expected: "$\\sqrt{x}$" },
  { name: "égale", input: "x égale y", expected: "$x = y$" },
  { name: "égal (masculine spelling)", input: "x égal y", expected: "$x = y$" },
  { name: "plus grand que", input: "x plus grand que y", expected: "$x > y$" },
  { name: "plus petit que", input: "x plus petit que y", expected: "$x < y$" },
  { name: "plus", input: "x plus y", expected: "$x + y$" },
  { name: "moins", input: "x moins y", expected: "$x - y$" },
  { name: "fois", input: "x fois y", expected: "$x \\times y$" },
  { name: "divisé par", input: "x divisé par y", expected: "$\\frac{x}{y}$" },
  { name: "divisée par (feminine spelling)", input: "x divisée par y", expected: "$\\frac{x}{y}$" },
  // Digit operands, not just letters.
  { name: "plus, digit operands", input: "2 plus 3", expected: "$2 + 3$" },
  { name: "divisé par, digit operands", input: "12 divisé par 4", expected: "$\\frac{12}{4}$" },
];

for (const { name, input, expected } of RULE_CASES) {
  test(`DEFAULT_RULES: "${name}" fires and emits a canonicalizeLatex fixed point`, async () => {
    const output = await regexLayerOutput(input);
    assert.equal(output, expected);
    // The acceptance criterion: the emitted LaTeX is already canonical.
    assert.equal(canonicalizeLatex(expected), expected);
  });
}

// ── Chaining: composing two rules must still produce ONE merged "$…$" span ──
//
// Rules stay conservative (a regex cannot group/scope, per the issue): each
// individual match's operand is still a single digit run or one letter. What
// makes chaining possible under LaTeX is that the "flat" operator rules
// (égale, >, <, plus, moins, fois — none of which introduce a new brace) also
// accept an entire, already-"$…$"-wrapped fragment as one of their operands.
// Splicing a depth-0 fragment into another depth-0 expression never changes
// its brace depth, so the merged result stays a `canonicalizeLatex` fixed
// point by construction — asserted directly below, not assumed.
test("chaining: 'x au carré plus y' composes into one expression, now canonical LaTeX", async () => {
  const output = await regexLayerOutput("x au carré plus y");
  assert.equal(output, "$x^{2} + y$");
  assert.equal(canonicalizeLatex(output), output);
});

test("chaining: same-operator repetition still collapses via re-passing (MAX_RULE_PASSES)", async () => {
  const output = await regexLayerOutput("1 plus 2 plus 3");
  assert.equal(output, "$1 + 2 + 3$");
  assert.equal(canonicalizeLatex(output), output);
});

test("chaining: mixed operators compose left to right across rules", async () => {
  const output = await regexLayerOutput("x au carré plus y moins z");
  assert.equal(output, "$x^{2} + y - z$");
  assert.equal(canonicalizeLatex(output), output);
});

// ── The hard part: bracing rules stay bare-operand-only (no regex scoping) ──
//
// "au carré"/"cube"/"puissance"/"racine"/"divisé par" all introduce a NEW
// brace around their operand. Accepting an already-composed "$…$" fragment
// there would require the regex to decide where that fragment's scope ends
// inside the new braces — exactly the grouping problem it cannot solve — so,
// unlike the flat operators above, these five stay restricted to one bare
// digit run or one letter. This is a deliberate, accepted limitation (see
// docs/dataset-and-normalization-design.md §7): what the regex cannot reach
// here is precisely the residual layer 3 is for.
test("bracing rules do not compose with an already-wrapped operand: divisé par", async () => {
  // "x au carré" fires first, becoming "$x^{2}$"; "divisé par" then requires a
  // BARE second operand and "$x^{2}$" is not one, so it does not fire.
  const output = await regexLayerOutput("a divisé par x au carré");
  assert.equal(output, "a divisé par $x^{2}$");
});

test("bracing rules only ever see a single-token operand: 'a divisé par b plus un'", async () => {
  // Matches the issue's own worked example: "divisé par" needs BOTH operands to
  // be a single digit/letter, and "un" (spelled out) is two letters, not one —
  // so "un" can never join the denominator. What DOES happen is the flat
  // "divisé par" pattern still finds its own two single-token operands ("a",
  // "b") earlier in the string and fires on just that span, leaving "plus un"
  // as untouched prose beside it — the regex never attempts (and cannot
  // attempt) the grouping that would be needed for "a / (b+1)".
  const output = await regexLayerOutput("a divisé par b plus un");
  assert.equal(output, "$\\frac{a}{b}$ plus un");
});

// ── Prose guards are unaffected by the LaTeX rewrite ─────────────────────────
test("prose guard: 'de plus en plus' is never touched", async () => {
  const output = await regexLayerOutput("de plus en plus");
  assert.equal(output, "de plus en plus");
});

test("prose guard: ordinary sentences with 'plus'/'moins' stay untouched", async () => {
  for (const input of ["je suis de plus en plus fatigué", "je suis moins fatigué que toi"]) {
    const output = await regexLayerOutput(input);
    assert.equal(output, input);
  }
});

// ── Command sentinels (issue #92) survive the rewritten regex layer untouched ─
// PUA characters are invisible in source; always spelled as \uXXXX escapes.
test("a command sentinel passes through the rewritten regex layer untouched", async () => {
  const nl = String.fromCodePoint(0xe000); // U+E000 — retour à la ligne
  // Adjacent to a rule trigger: the sentinel is not a valid operand (it is
  // neither a digit/letter nor a "$…$" fragment), so "plus" does not fire on
  // it, and it survives byte-identical right where it was.
  const output = await regexLayerOutput(`${nl} plus 3`);
  assert.equal(output, `${nl} plus 3`);
});

test("a command sentinel does not block an unrelated rule from firing nearby", async () => {
  const nl = String.fromCodePoint(0xe000);
  const output = await regexLayerOutput(`${nl} x au carré`);
  assert.equal(output, `${nl} $x^{2}$`);
});

test("the full reserved sentinel block survives the regex layer untouched", async () => {
  let all = "start";
  for (let code = 0xe000; code <= 0xe00f; code += 1) {
    all += String.fromCodePoint(code);
  }
  all += " plus end";
  const output = await regexLayerOutput(all);
  // No rule fires ("end" is not a valid operand either), so the whole string,
  // sentinels included, is byte-identical to the input.
  assert.equal(output, all);
});

test("pipeline snapshot distinguishes invalid and unreadable sources without rebuilding provenance", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-snapshot-"));
  try {
    const dictionaryPath = path.join(directory, "dictionary.json");
    const rulesPath = path.join(directory, "rules.json");
    writeFileSync(dictionaryPath, "{ invalid", "utf8");
    mkdirSync(rulesPath);
    const normalizer = await createTranscriptNormalizer({ dictionaryPath, rulesPath });
    assert.equal(normalizer.pipelineSnapshot.dictionary.source_state, "invalid");
    assert.equal(normalizer.pipelineSnapshot.dictionary.source_content, "{ invalid");
    assert.equal(normalizer.pipelineSnapshot.dictionary.ignored_entries.length, 1);
    assert.equal(normalizer.pipelineSnapshot.regex_rules.source_state, "unreadable");
    assert.equal(normalizer.pipelineSnapshot.regex_rules.source_content, null);
    assert.equal(normalizer.pipelineSnapshot.regex_rules.effective_rules.length, 0);
    assert.match(normalizer.pipelineSnapshot.dictionary.sha256, /^[0-9a-f]{64}$/);
    assert.match(normalizer.pipelineSnapshot.regex_rules.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
