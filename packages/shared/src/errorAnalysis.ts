import type { SttBenchmarkResult, SttBenchmarkSetSegmentOutcome } from "./benchmarkTypes.js";

/**
 * Lightweight STT benchmark error analysis (issue #41), moved here so
 * apps/lab's Benchmark view can reuse it without copy-pasting apps/dictex's
 * renderer implementation. apps/dictex's own renderer keeps its existing
 * private copy unchanged (see the PR description) — this module is the
 * canonical version for new consumers. Semantics are unchanged from the
 * original: deterministic, local heuristics only, not a scoring system.
 */

export type SttErrorCategory =
  | "empty_output"
  | "high_cer"
  | "symbol_mismatch"
  | "keyword_mismatch"
  | "latency_outlier";

export type SttErrorExample = {
  sessionId: string;
  segmentId: string;
  category: SttErrorCategory;
  detail: string;
  transcript: string;
  referenceTranscript: string | null;
  cer: number | null;
  transcriptionDurationMs: number;
};

export type CandidateErrorAnalysis = {
  candidateKey: string;
  candidateLabel: string;
  scoredResultCount: number;
  categoryCounts: Record<SttErrorCategory, number>;
  examples: SttErrorExample[];
};

export const ERROR_CATEGORY_LABELS: Record<SttErrorCategory, string> = {
  empty_output: "Empty output",
  high_cer: "High CER",
  symbol_mismatch: "Symbol/letter mismatch",
  keyword_mismatch: "French math keyword mismatch",
  latency_outlier: "Latency outlier",
};

const HIGH_CER_THRESHOLD = 0.3;
const LATENCY_OUTLIER_MULTIPLIER = 2;
const LATENCY_OUTLIER_FLOOR_MS = 500;
const MAX_EXAMPLES_PER_CANDIDATE = 4;

// Small local list; not exhaustive on purpose (heuristic diagnostic, not NLP).
const FRENCH_MATH_KEYWORDS = [
  "plus",
  "moins",
  "fois",
  "divise",
  "carre",
  "racine",
  "egal",
  "egale",
  "fraction",
  "puissance",
  "pi",
  "virgule",
  "parenthese",
  "racine carree",
  "au carre",
];

export function formatBenchmarkCandidate(result: SttBenchmarkResult): string {
  return `${result.stage}:${result.provider}/${result.model}${result.variant ? ` (${result.variant})` : ""}`;
}

export function formatBenchmarkCandidateKey(result: SttBenchmarkResult): string {
  return `${result.stage}/${result.provider}/${result.model}/${result.variant ?? ""}`;
}

function normalizeAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeForKeywordMatch(value: string): string {
  return ` ${normalizeAccents(value.toLowerCase()).replace(/[^a-z0-9]+/g, " ")} `;
}

function getSingleCharTokens(value: string): Set<string> {
  return new Set(
    normalizeAccents(value.toLowerCase())
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length === 1),
  );
}

function findMissingSymbolTokens(transcript: string, referenceTranscript: string): string[] {
  const referenceTokens = getSingleCharTokens(referenceTranscript);
  const transcriptTokens = getSingleCharTokens(transcript);
  return Array.from(referenceTokens).filter((token) => !transcriptTokens.has(token));
}

