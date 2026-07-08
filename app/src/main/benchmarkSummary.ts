import {
  getSttBenchmarkResultsForSplit,
  getSttBenchmarkSetSegments,
  type BenchmarkCandidateIdentity,
  type LocalEvent,
  type SttBenchmarkSetSplit,
  type SttScoredBenchmarkResult,
} from "./localEvents.js";
import { calculateWordErrorRate } from "./sttScoring.js";

export type SttBenchmarkCandidateSummary = {
  candidate: BenchmarkCandidateIdentity;
  resultCount: number;
  missingCount: number;
  scoredCount: number;
  meanCer: number | null;
  medianCer: number | null;
  meanWer: number | null;
  medianWer: number | null;
  meanLatencyMs: number | null;
};

export type SttBenchmarkCandidateSummaryResponse = {
  split: SttBenchmarkSetSplit;
  totalSegments: number;
  candidates: SttBenchmarkCandidateSummary[];
};

/**
 * Aggregates stt_benchmark_result events by candidate identity for a corrected
 * benchmark split. CER is read from the stored score; WER is derived here from
 * the stored transcript + reference so no new event fields are needed.
 * "Missing" counts segments in the split that have no result for a candidate;
 * a run that failed mid-flight never appended an event, so it is
 * indistinguishable from "not run yet" and is reported the same way.
 */
export function summarizeSttBenchmarkResultsByCandidate(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): SttBenchmarkCandidateSummaryResponse {
  const totalSegments = getSttBenchmarkSetSegments(events, split).length;
  const results = getSttBenchmarkResultsForSplit(events, split);

  const byCandidateKey = new Map<
    string,
    { candidate: BenchmarkCandidateIdentity; results: SttScoredBenchmarkResult[] }
  >();

  for (const result of results) {
    const key = candidateKey(result.candidate);
    const entry = byCandidateKey.get(key) ?? { candidate: result.candidate, results: [] };
    entry.results.push(result);
    byCandidateKey.set(key, entry);
  }

  const candidates: SttBenchmarkCandidateSummary[] = Array.from(byCandidateKey.values())
    .map(({ candidate, results: candidateResults }) => {
      const cerValues = candidateResults
        .filter((result) => result.scoreMetric === "cer" && result.scoreValue !== null)
        .map((result) => result.scoreValue as number);

      const werValues = candidateResults
        .filter((result) => result.referenceTranscript !== null)
        .map((result) => calculateWordErrorRate(result.transcript, result.referenceTranscript as string));

      const latencyValues = candidateResults
        .map((result) => result.transcriptionDurationMs)
        .filter((value): value is number => value !== null);

      return {
        candidate,
        resultCount: candidateResults.length,
        missingCount: Math.max(totalSegments - candidateResults.length, 0),
        scoredCount: cerValues.length,
        meanCer: mean(cerValues),
        medianCer: median(cerValues),
        meanWer: mean(werValues),
        medianWer: median(werValues),
        meanLatencyMs: mean(latencyValues),
      };
    })
    .sort((left, right) => {
      if (left.candidate.stage !== right.candidate.stage) {
        return left.candidate.stage < right.candidate.stage ? -1 : 1;
      }
      if (left.candidate.provider !== right.candidate.provider) {
        return left.candidate.provider < right.candidate.provider ? -1 : 1;
      }
      if (left.candidate.model !== right.candidate.model) {
        return left.candidate.model < right.candidate.model ? -1 : 1;
      }
      return (left.candidate.variant ?? "") < (right.candidate.variant ?? "") ? -1 : 1;
    });

  return { split, totalSegments, candidates };
}

function candidateKey(candidate: BenchmarkCandidateIdentity): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
