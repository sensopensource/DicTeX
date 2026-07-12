import {
  getLegacySttBenchmarkResultsForSplit,
  getSttBenchmarkResultsForRun,
  getSttBenchmarkRun,
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
 * Per-run candidate summary (issue #122): scoped to ONE tracked run's frozen
 * snapshot and its own `run_id`-tagged results, so two runs of the same split
 * at different dates stay separate and a later re-correction or membership
 * change cannot move a historical run's numbers. `createdAt`/`done`/`failed`
 * come from the run's start/finish events. Null is returned when `runId` names
 * no run.
 */
export type SttBenchmarkRunSummaryResponse = {
  runId: string;
  split: SttBenchmarkSetSplit;
  createdAt: string | null;
  datasetKind: string;
  totalSegments: number;
  candidates: SttBenchmarkCandidateSummary[];
  done: number | null;
  failed: number | null;
};

/**
 * Aggregates scored benchmark results by candidate identity. CER is read from
 * the stored score; WER is derived here from the stored transcript + reference
 * so no new event fields are needed. "Missing" counts snapshot/split segments
 * with no result for a candidate; a run that failed mid-flight never appended a
 * result event, so from this table it is indistinguishable from "not run yet"
 * and is reported the same way — the run-finished event's failures are what
 * separate a failure from an unexecuted segment (issue #122).
 */
function aggregateByCandidate(
  results: SttScoredBenchmarkResult[],
  totalSegments: number,
): SttBenchmarkCandidateSummary[] {
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

  return Array.from(byCandidateKey.values())
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
}

/**
 * Summarizes ONE tracked benchmark run (issue #122). The snapshot size and
 * candidate results are frozen to the run, so re-running, re-correcting, or
 * moving a segment between splits afterward never changes this run's summary.
 * Returns null when `runId` names no run.
 */
export function summarizeSttBenchmarkRun(
  events: LocalEvent[],
  runId: string,
): SttBenchmarkRunSummaryResponse | null {
  const run = getSttBenchmarkRun(events, runId);
  if (!run) {
    return null;
  }

  const results = getSttBenchmarkResultsForRun(events, runId, run.snapshot);

  return {
    runId: run.runId,
    split: run.split,
    createdAt: run.createdAt,
    datasetKind: run.datasetKind,
    totalSegments: run.snapshot.length,
    candidates: aggregateByCandidate(results, run.snapshot.length),
    done: run.finished ? run.finished.done : null,
    failed: run.finished ? run.finished.failed : null,
  };
}

/**
 * Summarizes only the LEGACY (pre-#122, no `run_id`) benchmark results for a
 * split. These predate run tracking; they are surfaced as legacy rather than
 * merged into any run. Modern results are summarized per run
 * (summarizeSttBenchmarkRun), never here.
 */
export function summarizeLegacySttBenchmarkResultsByCandidate(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): SttBenchmarkCandidateSummaryResponse {
  const totalSegments = getSttBenchmarkSetSegments(events, split).length;
  const results = getLegacySttBenchmarkResultsForSplit(events, split);
  return { split, totalSegments, candidates: aggregateByCandidate(results, totalSegments) };
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
