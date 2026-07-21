import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTranscriptNormalizer,
  NORMALIZER_PIPELINE_SEMANTIC_VERSION,
  normalizeTranscript,
  type NormalizeOptions,
} from "./normalizer.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { canonicalizeLatex } from "./latex.js";
import { restoreCommandWords } from "./commands.js";

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

// ── Default rules that emit canonical LaTeX fixed points (#106/#107) ─────────
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
  { name: "égale à", input: "x égale à y", expected: "$x = y$" },
  { name: "est égal à", input: "x est égal à y", expected: "$x = y$" },
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
  { name: "sur", input: "1 sur x", expected: "$\\frac{1}{x}$" },
  { name: "multiplié par", input: "x multiplié par y", expected: "$x \\times y$" },
  { name: "multipliée par", input: "x multipliée par y", expected: "$x \\times y$" },
  { name: "supérieur à", input: "x supérieur à 0", expected: "$x > 0$" },
  { name: "inférieur à", input: "x inférieur à 0", expected: "$x < 0$" },
  { name: "sinus de", input: "sinus de x", expected: "$\\sin(x)$" },
  { name: "cosinus de", input: "cosinus de x", expected: "$\\cos(x)$" },
  { name: "logarithme naturel de", input: "logarithme naturel de x", expected: "$\\ln(x)$" },
  { name: "function application", input: "f de x", expected: "$f(x)$" },
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

test("bracing rules keep atomic scope when a word-number operation follows", async () => {
  // The new word-number atom makes the trailing addition recognizable, but the
  // bracing fraction still consumes only "a" and "b". It therefore produces
  // (a / b) + 1, never the unrequested a / (b + 1) grouping.
  const output = await regexLayerOutput("a divisé par b plus un");
  assert.equal(output, "$\\frac{a}{b} + 1$");
  assert.equal(canonicalizeLatex(output), output);
});

// ── Issue #148: atomic aliases, local composition, and prose safety ──────────
test("fractions are constructed before equality", async () => {
  const output = await regexLayerOutput("v égal d sur t");
  assert.equal(output, "$v = \\frac{d}{t}$");
  assert.equal(canonicalizeLatex(output), output);
});

test("the acceptance examples compose without changing surrounding prose", async () => {
  const cases = [
    ["un sur x", "$\\frac{1}{x}$"],
    ["un sur deux", "$\\frac{1}{2}$"],
    ["x multiplié par y", "$x \\times y$"],
    ["x supérieur à zéro", "$x > 0$"],
    ["x inférieur à zéro", "$x < 0$"],
    ["sinus de x", "$\\sin(x)$"],
    ["cosinus de theta", "$\\cos(\\theta)$"],
    ["logarithme naturel de x", "$\\ln(x)$"],
    ["f de x", "$f(x)$"],
    ["la masse est égale à rho multiplié par v", "la masse est égale à $\\rho \\times v$"],
    [
      "pour x supérieur à zéro la fonction est logarithme naturel de x",
      "pour $x > 0$ la fonction est $\\ln(x)$",
    ],
  ] as const;

  for (const [input, expected] of cases) {
    const output = await regexLayerOutput(input);
    assert.equal(output, expected, input);
    assert.equal(canonicalizeLatex(output), output, input);
    assert.doesNotMatch(output, /[\uE000-\uE00F]/u, input);
  }
});

// ── Issue #177: order relations (DEC-CONV-002, CONV-008) ────────────────────
//
// Strictly is emphasis only: it keeps the strict symbol. "Ou égal à" is the
// sole modifier that changes the relation. The product-level rules emit the
// short LaTeX aliases requested by the convention; canonicalizeLatex then
// folds them to the corpus spellings \leq / \geq.
test("order relations distinguish strict emphasis from inclusive comparison", async () => {
  const cases = [
    ["x inférieur à zéro", "$x < 0$", "$x < 0$"],
    ["x strictement inférieur à zéro", "$x < 0$", "$x < 0$"],
    ["x inférieur ou égal à zéro", "$x \\le 0$", "$x \\leq 0$"],
    ["x supérieur à zéro", "$x > 0$", "$x > 0$"],
    ["x strictement supérieur à zéro", "$x > 0$", "$x > 0$"],
    ["x supérieur ou égal à zéro", "$x \\ge 0$", "$x \\geq 0$"],
    ["x strictement inférieure à zéro", "$x < 0$", "$x < 0$"],
    ["x supérieure ou égale à zéro", "$x \\ge 0$", "$x \\geq 0$"],
    ["alpha inférieur ou égal à beta", "$\\alpha \\le \\beta$", "$\\alpha \\leq \\beta$"],
    ["a inférieur à b inférieur à c", "$a < b < c$", "$a < b < c$"],
    ["a inférieur ou égal à b inférieur à c", "$a \\le b < c$", "$a \\leq b < c$"],
  ] as const;

  for (const [input, rawExpected, canonicalExpected] of cases) {
    const output = await regexLayerOutput(input);
    assert.equal(output, rawExpected, input);
    assert.equal(canonicalizeLatex(output), canonicalExpected, input);
  }
});

