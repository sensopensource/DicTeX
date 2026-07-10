import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeLatex, INLINE_MATH_DELIMITER, MACRO_ALIASES } from "./latex.js";
import { calculateCharacterErrorRate, calculateWordErrorRate } from "./sttScoring.js";

// ── The style subset: each ambiguous spelling → the one canonical form ────────
// (docs/dataset-and-normalization-design.md §8). Every case below is the reason
// the corpus is worth collecting: without it, `x^2` and `x^{2}` score as an error.

test("exponents are always braced", () => {
  assert.equal(canonicalizeLatex("$x^2$"), "$x^{2}$");
  assert.equal(canonicalizeLatex("$x^{2}$"), "$x^{2}$");
  assert.equal(canonicalizeLatex("$x^n$"), "$x^{n}$");
  assert.equal(canonicalizeLatex("$e^x$"), "$e^{x}$");
  // A multi-token exponent stays braced; being inside the group it is set tight.
  assert.equal(canonicalizeLatex("$x^{n+1}$"), "$x^{n+1}$");
});

test("subscripts are always braced", () => {
  assert.equal(canonicalizeLatex("$u_n$"), "$u_{n}$");
  assert.equal(canonicalizeLatex("$u_{n}$"), "$u_{n}$");
  assert.equal(canonicalizeLatex("$a_{i}$"), "$a_{i}$");
});

test("roots: single-token radicand braced, degree preserved", () => {
  assert.equal(canonicalizeLatex("$\\sqrt x$"), "$\\sqrt{x}$");
  assert.equal(canonicalizeLatex("$\\sqrt{x}$"), "$\\sqrt{x}$");
  assert.equal(canonicalizeLatex("$\\sqrt[3]{x}$"), "$\\sqrt[3]{x}$");
});

test("fractions: \\dfrac and \\tfrac collapse to \\frac; args braced", () => {
  assert.equal(canonicalizeLatex("$\\dfrac{a}{b}$"), "$\\frac{a}{b}$");
  assert.equal(canonicalizeLatex("$\\tfrac{a}{b}$"), "$\\frac{a}{b}$");
  assert.equal(canonicalizeLatex("$\\frac a b$"), "$\\frac{a}{b}$");
  assert.equal(canonicalizeLatex("$\\frac{a}{b}$"), "$\\frac{a}{b}$");
});

test("multiplication: \\cdot and * become \\times", () => {
  assert.equal(canonicalizeLatex("$a \\cdot b$"), "$a \\times b$");
  assert.equal(canonicalizeLatex("$a * b$"), "$a \\times b$");
  assert.equal(canonicalizeLatex("$2\\times3$"), "$2 \\times 3$");
});

test("relations: short macros become their canonical long forms", () => {
  assert.equal(canonicalizeLatex("$a \\le b$"), "$a \\leq b$");
  assert.equal(canonicalizeLatex("$a \\ge b$"), "$a \\geq b$");
  assert.equal(canonicalizeLatex("$a \\ne b$"), "$a \\neq b$");
  assert.equal(canonicalizeLatex("$a \\leqslant b$"), "$a \\leq b$");
  // = < > pass through, spaced.
  assert.equal(canonicalizeLatex("$a=b$"), "$a = b$");
  assert.equal(canonicalizeLatex("$a<b$"), "$a < b$");
});

test("integrals: bounds braced, exactly one \\, before the differential", () => {
  assert.equal(canonicalizeLatex("$\\int_0^1 x^2 dx$"), "$\\int_{0}^{1}x^{2} \\, dx$");
  // The issue's exact canonical form is a fixed point (its extra layout space is
  // dropped, so both spellings converge).
  assert.equal(canonicalizeLatex("$\\int_{0}^{1} x^{2} \\, dx$"), "$\\int_{0}^{1}x^{2} \\, dx$");
  // A wider manual space collapses to the canonical thin space.
  assert.equal(canonicalizeLatex("$\\int_0^1 x^2 \\; dx$"), "$\\int_{0}^{1}x^{2} \\, dx$");
  // Differential after a closing paren.
  assert.equal(canonicalizeLatex("$\\int f(x) dx$"), "$\\int f(x) \\, dx$");
});

