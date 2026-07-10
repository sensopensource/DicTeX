import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extractCommands } from "./commands.js";
import { canonicalizeLatex } from "./latex.js";
import { createTranscriptNormalizer, type NormalizeOptions } from "./normalizer.js";
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
 * On a `math_transform` pair the two sides are built differently (issue #100):
 *
 * - `rawTranscript` (the training INPUT, what layer 3 receives at inference) is
 *   the stored Layer 1 replayed through the FULL normalizer pipeline —
 *   dictionary -> command extraction -> regex — via the one shared normalizer
 *   `apps/dictex` serves. So "x au carré plus deux" is exported as "x² plus deux":
 *   the regex rule that DicTeX would have applied is applied here too, and layer 3
 *   is trained on the residual it will actually be asked to fix, not on raw
 *   verbatim. Command extraction is part of that pipeline, so the sentinel is
 *   present exactly as before (#92).
 * - `correctedTranscript` (the human-authored TARGET, Layer 2) passes through
 *   `extractCommands` ONLY — never the dictionary or regex. Layer 2 is the
 *   validated notation and is independent of the rules version, so it must not be
 *   rewritten by them; it only receives the same command-word substitution so the
 *   seq2seq sees the sentinel on both sides and learns to pass it through.
 *
 * An `acoustic` pair is never touched — its Layer 1 stays verbatim for the STT
 * model, and neither the normalizer nor `extractCommands` is applied to it.
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

/**
 * Content fingerprint of the normalizer configuration that built the
 * `math_transform` training INPUTS (issue #100). Because the input is now the
 * pipeline output over Layer 1, adding or editing a regex rule changes every
 * input — by design — so a dataset must be traceable to the pipeline that
 * produced it. A sha256 (hex) of each config file's bytes is enough.
 *
 * `null` means the file was absent at export time, which is a normal, meaningful
 * state, not an error:
 * - `dictionaryHash: null` — no personal dictionary; that layer was passthrough.
 * - `rulesHash: null` — no user rules file; the built-in `DEFAULT_RULES` applied,
 *   traceable through the source/git version of `@dictex/shared`.
 *
 * The human-authored TARGET (Layer 2) is independent of this version and never
 * changes — corrections never rot.
 */
export type NormalizerVersion = {
  dictionaryHash: string | null;
  rulesHash: string | null;
};

export type SttDatasetExport = {
  createdAt: string;
  /** Base STT candidate selected at export time (embedded on every record). Null
   * when no selection has been recorded yet — export still proceeds. */
  selectedCandidate: BenchmarkCandidateIdentity | null;
  selectionReason: string | null;
  /** Fingerprint of the dictionary/rules that produced the `math_transform`
   * inputs, recorded alongside `selectedCandidate` so the dataset is traceable to
   * the pipeline version that built it (issue #100). */
  normalizerVersion: NormalizerVersion;
  splits: SttDatasetSplitGroup[];
  totalRecords: number;
  /** Correction events skipped because they carry no correction_kind and cannot
   * be routed into a kind-partitioned dataset. Reported, never silent. */
  skippedUntypedCorrections: number;
};

/**
 * Options for building the export. The dictionary/rules paths point at the
 * SOURCE (DicTeX) data folder's normalizer config and are read READ-ONLY (the
 * normalizer only reads them); the Lab never writes into DicTeX's folder (see
 * `docs/product-decisions.md`). They are the same `NormalizeOptions` DicTeX
 * passes at inference, which is what makes the exported `math_transform` input
 * equal to what DicTeX would serve for the same Layer 1.
 */
export type BuildSttDatasetExportOptions = NormalizeOptions;

/**
 * Builds the corrected STT dataset export from the append-only event log without
 * mutating it. For each split it reads every corrected segment and, per segment,
 * the latest correction of EACH kind (not just the single latest event), so
 * chained acoustic + math_transform corrections stay separable — the core
 * data-integrity requirement for this export (see AGENTS.md). Records are grouped
 * by split, then by correction kind, so acoustic (STT) and math_transform
 * (normalizer) datasets land in distinct files.
 *
 * For a `math_transform` pair the training INPUT is built by replaying the full
 * normalizer pipeline over the stored Layer 1 (issue #100), using the ONE shared
 * normalizer `apps/dictex` serves — so layer 3 trains on exactly what it will be
 * given at inference. The config that produced those inputs is fingerprinted into
 * `normalizerVersion`. Async because loading the dictionary/rules touches disk.
 */
export async function buildSttDatasetExport(
  events: LocalEvent[],
  createdAt: string,
  options: BuildSttDatasetExportOptions,
): Promise<SttDatasetExport> {
  const selection = getLatestSttCandidateSelection(events);
  const selectedCandidate = selection?.candidate ?? null;
  const selectionReason = selection?.selectionReason ?? null;

  // Load the dictionary + rules once and reuse the pipeline for every record.
  // `createTranscriptNormalizer` is the exact same fold DicTeX runs through
  // `normalizeTranscript`, so the exported input and the served text are
  // byte-identical for a given config — the invariant this issue exists to
  // create (asserted directly in datasetExport.test.ts).
  const normalizer = await createTranscriptNormalizer(options);
  const normalizerVersion = await fingerprintNormalizerConfig(options);

  let totalRecords = 0;
  let skippedUntypedCorrections = 0;

  const splits: SttDatasetSplitGroup[] = [];
  for (const split of STT_DATASET_SPLITS) {
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
        // A `math_transform` pair is transformed at export; an `acoustic` pair is
        // taken verbatim (Layer 1 is the STT target and must never be normalized).
        // The event store holds plain, sentinel-free text in every case — the
        // transformation below is a pure function of the derived training pair, so
        // regenerating after a rule/command change retroactively fixes every pair
        // without touching the store.
        const isMathTransform = correction.correctionKind === "math_transform";

        // INPUT (issue #100): replay the FULL pipeline — dictionary -> command
        // extraction -> regex — over the stored Layer 1, through the one shared
        // normalizer DicTeX serves at inference. Command extraction is a pipeline
        // layer, so the sentinel is introduced here exactly as in #92; the regex
        // rule DicTeX would have applied is applied too, so layer 3 trains on the
        // residual it will actually be asked to fix.
        const rawTranscript = isMathTransform
          ? (await normalizer.normalize(correction.rawTranscript)).output
          : correction.rawTranscript;

        // TARGET: the human-authored Layer 2 notation, CANONICALIZED (issue #106)
        // then given command-word substitution ONLY (issue #92) — never the
        // dictionary or regex, which would rewrite validated notation and couple
        // the target to the rules version. `canonicalizeLatex` fixes one spelling
        // per construct (`x^2`→`x^{2}`, `\dfrac`→`\frac`, …) so the exported
        // target is byte-identical to what scoring compares against; it is a pure
        // function of the derived pair and never mutates the store. It runs before
        // `extractCommands`: canonicalization only touches `$…$` maths, while the
        // command phrases it substitutes are bare prose, so the two are disjoint.
        // The INPUT is deliberately NOT canonicalized here: it is produced by the
        // shared normalizer and must stay byte-equal to what `apps/dictex` serves
        // (the #100 train/serve invariant). LaTeX generation by the rules is #107;
        // canonicalization of the input belongs with that pipeline change.
        const correctedTranscript = isMathTransform
          ? extractCommands(canonicalizeLatex(correction.correctedTranscript))
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

    splits.push({ split, segmentCount: segments.length, correctedSegmentCount, recordCount, kinds });
  }

  return {
    createdAt,
    selectedCandidate,
    selectionReason,
    normalizerVersion,
    splits,
    totalRecords,
    skippedUntypedCorrections,
  };
}

/**
 * Fingerprint the dictionary and rules files that drive the `math_transform`
 * inputs. Reads the SAME two files the normalizer just loaded, read-only. A
 * missing file yields `null` (see `NormalizerVersion`): an absent dictionary is
 * passthrough, and absent rules mean the built-in `DEFAULT_RULES` applied.
 *
 * The two files are read once more here rather than threaded out of the
 * normalizer; for a local single-user export the window in which a config file
 * could change between the pipeline load and this hash is not a concern.
 */
async function fingerprintNormalizerConfig(options: NormalizeOptions): Promise<NormalizerVersion> {
  return {
    dictionaryHash: await hashFileIfPresent(options.dictionaryPath),
    rulesHash: await hashFileIfPresent(options.rulesPath),
  };
}

async function hashFileIfPresent(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const contents = await readFile(filePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    // Unreadable file: the normalizer already degrades this to passthrough with a
    // diagnostic, so the export must not crash either. Record it as absent.
    return null;
  }
}
