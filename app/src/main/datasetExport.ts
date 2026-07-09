import {
  CORRECTION_KIND_ORDER,
  countUntypedSttCorrections,
  getLatestSttCandidateSelection,
  getSegmentSttInfo,
  getSttBenchmarkSetSegments,
  getSttCorrectionsByKind,
  type BenchmarkCandidateIdentity,
  type CorrectionKind,
  type LocalEvent,
  type SttBenchmarkSetSplit,
} from "./localEvents.js";

/** Splits exported, in a stable order. Frozen test is exported separately from
 * the train/validation splits (one file group per split). */
export const STT_DATASET_SPLITS: SttBenchmarkSetSplit[] = [
  "train_candidate_pool",
  "validation",
  "test_frozen",
];

/**
 * One exported training pair for a corrected segment. `rawTranscript` /
 * `correctedTranscript` come from the correction event (the transform's input ->
 * target); for an `acoustic` correction the pair is audio -> literal transcript,
 * for a `math_transform` correction it is literal text -> notation.
 * `originalSttOutput` preserves the raw STT output even when the correction's own
 * `rawTranscript` is a later literal-correct transcript (chained #66 corrections),
 * so every record stays traceable to the transcription that produced it.
 */
export type SttDatasetRecord = {
  split: SttBenchmarkSetSplit;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  correctionKind: CorrectionKind;
  rawTranscript: string;
  correctedTranscript: string;
  originalSttOutput: string | null;
  language: string | null;
  sttEngine: string | null;
  sttModel: string | null;
  correctionMethod: string | null;
  correctionCreatedAt: string | null;
  selectedCandidate: BenchmarkCandidateIdentity | null;
  selectionReason: string | null;
};

export type SttDatasetKindGroup = {
  correctionKind: CorrectionKind;
  records: SttDatasetRecord[];
};

export type SttDatasetSplitGroup = {
  split: SttBenchmarkSetSplit;
  /** Segments assigned to this split with a resolvable audio reference. */
  segmentCount: number;
  /** Of those, how many produced at least one exported record. */
  correctedSegmentCount: number;
  recordCount: number;
  kinds: SttDatasetKindGroup[];
};

export type SttDatasetExport = {
  createdAt: string;
  /** Base STT candidate selected at export time (embedded on every record). Null
   * when no selection has been recorded yet — export still proceeds. */
  selectedCandidate: BenchmarkCandidateIdentity | null;
  selectionReason: string | null;
  splits: SttDatasetSplitGroup[];
  totalRecords: number;
  /** Correction events skipped because they carry no correction_kind and cannot
   * be routed into a kind-partitioned dataset. Reported, never silent. */
  skippedUntypedCorrections: number;
};

/**
 * Builds the corrected STT dataset export from the append-only event log without
 * mutating it. For each split it reads every corrected segment and, per segment,
 * the latest correction of EACH kind (not just the single latest event), so
 * chained acoustic + math_transform corrections stay separable — the core
 * data-integrity requirement for this export (see AGENTS.md). Records are grouped
 * by split, then by correction kind, so acoustic (STT) and math_transform
 * (normalizer) datasets land in distinct files.
 */
export function buildSttDatasetExport(events: LocalEvent[], createdAt: string): SttDatasetExport {
  const selection = getLatestSttCandidateSelection(events);
  const selectedCandidate = selection?.candidate ?? null;
  const selectionReason = selection?.selectionReason ?? null;

  let totalRecords = 0;
  let skippedUntypedCorrections = 0;

  const splits: SttDatasetSplitGroup[] = STT_DATASET_SPLITS.map((split) => {
    const segments = getSttBenchmarkSetSegments(events, split);
    const recordsByKind = new Map<CorrectionKind, SttDatasetRecord[]>();
    let correctedSegmentCount = 0;

    for (const segment of segments) {
      skippedUntypedCorrections += countUntypedSttCorrections(events, segment.sessionId, segment.segmentId);

      const corrections = getSttCorrectionsByKind(events, segment.sessionId, segment.segmentId);
      if (corrections.length === 0) {
        continue;
      }

      correctedSegmentCount += 1;
      const sttInfo = getSegmentSttInfo(events, segment.sessionId, segment.segmentId);

      for (const correction of corrections) {
        const record: SttDatasetRecord = {
          split,
          sessionId: segment.sessionId,
          segmentId: segment.segmentId,
          audioRef: segment.audioRef,
          correctionKind: correction.correctionKind,
          rawTranscript: correction.rawTranscript,
          correctedTranscript: correction.correctedTranscript,
          originalSttOutput: sttInfo.sttOutput,
          language: sttInfo.sttLanguage,
          sttEngine: sttInfo.sttEngine,
          sttModel: sttInfo.sttModel,
          correctionMethod: correction.correctionMethod,
          correctionCreatedAt: correction.correctionCreatedAt,
          selectedCandidate,
          selectionReason,
        };

        const bucket = recordsByKind.get(correction.correctionKind) ?? [];
        bucket.push(record);
        recordsByKind.set(correction.correctionKind, bucket);
        totalRecords += 1;
      }
    }

    const kinds: SttDatasetKindGroup[] = CORRECTION_KIND_ORDER.map((kind) => ({
      correctionKind: kind,
      records: recordsByKind.get(kind) ?? [],
    })).filter((group) => group.records.length > 0);

    const recordCount = kinds.reduce((sum, group) => sum + group.records.length, 0);

    return { split, segmentCount: segments.length, correctedSegmentCount, recordCount, kinds };
  });

  return {
    createdAt,
    selectedCandidate,
    selectionReason,
    splits,
    totalRecords,
    skippedUntypedCorrections,
  };
}