test("sums keep tight bounds", () => {
  assert.equal(canonicalizeLatex("$\\sum_{i=1}^n$"), "$\\sum_{i=1}^{n}$");
  assert.equal(canonicalizeLatex("$\\sum_{i=1}^{n}$"), "$\\sum_{i=1}^{n}$");
});

test("limits: subscript set tight (documented deviation from the issue display)", () => {
  // §8 records this: uniform depth-0 spacing keeps bounds/exponents tight and
  // matches three of the issue's four examples; \lim's subscript is the deviation.
  assert.equal(canonicalizeLatex("$\\lim_{n \\to \\infty}$"), "$\\lim_{n\\to\\infty}$");
  assert.equal(canonicalizeLatex("$\\lim_{n \\rightarrow \\infty}$"), "$\\lim_{n\\to\\infty}$");
});

test("functions and composition", () => {
  assert.equal(canonicalizeLatex("$f(x)$"), "$f(x)$");
  assert.equal(canonicalizeLatex("$g \\circ f$"), "$g \\circ f$");
});

test("sets: \\mathbb argument braced, \\in spaced", () => {
  assert.equal(canonicalizeLatex("$x \\in \\mathbb R$"), "$x \\in \\mathbb{R}$");
  assert.equal(canonicalizeLatex("$\\mathbb{R}$"), "$\\mathbb{R}$");
});

test("binary-operator spacing: collapses runs, one space each side at top level", () => {
  assert.equal(canonicalizeLatex("$a+b$"), "$a + b$");
  assert.equal(canonicalizeLatex("$a  +  b$"), "$a + b$");
  assert.equal(canonicalizeLatex("$a - b$"), "$a - b$");
  // Unary minus is NOT spaced.
  assert.equal(canonicalizeLatex("$-x$"), "$-x$");
  assert.equal(canonicalizeLatex("$(-x)$"), "$(-x)$");
  assert.equal(canonicalizeLatex("$x = -1$"), "$x = -1$");
  assert.equal(canonicalizeLatex("$x^{-1}$"), "$x^{-1}$");
});

test("manual spacing other than the differential is removed", () => {
  assert.equal(canonicalizeLatex("$a \\, b$"), "$ab$");
  assert.equal(canonicalizeLatex("$a \\; b$"), "$ab$");
  assert.equal(canonicalizeLatex("$a \\quad b$"), "$ab$");
  assert.equal(canonicalizeLatex("$a~b$"), "$ab$");
});

// ── The delimiter decision: inline maths in $…$; prose is bare and untouched ──

test("prose is returned verbatim (identity on strings with no maths)", () => {
  const prose = "Soit x un réel strictement positif.";
  assert.equal(canonicalizeLatex(prose), prose);
  assert.equal(canonicalizeLatex(""), "");
});

test("only the maths inside $…$ is rewritten; surrounding prose is preserved", () => {
  assert.equal(
    canonicalizeLatex("la fonction $f(x) = x^2$ est croissante"),
    "la fonction $f(x) = x^{2}$ est croissante",
  );
});

test("delimiter spacing is normalized", () => {
  assert.equal(canonicalizeLatex("$ x $"), "$x$");
  assert.equal(canonicalizeLatex("$  x^2  $"), "$x^{2}$");
});

test("\\(…\\) is an alias for $…$ and is normalized to it", () => {
  assert.equal(canonicalizeLatex("\\(x^2\\)"), "$x^{2}$");
});

test("\\$ is a literal dollar, never a delimiter", () => {
  assert.equal(canonicalizeLatex("le prix est \\$5 net"), "le prix est \\$5 net");
});

test("an unbalanced $ leaves the remainder as prose (no corruption)", () => {
  assert.equal(canonicalizeLatex("un montant de $ ou autre"), "un montant de $ ou autre");
});

test("a command sentinel in prose passes through untouched", () => {
  const NL = String.fromCodePoint(0xe000);
  assert.equal(canonicalizeLatex(`${NL} $x^2$`), `${NL} $x^{2}$`);
});

// ── IDEMPOTENCE: a canonical string is a fixed point ─────────────────────────