test("inclusive order relations are flat rules with stable trace ids", async () => {
  const normalizer = await createTranscriptNormalizer(ABSENT_CONFIG);
  const result = await normalizer.normalize(
    "x au carré inférieur ou égal à y plus z",
    { detailedTrace: true },
  );
  assert.equal(result.output, "$x^{2} \\le y + z$");
  assert.equal(canonicalizeLatex(result.output), "$x^{2} \\leq y + z$");

  const regexDefinitionIds = result.operations
    ?.filter((operation) => operation.operation === "regex")
    .map((operation) => operation.definition_id) ?? [];
  assert.ok(regexDefinitionIds.includes("comparison-less-or-equal"));
  assert.ok(normalizer.pipelineSnapshot.regex_rules.effective_rules.some(
    (rule) => rule.id === "comparison-greater-or-equal",
  ));
});

test("order-relation words outside a complete bounded pattern stay prose", async () => {
  const prose = [
    "inférieur",
    "strictement inférieur",
    "inférieur ou égal à",
    "ce résultat est inférieur",
    "une borne inférieure ou égale",
  ];
  for (const input of prose) {
    assert.equal(await regexLayerOutput(input), input);
  }
});

// ── Issue #176: the "le tout" spoken grouping marker (DEC-CONV-003, CONV-010) ─
//
// "le tout" is the ONLY marker that bounds a composed sub-expression; without it
// the atomic scope of the bare rules is unchanged (DEC-NORM-003). The rules run
// last, on the "$…$" fragment the flat operators already produced. A power wraps
// its group in PARENS (depth 0, spaced) and a fraction/root in BRACES (depth ≥ 1,
// tight); the assertion is on the CANONICALIZED output, per the issue's
// acceptance criterion ("la couche 2 attendue après canonicalizeLatex"), and
// each expected value is verified to be its own canonicalizeLatex fixed point.
test("'le tout' bounds the preceding formed expression (DEC-CONV-003)", async () => {
  const cases = [
    ["a plus b le tout au carré", "$(a + b)^{2}$"],
    ["a plus b le tout au cube", "$(a + b)^{3}$"],
    ["a plus b le tout puissance 3", "$(a + b)^{3}$"],
    ["a plus b le tout puissance n", "$(a + b)^{n}$"],
    ["a plus b le tout sur c plus d le tout", "$\\frac{a+b}{c+d}$"],
    ["racine carrée de a plus b le tout", "$\\sqrt{a+b}$"],
    ["racine carrée de a moins b le tout", "$\\sqrt{a-b}$"],
  ] as const;
  for (const [input, expected] of cases) {
    const output = canonicalizeLatex(await regexLayerOutput(input));
    assert.equal(output, expected, input);
    assert.equal(canonicalizeLatex(expected), expected, expected);
  }
});

// A fraction operand stays atomic unless it carries its OWN marker
// (DEC-NORM-001): with only the numerator grouped, "sur" consumes the single
// atom "c" and "+ d" stays outside — never the un-dictated "$\frac{a+b}{c+d}$".
test("'le tout' bounds only the immediately preceding operand (DEC-CONV-003)", async () => {
  assert.equal(
    canonicalizeLatex(await regexLayerOutput("a plus b le tout sur c plus d")),
    "$\\frac{a+b}{c} + d$",
  );
  assert.equal(
    canonicalizeLatex(await regexLayerOutput("a plus b le tout sur c")),
    "$\\frac{a+b}{c}$",
  );
});

