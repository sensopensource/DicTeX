import type { BenchmarkCandidateIdentity, CorrectionKind, SttBenchmarkSetSplit } from "./localEvents.js";
import type { BenchmarkRunListEntry, SttBenchmarkScore } from "./benchmarkTypes.js";

/**
 * Small presentation helpers shared by apps/lab's Benchmark/Dataset views.
 * Pure string formatting only, no I/O — importable from renderer (browser)
 * code, so this module only TYPE-imports from the node-touching shared modules
 * (never a runtime import, which would pull node built-ins into renderer
 * bundles).
 */

export type SegmentIdentity = {
  sessionId: string;
  segmentId: string;
};

/** A provider + model pair selected by value, without separator-joined keys. */
export type CandidateModelChoice = {
  providerLabel: string;
  modelLabel: string;
};

export type CandidateModelOption = CandidateModelChoice & {
  runtimeLabel: string;
};

export type CandidateModelGroup = {
  providerLabel: string;
  models: CandidateModelChoice[];
};

export type TimestampFormatOptions = {
  missingLabel?: string;
  style?: "compact" | "full";
};

export function getSegmentKey(segment: SegmentIdentity, options: { separator?: string } = {}): string {
  return `${segment.sessionId}${options.separator ?? "/"}${segment.segmentId}`;
}

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

export function formatAudioDuration(
  durationSeconds: number | null,
  options: { rejectNonFinite?: boolean } = {},
): string {
  return durationSeconds === null || (options.rejectNonFinite && !Number.isFinite(durationSeconds))
    ? "-"
    : `${durationSeconds.toFixed(2)} s`;
}

export function formatLatency(
  durationMs: number | null,
  options: { rejectNonFinite?: boolean; round?: boolean } = {},
): string {
  if (durationMs === null || (options.rejectNonFinite && !Number.isFinite(durationMs))) {
    return "-";
  }

  return `${options.round ? Math.round(durationMs) : durationMs} ms`;
}

export function formatTimestamp(timestamp: string | null, options: TimestampFormatOptions = {}): string {
  if (!timestamp) {
    return options.missingLabel ?? "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return options.style === "full"
    ? date.toLocaleString()
    : date.toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function formatBenchmarkRunOption(run: BenchmarkRunListEntry): string {
  const when = run.createdAt ? formatTimestamp(run.createdAt) : run.runId;
  const status = run.finished ? `${run.done ?? 0} done / ${run.failed ?? 0} failed` : "unfinished";
  const stage = run.stage === "math_transform" ? "Normalizer" : "STT";
  return `${when} · ${stage} · ${run.snapshotSize} member${run.snapshotSize === 1 ? "" : "s"} · ${status}`;
}

export function sameCandidateModel(left: CandidateModelChoice, right: CandidateModelChoice): boolean {
  return left.providerLabel === right.providerLabel && left.modelLabel === right.modelLabel;
}

export function candidateOptionMatchesModel(option: CandidateModelOption, model: CandidateModelChoice): boolean {
  return sameCandidateModel(option, model);
}

export function groupCandidateModelsByProvider(options: CandidateModelOption[]): CandidateModelGroup[] {
  const byProvider = new Map<string, CandidateModelChoice[]>();
  for (const option of options) {
    const models = byProvider.get(option.providerLabel) ?? [];
    if (!models.some((model) => model.modelLabel === option.modelLabel)) {
      models.push({ providerLabel: option.providerLabel, modelLabel: option.modelLabel });
    }
    byProvider.set(option.providerLabel, models);
  }

  return Array.from(byProvider.entries()).map(([providerLabel, models]) => ({ providerLabel, models }));
}

export function getCandidateRuntimeLabels(options: CandidateModelOption[]): string[] {
  const labels: string[] = [];
  for (const option of options) {
    if (!labels.includes(option.runtimeLabel)) {
      labels.push(option.runtimeLabel);
    }
  }

  return labels;
}

export function formatScore(score: SttBenchmarkScore): string {
  return `${score.metric.toUpperCase()} ${(score.value * 100).toFixed(1)}%`;
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
