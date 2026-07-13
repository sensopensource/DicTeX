import {
  getSttBenchmarkResultsForRun,
  getSttBenchmarkRun,
  type BenchmarkRunCandidate,
  type BenchmarkRunFailure,
  type LocalEvent,
  type SttBenchmarkSetSplit,
  type SttScoredBenchmarkResult,
} from "./localEvents.js";
import { summarizeSttBenchmarkRun, type SttBenchmarkCandidateSummary } from "./benchmarkSummary.js";
import type { BenchmarkStage, SttBenchmarkResult } from "./benchmarkTypes.js";
import { calculateCharacterErrorRate } from "./sttScoring.js";

/**
 * The read-only projection of ONE tracked STT benchmark run (issue #138): its
 * frozen snapshot, the candidates it launched, every candidate output it
 * logged, its failures and its per-candidate summary.
 *
 * Everything here is derived from the run's own `stt_benchmark_run_started`
 * snapshot and its `run_id`-tagged results. Current split membership, current
 * corrections and the results of any other run are never consulted, so two runs
 * of the same split stay isolated and reopening an old run shows exactly what it
 * measured — never a newer reference. This is what lets the Results view own the
 * result while the Experiments view owns only the launch.
 */

export type SttBenchmarkRunSegmentStatus = "done" | "failed" | "missing";

export type SttBenchmarkRunSegmentDetail = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  /** The acoustic reference frozen at run start (#130): null when the segment had none. */
  referenceTranscript: string | null;
  correctionCreatedAt: string | null;
  /**
   * `done` — the segment ran and logged at least one candidate output;
   * `failed` — the run recorded a failure for it (partial outputs may still
   * exist for the candidates that ran before the failure);
   * `missing` — it is in the snapshot but was never executed (an interrupted
   * run), which the run-finished failures list is what distinguishes.
   */
  status: SttBenchmarkRunSegmentStatus;
  error: string | null;
  /** One entry per candidate that logged an output, in the run's candidate order. */
  results: SttBenchmarkResult[];
};

export type SttBenchmarkRunDetail = {
  runId: string;
  createdAt: string | null;
  finishedAt: string | null;
  stage: string;
  datasetKind: string;
  split: SttBenchmarkSetSplit;
  finished: boolean;
  done: number | null;
  failed: number | null;
  candidates: BenchmarkRunCandidate[];
  promptDefinitions: { id: string; displayName: string; promptText: string }[];
  failures: BenchmarkRunFailure[];
  segments: SttBenchmarkRunSegmentDetail[];
  summary: SttBenchmarkCandidateSummary[];
};

const BENCHMARK_STAGES: BenchmarkStage[] = [
  "stt",
  "normalization",
  "segment_classification",
  "math_transform",
  "correction_suggestion",
];

function toBenchmarkStage(value: string): BenchmarkStage | null {
  return BENCHMARK_STAGES.find((stage) => stage === value) ?? null;
}

function segmentKey(sessionId: string, segmentId: string): string {
  return `${sessionId}/${segmentId}`;
}

function candidateKey(candidate: { stage: string; provider: string; model: string; variant: string | null }): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

/**
 * Rebuilds the live `SttBenchmarkResult` shape from a logged result, scoring it
 * against the run's FROZEN reference rather than the score stored on the event:
 * same rule as summarizeSttBenchmarkRun, so the outputs a human reads and the
 * numbers in the summary table can never disagree, and a run recorded before
 * #130/#134 is re-read through today's reference rule without rewriting history.
 */
function toRunResult(
  result: SttScoredBenchmarkResult,
  stage: BenchmarkStage,
  audioRef: string,
  referenceTranscript: string | null,
  correctionCreatedAt: string | null,
): SttBenchmarkResult {
  const candidate = {
    stage,
    provider: result.candidate.provider,
    model: result.candidate.model,
    ...(result.candidate.variant === null ? {} : { variant: result.candidate.variant }),
  };

  return {
    sessionId: result.sessionId,
    segmentId: result.segmentId,
    audioRef,
    candidate,
    stage,
    provider: result.candidate.provider,
    model: result.candidate.model,
    variant: result.candidate.variant,
    sttEngine: result.sttEngine ?? result.candidate.provider,
    sttModel: result.sttModel ?? result.candidate.model,
    sttLanguage: result.sttLanguage ?? "",
    transcript: result.transcript,
    audioDurationSeconds: result.audioDurationSeconds,
    transcriptionDurationMs: result.transcriptionDurationMs ?? 0,
    score:
      referenceTranscript === null
        ? null
        : {
            stage: "stt",
            metric: "cer",
            value: calculateCharacterErrorRate(result.transcript, referenceTranscript),
            referenceTranscript,
            correctionCreatedAt,
          },
  };
}

/**
 * Builds the full detail of one tracked run, or null when `runId` names no run.
 */
export function buildSttBenchmarkRunDetail(events: LocalEvent[], runId: string): SttBenchmarkRunDetail | null {
  const run = getSttBenchmarkRun(events, runId);
  if (!run) {
    return null;
  }

  const results = getSttBenchmarkResultsForRun(events, runId, run.snapshot);
  const resultsBySegment = new Map<string, Map<string, SttScoredBenchmarkResult>>();
  for (const result of results) {
    const key = segmentKey(result.sessionId, result.segmentId);
    const byCandidate = resultsBySegment.get(key) ?? new Map<string, SttScoredBenchmarkResult>();
    byCandidate.set(candidateKey(result.candidate), result);
    resultsBySegment.set(key, byCandidate);
  }

  const failuresBySegment = new Map(
    (run.finished?.failures ?? []).map((failure) => [segmentKey(failure.sessionId, failure.segmentId), failure.error]),
  );

  const segments = run.snapshot.map((member) => {
    const key = segmentKey(member.sessionId, member.segmentId);
    const byCandidate = resultsBySegment.get(key) ?? new Map<string, SttScoredBenchmarkResult>();
    const error = failuresBySegment.get(key) ?? null;

    // Ordered by the run's own candidate list, so the outputs of a segment read
    // in the same order as the candidates the run announced.
    const segmentResults = run.candidates
      .map((candidate) => {
        const result = byCandidate.get(candidateKey(candidate));
        const stage = toBenchmarkStage(candidate.stage);
        if (!result || !stage) {
          return null;
        }
        return toRunResult(result, stage, member.audioRef, member.referenceTranscript, member.correctionCreatedAt);
      })
      .filter((result): result is SttBenchmarkResult => result !== null);

    let status: SttBenchmarkRunSegmentStatus = "missing";
    if (error !== null) {
      status = "failed";
    } else if (segmentResults.length > 0) {
      status = "done";
    }

    return {
      sessionId: member.sessionId,
      segmentId: member.segmentId,
      audioRef: member.audioRef,
      referenceTranscript: member.referenceTranscript,
      correctionCreatedAt: member.correctionCreatedAt,
      status,
      error,
      results: segmentResults,
    };
  });

  const summary = summarizeSttBenchmarkRun(events, runId);

  return {
    runId: run.runId,
    createdAt: run.createdAt,
    finishedAt: run.finished ? run.finished.createdAt : null,
    stage: run.stage,
    datasetKind: run.datasetKind,
    split: run.split,
    finished: run.finished !== null,
    done: run.finished ? run.finished.done : null,
    failed: run.finished ? run.finished.failed : null,
    candidates: run.candidates,
    promptDefinitions: run.promptDefinitions,
    failures: run.finished ? run.finished.failures : [],
    segments,
    summary: summary ? summary.candidates : [],
  };
}