// Without the marker, the DEC-NORM-003 residue is preserved verbatim, and "le
// tout" in ordinary prose (no maths fragment) is never touched.
test("without 'le tout' the atomic residue and prose are unchanged (DEC-NORM-003)", async () => {
  assert.equal(await regexLayerOutput("racine carrée de a plus b"), "$\\sqrt{a} + b$");
  assert.equal(
    await regexLayerOutput("je prends le tout et je pars"),
    "je prends le tout et je pars",
  );
  assert.equal(
    await regexLayerOutput("il faut regarder le tout autrement"),
    "il faut regarder le tout autrement",
  );
});

test("validation snapshot run_20260715131235469_r1xsgn7a reproduces 20 of 21 references", async () => {
  const cases = [
    ["seg_0025", "racine carrée de a plus b", "$\\sqrt{a+b}$"],
    [
      "seg_0026",
      "parenthèse ouvrante x plus deux parenthèse fermante multiplié par y",
      "$(x + 2) \\times y$",
    ],
    [
      "seg_0028",
      "x multiplié par parenthèse ouvrante y moins trois parenthèse fermante",
      "$x \\times (y - 3)$",
    ],
    ["seg_0029", "f de g de x", "$f(g(x))$"],
    [
      "seg_0030",
      "parenthèse ouvrante x plus un parenthèse fermante au carré",
      "$(x + 1)^{2}$",
    ],
    ["seg_0031", "sinus de x", "$\\sin(x)$"],
    ["seg_0032", "cosinus de theta plus un", "$\\cos(\\theta) + 1$"],
    [
      "seg_0036",
      "limite quand x tend vers zéro de sinus de x sur x",
      "$\\lim_{x\\to0}\\frac{\\sin(x)}{x}$",
    ],
    [
      "seg_0037",
      "dérivée de f par rapport à x",
      "$\\frac{\\mathrm{d}f}{\\mathrm{d}x}$",
    ],
    [
      "seg_0038",
      "intégrale de zéro à un de x au carré d x",
      "$\\int_{0}^{1}x^{2} \\, dx$",
    ],
    ["seg_0039", "la vitesse vaut v égal d sur t.", "la vitesse vaut $v = \\frac{d}{t}$."],
    [
      "seg_0040",
      "la masse est égale à rho multiplié par v",
      "la masse est égale à $\\rho \\times v$",
    ],
    [
      "seg_0041",
      "pour x supérieur à zéro la fonction est logarithme naturel de x",
      "pour $x > 0$ la fonction est $\\ln(x)$",
    ],
    [
      "seg_0005",
      "exponentielle de moins trois inférieur à exponentielle de moins un inférieur à exponentielle de zéro inférieur à exponentielle de deux",
      "$e^{-3} < e^{-1} < e^{0} < e^{2}$",
    ],
    [
      "seg_0006",
      "exponentielle de cinq supérieure à exponentielle de trois exponentielle de moins dix inférieure à exponentielle de moins deux exponentielle de x ne peut pas être négatif exponentielle de x est égale à zéro pour une certaine valeur de x est impossible",
      "$e^{5} > e^{3}$ $e^{-10} < e^{-2}$ $e^{x}$ ne peut pas être négatif $e^{x} = 0$ pour une certaine valeur de $x$ est impossible",
    ],
    [
      "seg_0009",
      "le logarithme n'existe que pour x supérieur à zéro",
      "le logarithme n'existe que pour $x > 0$",
    ],
    [
      "seg_0015",
      "soit f de x est égal à deux x plus trois",
      "soit $f(x) = 2x + 3$",
    ],
    [
      "seg_0016",
      "f de zéro est égal trois retour à la ligne f de deux est égal à sept retour à la ligne f de moins un est égal à un retour à la ligne soit g de x est égal à x au carré retour à la ligne calculons g de trois retour à la ligne g de trois est égal à neuf retour à la ligne g de moins deux est égal à quatre retour à la ligne g de zéro est égal à zéro retour à la ligne f de cinq est égal à treize cela signifie que treize est l'image de la fonction f quand x est égal à cinq",
      "$f(0) = 3$ retour à la ligne $f(2) = 7$ retour à la ligne $f(-1) = 1$ retour à la ligne soit $g(x) = x^{2}$ retour à la ligne calculons $g(3)$ retour à la ligne $g(3) = 9$ retour à la ligne $g(-2) = 4$ retour à la ligne $g(0) = 0$ retour à la ligne $f(5) = 13$ cela signifie que $13$ est l'image de la fonction $f$ quand $x = 5$",
    ],
    [
      "seg_0017",
      "une limite décrit vers quoi tend une fonction lorsqu'on s'approche d'une valeur sans forcément l'atteindre",
      "une limite décrit vers quoi tend une fonction lorsqu'on s'approche d'une valeur sans forcément l'atteindre",
    ],
    [
      "seg_0018",
      "exemple retour à la ligne f de x est égal à un sur x",
      "exemple retour à la ligne $f(x) = \\frac{1}{x}$",
    ],
    [
      "seg_0020",
      "limite de un sur x quand x tend vers plus l'infini",
      "$\\lim_{x\\to+\\infty}\\frac{1}{x}$",
    ],
  ] as const;
  const baselineExactSegments = new Set([
    "seg_0031", "seg_0032", "seg_0039", "seg_0040", "seg_0041", "seg_0009", "seg_0017",
  ]);
  let exact = 0;

  for (const [segmentId, input, expected] of cases) {
    const result = await normalizeTranscript(input, ABSENT_CONFIG);
    const restoredOutput = restoreCommandWords(result.output);
    const output = canonicalizeLatex(restoredOutput);
    const target = canonicalizeLatex(expected);
    assert.equal(output, restoredOutput, `${segmentId} output is already canonical`);
    if (segmentId === "seg_0025") {
      assert.equal(output, "$\\sqrt{a} + b$", "ambiguous root scope stays atomic");
      assert.notEqual(output, target, "ambiguous scope is not guessed by regex");
      continue;
    }
    assert.equal(output, target, segmentId);
    if (baselineExactSegments.has(segmentId)) {
      assert.equal(output, target, `${segmentId} baseline regression`);
    }
    exact += 1;
  }

  assert.equal(exact, 20);
  assert.equal(baselineExactSegments.size, 7);
});