function findMissingKeywords(transcript: string, referenceTranscript: string): string[] {
  const normalizedReference = normalizeForKeywordMatch(referenceTranscript);
  const normalizedTranscript = normalizeForKeywordMatch(transcript);
  return FRENCH_MATH_KEYWORDS.filter(
    (keyword) => normalizedReference.includes(` ${keyword} `) && !normalizedTranscript.includes(` ${keyword} `),
  );
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function createEmptyCategoryCounts(): Record<SttErrorCategory, number> {
  return {
    empty_output: 0,
    high_cer: 0,
    symbol_mismatch: 0,
    keyword_mismatch: 0,
    latency_outlier: 0,
  };
}

/**
 * Deterministic, local heuristics only (see issue #41): no LaTeX parsing, no
 * semantic math equivalence, no model training. Flags are diagnostics to help
 * distinguish quality problems from latency problems, not a scoring system.
 */
export function analyzeBatchErrors(outcomes: SttBenchmarkSetSegmentOutcome[]): CandidateErrorAnalysis[] {
  const byCandidate = new Map<
    string,
    { candidateLabel: string; entries: { sessionId: string; segmentId: string; result: SttBenchmarkResult }[] }
  >();

  for (const outcome of outcomes) {
    if (outcome.status !== "done") {
      continue;
    }

    for (const result of outcome.results) {
      const key = formatBenchmarkCandidateKey(result);
      const bucket = byCandidate.get(key) ?? { candidateLabel: formatBenchmarkCandidate(result), entries: [] };
      bucket.entries.push({ sessionId: outcome.sessionId, segmentId: outcome.segmentId, result });
      byCandidate.set(key, bucket);
    }
  }

  const analyses: CandidateErrorAnalysis[] = [];

  for (const [candidateKey, bucket] of byCandidate) {
    const candidateMedianDurationMs = median(bucket.entries.map((entry) => entry.result.transcriptionDurationMs));
    const categoryCounts = createEmptyCategoryCounts();
    const examples: SttErrorExample[] = [];

    for (const { sessionId, segmentId, result } of bucket.entries) {
      const flagged: { category: SttErrorCategory; detail: string }[] = [];

      if (result.transcript.trim().length === 0) {
        flagged.push({ category: "empty_output", detail: "STT candidate returned no text" });
      }

      if (result.score && result.score.value > HIGH_CER_THRESHOLD) {
        flagged.push({
          category: "high_cer",
          detail: `CER ${(result.score.value * 100).toFixed(1)}% above ${(HIGH_CER_THRESHOLD * 100).toFixed(0)}% threshold`,
        });
      }

      if (result.score) {
        const missingSymbols = findMissingSymbolTokens(result.transcript, result.score.referenceTranscript);
        if (missingSymbols.length > 0) {
          flagged.push({
            category: "symbol_mismatch",
            detail: `Missing symbol/letter token(s): ${missingSymbols.join(", ")}`,
          });
        }

        const missingKeywords = findMissingKeywords(result.transcript, result.score.referenceTranscript);
        if (missingKeywords.length > 0) {
          flagged.push({
            category: "keyword_mismatch",
            detail: `Missing keyword(s): ${missingKeywords.join(", ")}`,
          });
        }
      }

      if (
        candidateMedianDurationMs > 0 &&
        result.transcriptionDurationMs > candidateMedianDurationMs * LATENCY_OUTLIER_MULTIPLIER &&
        result.transcriptionDurationMs - candidateMedianDurationMs > LATENCY_OUTLIER_FLOOR_MS
      ) {
        flagged.push({
          category: "latency_outlier",
          detail: `${result.transcriptionDurationMs} ms vs candidate median ${Math.round(candidateMedianDurationMs)} ms`,
        });
      }

      for (const flag of flagged) {
        categoryCounts[flag.category] += 1;
        examples.push({
          sessionId,
          segmentId,
          category: flag.category,
          detail: flag.detail,
          transcript: result.transcript,
          referenceTranscript: result.score?.referenceTranscript ?? null,
          cer: result.score?.value ?? null,
          transcriptionDurationMs: result.transcriptionDurationMs,
        });
      }
    }

    const totalFlags = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
    if (totalFlags === 0) {
      continue;
    }

    analyses.push({
      candidateKey,
      candidateLabel: bucket.candidateLabel,
      scoredResultCount: bucket.entries.filter((entry) => entry.result.score !== null).length,
      categoryCounts,
      examples: examples.slice(0, MAX_EXAMPLES_PER_CANDIDATE),
    });
  }

  return analyses.sort((left, right) => left.candidateLabel.localeCompare(right.candidateLabel));
}
