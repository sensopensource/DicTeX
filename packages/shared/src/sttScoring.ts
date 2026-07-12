import { canonicalizeLatex } from "./latex.js";

export function normalizeForScoring(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function calculateEditDistance<T>(left: T[], right: T[]): number {
  const previousRow = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const currentRow = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    currentRow[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      currentRow[rightIndex] = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previousRow[rightIndex] = currentRow[rightIndex];
    }
  }

  return previousRow[right.length];
}

export function calculateCharacterErrorRate(candidateTranscript: string, referenceTranscript: string): number {
  // Canonicalize LaTeX BEFORE scoring (issue #106): `x^2` and `x^{2}` are the
  // same mathematics and must not score as an error. On prose (no `$…$`) this is
  // the identity, so raw STT output is unaffected. Applied before the existing
  // lowercase/trim so LaTeX macro case is preserved through canonicalization.
  const candidate = normalizeForScoring(canonicalizeLatex(candidateTranscript));
  const reference = normalizeForScoring(canonicalizeLatex(referenceTranscript));

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate.split(""), reference.split("")) / reference.length;
}

/**
 * Sentence punctuation neutralized by the acoustic CER (issue #134). These are
 * the only marks whose presence or absence must not penalize a candidate that
 * heard the words correctly but did not reproduce the punctuation. Deliberately
 * NOT here — and therefore still scored by the acoustic metric — are
 * apostrophes, hyphens, digits, Greek letters, math symbols, parentheses, and
 * the LaTeX `$` delimiter.
 */
const SENTENCE_PUNCTUATION = /[.,;:!?…]/gu;

/**
 * Normalizes a text for ACOUSTIC scoring (issue #134): the exact strict
 * normalization used by CER/WER (LaTeX-canonicalized, trimmed, case-folded),
 * then every sentence-punctuation mark replaced by a separating space and runs
 * of whitespace collapsed. The strict and acoustic CER therefore differ ONLY by
 * this punctuation neutralization.
 */
export function normalizeForAcousticScoring(value: string): string {
  return normalizeForScoring(canonicalizeLatex(value))
    .replace(SENTENCE_PUNCTUATION, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Character error rate that ignores sentence punctuation (issue #134). Same edit
 * distance as `calculateCharacterErrorRate`, but both texts pass through
 * `normalizeForAcousticScoring` first, so `racine carrée de a, plus b` scores
 * zero against `racine carrée de a plus b`. It is kept separate from the strict
 * CER, which stays the exact-fidelity measure of the output.
 */
export function calculateAcousticCharacterErrorRate(
  candidateTranscript: string,
  referenceTranscript: string,
): number {
  const candidate = normalizeForAcousticScoring(candidateTranscript);
  const reference = normalizeForAcousticScoring(referenceTranscript);

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate.split(""), reference.split("")) / reference.length;
}

export function calculateWordErrorRate(candidateTranscript: string, referenceTranscript: string): number {
  const candidate = tokenizeWords(candidateTranscript);
  const reference = tokenizeWords(referenceTranscript);

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate, reference) / reference.length;
}

function tokenizeWords(value: string): string[] {
  // Canonicalize LaTeX before word tokenization, for the same reason CER does.
  return normalizeForScoring(canonicalizeLatex(value))
    .split(/\s+/)
    .filter((word) => word.length > 0);
}
