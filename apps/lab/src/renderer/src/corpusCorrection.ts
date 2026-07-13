import type { CorrectionKind, ReconstructedSegment } from "@dictex/shared";

/**
 * Corpus (issue #137) qualifies a segment through exactly two explicit layers,
 * each opened by its own button — never through a free-form kind selector:
 *
 *   Layer 1  acoustic        raw_transcript = raw STT, corrected = literal words
 *   Layer 2  math_transform  raw_transcript = Layer 1, corrected = notation
 *
 * `correction_kind` and `raw_transcript` are two halves of ONE decision: an
 * `acoustic` correction whose raw_transcript is already a literal Layer 1 (or a
 * `math_transform` whose raw_transcript is the raw STT) is a silently corrupt
 * record — it breaks the Layer 1 -> Layer 2 chaining of #101 and violates
 * DEC-COUCHE1-001 (docs/product-decisions.md): Layer 1 stays the spoken word,
 * never a compact notation. Such a pair would poison the acoustic dataset used
 * for a future STT fine-tuning, and nothing downstream could detect it.
 *
 * So the pair is derived here, together, from the layer the human clicked, and
 * the caller stores it as one indivisible value. Same discipline (and same
 * reason) as `planDatasetBuilderSave` in apps/lab/src/main/datasetBuilder.ts,
 * which refuses to write an implicit layer.
 */
export type CorpusCorrectionLayer = "layer1" | "layer2";

export type CorpusCorrectionPlan = {
  correctionKind: CorrectionKind;
  rawTranscript: string;
  draft: string;
};

type CorpusCorrectionSegment = Pick<ReconstructedSegment, "transcript" | "correctionsByKind">;

/**
 * Returns the (correctionKind, rawTranscript) pair a layer must write, plus the
 * draft the editor opens on (the existing correction of that same layer when
 * there is one, so re-editing shows what was saved, else its own input).
 *
 * Returns null for Layer 2 on a segment with no Layer 1: Layer 2's input IS
 * Layer 1, so without it there is no honest raw_transcript to write. Falling
 * back to the raw STT would write a math_transform pair that skips the literal
 * layer entirely. The UI already disables the button in that state; this keeps
 * the invariant true even if it did not.
 */
export function planCorpusCorrection(
  segment: CorpusCorrectionSegment,
  layer: CorpusCorrectionLayer,
): CorpusCorrectionPlan | null {
  const correctionKind: CorrectionKind = layer === "layer1" ? "acoustic" : "math_transform";
  const findCorrection = (kind: CorrectionKind): string | null =>
    segment.correctionsByKind.find((correction) => correction.correctionKind === kind)?.correctedTranscript ?? null;

  const rawTranscript = layer === "layer1" ? segment.transcript : findCorrection("acoustic");
  if (rawTranscript === null) {
    return null;
  }

  return {
    correctionKind,
    rawTranscript,
    draft: findCorrection(correctionKind) ?? rawTranscript,
  };
}
