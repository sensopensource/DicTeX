import { extractCommands } from "./commands.js";
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
 *
 * On a `math_transform` pair BOTH transcripts additionally pass through
 * `extractCommands` (issue #92): the store holds the canonical command words, and
 * the sentinel exists only in the exported training pair, so the seq2seq is
 * trained on the same convention `apps/dictex`'s normalizer serves. An `acoustic`
 * pair is never substituted — its Layer 1 stays verbatim for the STT model.
 *
 * `originalSttOutput` preserves the raw STT output even when the correction's own
 * `rawTranscript` is a later literal-correct transcript (chained #66 corrections),
 * so every record stays traceable to the transcription that produced it. It is
 * provenance, never a training input, and is never substituted.
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
        // Command-word substitution (issue #92). The event store holds the
        // canonical words in full; sentinels are introduced only here, when the
        // training pair is built, so `apps/dictex`'s normalizer and this export
        // share ONE command table (packages/shared/commands.ts). Applied to BOTH
        // layers of a `math_transform` pair (input = literal Layer 1, target =
        // notation Layer 2) so the seq2seq sees the sentinel on both sides and
        // learns to pass it through. NEVER applied to an `acoustic` pair: Layer 1
        // is verbatim forever and its command words must stay spelled out for the
        // STT model to transcribe them. Because substitution happens at export,
        // regenerating after adding a command retroactively fixes every pair.
        const substitute = correction.correctionKind === "math_transform";
        const rawTranscript = substitute
          ? extractCommands(correction.rawTranscript)
          : correction.rawTranscript;
        const correctedTranscript = substitute
          ? extractCommands(correction.correctedTranscript)
          : correction.correctedTranscript;

        const record: SttDatasetRecord = {
          split,
          sessionId: segment.sessionId,
          segmentId: segment.segmentId,
          audioRef: segment.audioRef,
          correctionKind: correction.correctionKind,
          rawTranscript,
          correctedTranscript,
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
