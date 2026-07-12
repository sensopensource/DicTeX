import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateAcousticCharacterErrorRate,
  calculateCharacterErrorRate,
  normalizeForAcousticScoring,
} from "./sttScoring.js";

/**
 * Coverage for the acoustic CER (issue #134): a second, deterministic projection
 * of the same transcript/reference pair that neutralizes ONLY sentence
 * punctuation, so a candidate that heard the words but not the commas is not
 * ranked below one that reproduced a punctuation convention nobody has decided
 * yet. The strict CER stays the exact-fidelity measure and must not move.
 */

const SENTENCE_MARKS = [".", ",", ";", ":", "!", "?", "…"];

test("the motivating pair scores non-zero strict CER but zero acoustic CER", () => {
  const reference = "racine carrée de a plus b";
  const candidate = "racine carrée de a, plus b";

  assert.ok(calculateCharacterErrorRate(candidate, reference) > 0);
  assert.equal(calculateAcousticCharacterErrorRate(candidate, reference), 0);
});

test("adding or removing only sentence punctuation never changes the acoustic CER", () => {
  const reference = "le point A est sur la droite";
  const base = calculateAcousticCharacterErrorRate(reference, reference);
  assert.equal(base, 0);

  for (const mark of SENTENCE_MARKS) {
    // Inserting the mark between words, and appending it, must both stay zero.
    assert.equal(calculateAcousticCharacterErrorRate(`le point A${mark} est sur la droite`, reference), 0);
    assert.equal(calculateAcousticCharacterErrorRate(`${reference}${mark}`, reference), 0);
    assert.equal(calculateAcousticCharacterErrorRate(reference, `${reference}${mark}`), 0);
  }
});

test("neutralized punctuation still separates words rather than merging them", () => {
  // A comma with no surrounding space must not glue two words together.
  assert.equal(normalizeForAcousticScoring("a,b"), "a b");
  assert.equal(calculateAcousticCharacterErrorRate("a,b", "a b"), 0);
});

test("a real lexical difference is still counted by the acoustic CER", () => {
  const reference = "x au carré plus b";
  const candidate = "x au cube plus b";

  assert.ok(calculateAcousticCharacterErrorRate(candidate, reference) > 0);
});

test("apostrophes, hyphens, digits, Greek names, math symbols, parentheses and $ are NOT neutralized", () => {
  // Each pair differs ONLY by a character the acoustic CER must keep scoring.
  const nonNeutralizedPairs: [string, string][] = [
    ["l'aire", "l aire"], // apostrophe
    ["c'est-à-dire", "c'est à dire"], // hyphen
    ["il y a 2 cas", "il y a deux cas"], // digit vs spelled number
    ["alpha plus beta", "α plus β"], // Greek name vs symbol
    ["a plus b", "a + b"], // math symbol
    ["f de x", "f(x)"], // parentheses
    ["x au carré", "$x^{2}$"], // LaTeX delimiter
  ];

  for (const [candidate, reference] of nonNeutralizedPairs) {
    assert.ok(
      calculateAcousticCharacterErrorRate(candidate, reference) > 0,
      `expected a non-zero acoustic CER for ${JSON.stringify(candidate)} vs ${JSON.stringify(reference)}`,
    );
  }
});

test("acoustic CER shares the strict normalization: case and edge whitespace are folded", () => {
  assert.equal(calculateAcousticCharacterErrorRate("  Racine Carrée  ", "racine carrée"), 0);
});

test("acoustic CER edge cases mirror strict CER for empty references", () => {
  assert.equal(calculateAcousticCharacterErrorRate("", ""), 0);
  assert.equal(calculateAcousticCharacterErrorRate("bonjour", ""), 1);
  // A reference made only of punctuation normalizes to empty.
  assert.equal(calculateAcousticCharacterErrorRate("", "..."), 0);
  assert.equal(calculateAcousticCharacterErrorRate("!", ","), 0);
});

test("a purely acoustic reference (no punctuation) leaves strict and acoustic CER equal", () => {
  // Historical compatibility: the two metrics coincide when there is no sentence
  // punctuation to neutralize, so a derived acoustic value never contradicts the
  // strict value on an already-clean pair.
  const reference = "intégrale de zéro à un";
  const candidate = "intégrale de zero à un";
  assert.equal(
    calculateAcousticCharacterErrorRate(candidate, reference),
    calculateCharacterErrorRate(candidate, reference),
  );
});