test("structured rules stay bounded to explicit mathematical utterances", async () => {
  const prose = [
    "une parenthèse ouvrante montre une précision",
    "la fonction fabrique une image",
    "la valeur de xylophone reste stable",
    "il reste deux xylophones plus trois exemples",
    "une limite décrit un comportement",
  ];
  for (const input of prose) {
    assert.equal(await regexLayerOutput(input), input);
  }
  assert.equal(await regexLayerOutput("x supérieure à zéro"), "$x > 0$");
  assert.equal(await regexLayerOutput("x inférieure à zéro"), "$x < 0$");
});

test("French number words zero through twenty normalize only as math operands", async () => {
  const numbers = [
    ["zéro", "0"], ["un", "1"], ["deux", "2"], ["trois", "3"], ["quatre", "4"],
    ["cinq", "5"], ["six", "6"], ["sept", "7"], ["huit", "8"], ["neuf", "9"],
    ["dix", "10"], ["onze", "11"], ["douze", "12"], ["treize", "13"],
    ["quatorze", "14"], ["quinze", "15"], ["seize", "16"], ["dix-sept", "17"],
    ["dix-huit", "18"], ["dix-neuf", "19"], ["vingt", "20"],
  ] as const;

  for (const [spoken, digit] of numbers) {
    assert.equal(await regexLayerOutput(`x plus ${spoken}`), `$x + ${digit}$`, spoken);
    assert.equal(await regexLayerOutput(`il reste ${spoken} exemples`), `il reste ${spoken} exemples`, spoken);
  }
});

test("unary moins is converted only when the signed number is consumed as an operand", async () => {
  assert.equal(await regexLayerOutput("x supérieur à moins trois"), "$x > -3$");
  assert.equal(await regexLayerOutput("moins trois sur x"), "$\\frac{-3}{x}$");
  assert.equal(await regexLayerOutput("sinus de moins trois"), "$\\sin(-3)$");
  assert.equal(await regexLayerOutput("il reste moins trois minutes"), "il reste moins trois minutes");
  assert.equal(await regexLayerOutput("moins trois"), "moins trois");
});