const CORPUS = [
  "$x^2$",
  "$x^{n+1}$",
  "$u_n$",
  "$\\sqrt x$",
  "$\\sqrt[3]{x}$",
  "$\\dfrac{a}{b}$",
  "$\\frac a b$",
  "$a \\cdot b$",
  "$a * b$",
  "$a \\le b$",
  "$\\int_0^1 x^2 dx$",
  "$\\int_{0}^{1} x^{2} \\, dx$",
  "$\\int f(x) dx$",
  "$\\sum_{i=1}^n$",
  "$\\lim_{n \\to \\infty}$",
  "$g \\circ f$",
  "$x \\in \\mathbb R$",
  "$a+b$",
  "$(-x)$",
  "$x = -1$",
  "$\\alpha + \\beta$",
  "la fonction $f(x) = x^2$ est croissante et $g(x) = \\sqrt x$",
  "Soit x un réel.",
  "\\(x^2\\)",
];

test("IDEMPOTENT: canonicalizeLatex(canonicalizeLatex(s)) === canonicalizeLatex(s)", () => {
  for (const input of CORPUS) {
    const once = canonicalizeLatex(input);
    const twice = canonicalizeLatex(once);
    assert.equal(twice, once, `not a fixed point: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`);
  }
});

test("IDEMPOTENT on the canonical forms themselves (they map to themselves)", () => {
  const canonical = [
    "$x^{2}$",
    "$\\frac{a}{b}$",
    "$a \\times b$",
    "$a \\leq b$",
    "$\\int_{0}^{1}x^{2} \\, dx$",
    "$\\sum_{i=1}^{n}$",
    "$\\lim_{n\\to\\infty}$",
    "$x \\in \\mathbb{R}$",
  ];
  for (const form of canonical) {
    assert.equal(canonicalizeLatex(form), form, `canonical form changed: ${JSON.stringify(form)}`);
  }
});

// ── TOTALITY: any input returns a string without throwing ─────────────────────

test("TOTAL: malformed / adversarial inputs return a string, never throw", () => {
  const inputs = [
    "",
    "$",
    "$$",
    "$$$",
    "{",
    "}",
    "{}",
    "$}{$",
    "\\",
    "$\\$",
    "^",
    "$^$",
    "$x^$",
    "$_$",
    "$\\frac$",
    "$\\frac{a}$",
    "$\\sqrt$",
    "$\\sqrt[$",
    "$\\int dx$",
    "$\\$",
    "\\(",
    "\\(x^2",
    "$" + "{".repeat(200) + "$",
    "$" + "x^".repeat(100) + "$",
    // A command sentinel (PUA, written as an escape) inside maths must survive.
    "$" + String.fromCodePoint(0xe000) + "$",
    String.fromCodePoint(0xe000) + String.fromCodePoint(0xe001),
    "café ∫ π ∞ 漢字 😀",
    "$a$b$c$",
  ];
  for (const input of inputs) {
    const output = canonicalizeLatex(input);
    assert.equal(typeof output, "string", `non-string output for ${JSON.stringify(input)}`);
    // Idempotence must also hold on malformed input.
    assert.equal(canonicalizeLatex(output), output, `not a fixed point: ${JSON.stringify(input)}`);
  }
});

// ── Constants ─────────────────────────────────────────────────────────────────

test("exports the canonical inline delimiter and the alias table", () => {
  assert.equal(INLINE_MATH_DELIMITER, "$");
  assert.equal(MACRO_ALIASES["\\dfrac"], "\\frac");
  assert.equal(MACRO_ALIASES["\\cdot"], "\\times");
  assert.equal(MACRO_ALIASES["\\le"], "\\leq");
});

// ── The reason this issue exists: scoring is on canonicalized strings ─────────

test("CER: two spellings of the same maths score as identical (issue #106)", () => {
  // Without canonicalization these differ by two characters ({ and }); with it,
  // CER is 0 — typography no longer pollutes the measurement.
  assert.equal(calculateCharacterErrorRate("$x^2$", "$x^{2}$"), 0);
  assert.equal(calculateCharacterErrorRate("$a \\cdot b$", "$a \\times b$"), 0);
  assert.equal(calculateCharacterErrorRate("$\\dfrac{a}{b}$", "$\\frac{a}{b}$"), 0);
});

test("WER: canonicalization applies to word scoring too", () => {
  assert.equal(calculateWordErrorRate("$a+b$", "$a + b$"), 0);
});

test("scoring still separates genuinely different maths", () => {
  assert.ok(calculateCharacterErrorRate("$x^2$", "$x^{3}$") > 0);
});
