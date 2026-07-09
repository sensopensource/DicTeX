import type { BenchmarkCandidateIdentity, CorrectionKind, SttBenchmarkSetSplit } from "./localEvents.js";
import type { SttBenchmarkScore, SttBenchmarkSetSegmentOutcome } from "./benchmarkTypes.js";

/**
 * Small presentation helpers shared by apps/lab's Benchmark/Dataset views.
 * Pure string formatting only, no I/O — importable from renderer (browser)
 * code, so this module only TYPE-imports from ./localEvents (never a runtime
 * import, which would pull node:fs into the renderer bundle). Copied from
 * apps/dictex's renderer (main.tsx) at the time of the DicTeX/Lab split;
 * apps/dictex's renderer keeps its own private copies unchanged (see PR
 * description).
 */

export const CORRECTION_KIND_OPTIONS: { value: CorrectionKind; label: string }[] = [
  { value: "acoustic", label: "Acoustic" },
  { value: "math_transform", label: "Math notation" },
  { value: "normalization", label: "Cleanup" },
  { value: "rephrasing", label: "Rephrase" },
];

export function formatCorrectionKind(kind: CorrectionKind): string {
  return CORRECTION_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

export function formatDatasetCorrectionKind(correctionKind: string): string {
  return isCorrectionKind(correctionKind) ? formatCorrectionKind(correctionKind) : correctionKind;
}

/**
 * String-typed correction-kind guard for UI code (a `<select>` value is a
 * string). localEvents also exports an `unknown`-typed guard for event data;
 * kept separate here so this browser-safe module needs no runtime import from
 * the node-touching localEvents module.
 */
export function isCorrectionKind(value: string): value is CorrectionKind {
  return (
    value === "acoustic" ||
    value === "math_transform" ||
    value === "normalization" ||
    value === "rephrasing"
  );
}

export function formatAudioDuration(durationSeconds: number | null): string {
  return durationSeconds === null ? "-" : `${durationSeconds.toFixed(2)} s`;
}

export function formatLatency(durationMs: number | null): string {
  return durationMs === null ? "-" : `${durationMs} ms`;
}

export function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatScore(score: SttBenchmarkScore): string {
  return `${score.metric.toUpperCase()} ${(score.value * 100).toFixed(1)}%`;
}

export function formatBatchOutcomeScore(outcome: SttBenchmarkSetSegmentOutcome): string {
  const scores = outcome.results
    .map((result) => result.score)
    .filter((score): score is SttBenchmarkScore => score !== null);
  if (scores.length === 0) {
    return "";
  }

  const bestCer = Math.min(...scores.map((score) => score.value));
  return ` · best CER ${(bestCer * 100).toFixed(1)}%`;
}

export function formatCandidateIdentity(candidate: BenchmarkCandidateIdentity): string {
  return `${candidate.stage}:${candidate.provider}/${candidate.model}${candidate.variant ? ` (${candidate.variant})` : ""}`;
}

export function formatCandidateIdentityKey(candidate: BenchmarkCandidateIdentity): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

export function formatRatePercent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

export function formatBenchmarkSetSplit(split: SttBenchmarkSetSplit): string {
  if (split === "train_candidate_pool") {
    return "train pool";
  }

  if (split === "test_frozen") {
    return "test frozen";
  }

  return "validation";
}

export function isSttBenchmarkSetSplit(value: string): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}