test("explicit equalities consume 'à' and compose with negative operands", async () => {
  const cases = [
    ["exponentielle de 0 égale à 0", "$e^{0} = 0$"],
    ["logarithme naturel de 1 égale à 0", "$\\ln(1) = 0$"],
    ["f de 0 est égal à moins 2", "$f(0) = -2$"],
    ["f de moins 1 est égal à moins 5", "$f(-1) = -5$"],
    ["x est égal à moins 1", "$x = -1$"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(await regexLayerOutput(input), expected, input);
  }
});

test("bounded daily-use rules cover digit STT output without inventing missing context", async () => {
  const cases = [
    [
      "exponentielle de moins 2 inférieure à exponentielle de 0 inférieure à exponentielle de 1 inférieure à exponentielle de 4",
      "$e^{-2} < e^{0} < e^{1} < e^{4}$",
    ],
    ["logarithme de 7", "$\\log(7)$"],
    ["logarithme de 0", "$\\log(0)$"],
    ["logarithme de sept", "$\\log(7)$"],
    ["logarithme de zéro", "$\\log(0)$"],
    ["sinus de 90 degrés est égal à 1", "$\\sin(90^{\\circ}) = 1$"],
    ["cosinus de 90 degrés est égal à 0", "$\\cos(90^{\\circ}) = 0$"],
    ["sinus de 270 degrés est égal à moins 1", "$\\sin(270^{\\circ}) = -1$"],
    ["theta est égal à 180 degrés", "$\\theta = 180^{\\circ}$"],
    [
      "limite de 1 sur x quand x tend vers plus l'infini est égal à 0",
      "$\\lim_{x\\to+\\infty}\\frac{1}{x} = 0$",
    ],
  ] as const;

  for (const [input, expected] of cases) {
    const output = await regexLayerOutput(input);
    assert.equal(output, expected, input);
    assert.equal(canonicalizeLatex(output), output, input);
  }

  assert.equal(
    await regexLayerOutput("il existe un réel x tel que exponentielle x égale à moins 5"),
    "il existe un réel x tel que exponentielle $x = -5$",
  );
  assert.equal(await regexLayerOutput("la situation est égale à celle d'hier"), "la situation est égale à celle d'hier");
});

test("Greek names stay literal outside recognized atomic math constructs", async () => {
  assert.equal(await regexLayerOutput("theta et rho sont des noms"), "theta et rho sont des noms");
  assert.equal(await regexLayerOutput("theta plus rho"), "$\\theta + \\rho$");
  // DEC-COUCHE1-003 (#178): the rest of the lowercase Greek alphabet behaves
  // exactly like theta/rho — an isolated Greek word, including one that is also
  // an ordinary French word, is left byte-identical outside a construction.
  assert.equal(await regexLayerOutput("la lettre pi"), "la lettre pi");
  assert.equal(await regexLayerOutput("un individu lambda"), "un individu lambda");
  assert.equal(await regexLayerOutput("une pie vole dans le ciel"), "une pie vole dans le ciel");
  assert.equal(await regexLayerOutput("il est un peu bêta"), "il est un peu bêta");
  for (const prose of [
    "une pie sur un fil",
    "il dort nu sur un lit",
    "mu sur un plateau",
    "le vecteur nu plus un",
  ]) {
    assert.equal(await regexLayerOutput(prose), prose);
  }
});

test("DEC-COUCHE1-003: the full lowercase Greek alphabet is an atom in existing constructs (#178)", async () => {
  // Every letter of DEC-COUCHE1-003's canonical lexicon, recognized as an atom
  // and emitting its macro. omicron is intentionally absent: base LaTeX has no
  // \omicron, so it is neither a bare operand nor a spoken atom here.
  const letters: [string, string][] = [
    ["alpha", "\\alpha"], ["beta", "\\beta"], ["gamma", "\\gamma"], ["delta", "\\delta"],
    ["epsilon", "\\epsilon"], ["zeta", "\\zeta"], ["eta", "\\eta"], ["theta", "\\theta"],
    ["iota", "\\iota"], ["kappa", "\\kappa"], ["lambda", "\\lambda"], ["mu", "\\mu"],
    ["nu", "\\nu"], ["xi", "\\xi"], ["pi", "\\pi"], ["rho", "\\rho"], ["sigma", "\\sigma"],
    ["tau", "\\tau"], ["upsilon", "\\upsilon"], ["phi", "\\phi"], ["chi", "\\chi"],
    ["psi", "\\psi"], ["omega", "\\omega"],
  ];
  assert.equal(letters.length, 23);
  assert.equal(letters.some(([spoken]) => spoken === "omicron"), false);
  for (const [spoken, macro] of letters) {
    const over = await regexLayerOutput(`${spoken} sur x`);
    assert.equal(over, `$\\frac{${macro}}{x}$`, `${spoken} sur x`);
    assert.equal(canonicalizeLatex(over), over, spoken);
    // The same letter, isolated, is not turned into a macro.
    assert.equal(await regexLayerOutput(`la lettre ${spoken}`), `la lettre ${spoken}`, spoken);
  }

  // Two Greek letters compose into a single fraction, and a Greek letter is a
  // valid function argument and flat-operator operand.
  const frac = await regexLayerOutput("alpha sur beta");
  assert.equal(frac, "$\\frac{\\alpha}{\\beta}$");
  assert.equal(canonicalizeLatex(frac), frac);
  assert.equal(await regexLayerOutput("cosinus de alpha"), "$\\cos(\\alpha)$");
  assert.equal(await regexLayerOutput("lambda plus mu"), "$\\lambda + \\mu$");
  assert.equal(await regexLayerOutput("nu plus deux"), "$\\nu + 2$");
  assert.equal(await regexLayerOutput("pi sur deux"), "$\\frac{\\pi}{2}$");
  assert.equal(await regexLayerOutput("sigma est égal à trois"), "$\\sigma = 3$");
});

test("DEC-COUCHE1-003: accented/phonetic STT variants fold to the canonical atom (#178)", async () => {
  // The "dictionary brings observed variants to the canonical form" clause,
  // realized as prose-safe atom aliases (DicTeX ships an empty personal
  // dictionary). A variant is only canonicalized inside a construction.
  const variants: [string, string][] = [
    ["thêta sur deux", "$\\frac{\\theta}{2}$"],
    ["rhô sur deux", "$\\frac{\\rho}{2}$"],
    ["khi plus un", "$\\chi + 1$"],
    ["bêta égale zéro", "$\\beta = 0$"],
    ["êta plus un", "$\\eta + 1$"],
    ["oméga sur deux", "$\\frac{\\omega}{2}$"],
  ];
  for (const [input, expected] of variants) {
    const output = await regexLayerOutput(input);
    assert.equal(output, expected, input);
    assert.equal(canonicalizeLatex(output), output, input);
  }
  // The speculative French homophone is not shipped as an alias at all.
  assert.equal(await regexLayerOutput("pie sur deux"), "pie sur deux");
  assert.equal(await regexLayerOutput("une pie chante"), "une pie chante");
  assert.equal(await regexLayerOutput("un raisonnement un peu bêta"), "un raisonnement un peu bêta");
});

test("new atomic conversions keep ordered, versioned regex traces", async () => {
  const normalizer = await createTranscriptNormalizer(ABSENT_CONFIG);
  const result = await normalizer.normalize("x supérieur à zéro", { detailedTrace: true });
  assert.equal(result.output, "$x > 0$");

  const regexOperations = result.operations?.filter((operation) => operation.operation === "regex") ?? [];
  assert.ok(regexOperations.length >= 2, "the contextual number conversion and comparison are both traced");
  const effectiveIds = new Set(
    normalizer.pipelineSnapshot.regex_rules.effective_rules.map((rule) => rule.id),
  );
  assert.equal(regexOperations.every((operation) => effectiveIds.has(operation.definition_id)), true);
  assert.equal(normalizer.pipelineSnapshot.semantic_version, NORMALIZER_PIPELINE_SEMANTIC_VERSION);
  assert.doesNotMatch(JSON.stringify(result), /[\uE000-\uE00F]/u);
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

test("an existing rules.json remains an explicitly reported legacy baseline until migration", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-rules-migration-"));
  try {
    const dictionaryPath = path.join(directory, "dictionary.json");
    const rulesPath = path.join(directory, "rules.json");
    const personalRule = { pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" };
    const legacySource = JSON.stringify({ version: 1, rules: [personalRule] }, null, 2);
    writeFileSync(rulesPath, legacySource, "utf8");

    const legacy = await createTranscriptNormalizer({ dictionaryPath, rulesPath });
    assert.equal((await legacy.normalize("bonjour et un sur x")).output, "salut et un sur x");
    assert.equal(legacy.pipelineSnapshot.regex_rules.source_content, legacySource);
    assert.equal(legacy.pipelineSnapshot.regex_rules.effective_rules.length, 1);
    assert.equal(legacy.rulesConfiguration.mode, "legacy");
    assert.equal(legacy.rulesConfiguration.state, "migration_required");
    assert.equal(legacy.pipelineSnapshot.regex_rules.legacy_source_sha256, legacy.rulesConfiguration.legacyHash);
    assert.equal(readFileSync(rulesPath, "utf8"), legacySource);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
