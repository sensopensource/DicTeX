import type { SttBenchmarkSetSplit } from "@dictex/shared";

/**
 * DicTeX Lab manual two-layer dataset builder (issue #78, Pivot Phase 4). No
 * microphone anywhere: you either paste a transcription DicTeX produced
 * (running DicTeX in the background) or pick one of its recorded segments
 * from the read-only source data folder, then type the two layers by hand:
 *
 *   Layer 1 (literal, verbal)   e.g. "x au carré plus deux"
 *   Layer 2 (notation, LaTeX)   e.g. "x^2 + 2"
 *
 * Saving writes chained `stt_correction` events into the Lab's OWN store
 * (never DicTeX's folder) — the same two-layer separability principle as
 * pivot_dictex_lab_split.md / AGENTS.md "Two-layer dataset enrichment":
 *
 *   acoustic       raw_transcript = raw STT, corrected = literal (Layer 1)
 *   math_transform raw_transcript = literal (Layer 1), corrected = notation (Layer 2)
 *
 * A layer that is empty is skipped entirely (no event written for it), so the
 * acoustic and math_transform datasets stay separable: an entry can be
 * acoustic-only, math_transform-only, or both, encoded purely by which layer
 * is filled — never by a single blended tag. Layer 2 always requires Layer 1
 * (its own input), enforced below by requiring literalTranscript first.
 *
 * Internal "no audio" convention: a Lab-authored entry with no real audio
 * file (a "paste" source, always) uses NO_AUDIO_REF ("", not null) as its
 * audioRef in every event this module's caller writes. This is the only
 * representation that still satisfies @dictex/shared's
 * `getSttBenchmarkSetSegments` (and therefore `buildSttDatasetExport`), which
 * requires a STRING audioRef to place a segment into a benchmark-set split —
 * `null` is filtered out there, and packages/shared is intentionally left
 * unmodified by this feature. `apps/lab/src/main/index.ts`'s
 * `serializeDatasetRecord` maps NO_AUDIO_REF back to a `null`
 * `audio_ref`/`audio_path` pair in the exported JSONL, so the export never
 * claims a fake audio file exists for a text-only entry.
 */
export const NO_AUDIO_REF = "";

export type DatasetBuilderSource =
  | { mode: "paste" }
  | { mode: "segment"; sessionId: string; segmentId: string; audioRef: string };

export type DatasetBuilderSaveRequest = {
  source: DatasetBuilderSource;
  /** Raw STT transcript: pasted text ("paste" source) or the picked
   * segment's own transcript ("segment" source, auto-filled by the caller
   * from its read-only source data). Empty means no acoustic layer for this
   * entry (a math_transform-only, no-audio build). */
  rawTranscript: string;
  /** faster-whisper benchmark model name tagging the raw transcript's
   * origin. Only recorded (as a synthetic own-store stt_result event) for a
   * "paste" source with a non-empty rawTranscript — a "segment" source
   * already has a real stt_result event in DicTeX's data folder. */
  referenceModel: string;
  /** Layer 1: literal-correct transcript. Required to save anything at all. */
  literalTranscript: string;
  /** Layer 2: normalized notation. Requires literalTranscript to be filled;
   * empty skips the math_transform layer entirely. */
  notationTranscript: string;
  split: SttBenchmarkSetSplit;
};

export type DatasetBuilderSaveResponse = {
  sessionId: string;
  segmentId: string;
  /** null when the entry has no real audio (a "paste" source). */
  audioRef: string | null;
  savedAcoustic: boolean;
  savedMathTransform: boolean;
  split: SttBenchmarkSetSplit;
};

export type DatasetBuilderPlan = {
  sessionId: string;
  segmentId: string;
  /** Event-writing audioRef: the real audioRef, or NO_AUDIO_REF. */
  audioRef: string;
  /** audioRef to report back to the caller/UI: null when there is no real audio. */
  realAudioRef: string | null;
  literalTranscript: string;
  rawTranscript: string;
  notationTranscript: string;
  saveAcoustic: boolean;
  saveMathTransform: boolean;
  writeSyntheticSttResult: boolean;
};

function mintManualId(): { sessionId: string; segmentId: string } {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  // "lab_manual_" prefix keeps these entries visually distinguishable from
  // real DicTeX session ids wherever combined segment state is displayed.
  return { sessionId: `lab_manual_${stamp}`, segmentId: `entry_${suffix}` };
}

/**
 * Pure planning step: validates the request and decides which correction
 * layer(s) to write, without touching the filesystem. Kept separate from the
 * IPC handler in main/index.ts so the two-layer separability rule (acoustic
 * needs a raw transcript; math_transform needs the literal layer; an empty
 * layer is skipped, never blended) is reviewable in one small,
 * dependency-free function.
 */
export function planDatasetBuilderSave(request: DatasetBuilderSaveRequest): DatasetBuilderPlan {
  if (typeof request.literalTranscript !== "string") {
    throw new Error("Layer 1 (literal transcript) is required");
  }
  const literalTranscript = request.literalTranscript.trim();
  if (literalTranscript.length === 0) {
    throw new Error("Layer 1 (literal transcript) is required");
  }

  const rawTranscript = typeof request.rawTranscript === "string" ? request.rawTranscript.trim() : "";
  const notationTranscript = typeof request.notationTranscript === "string" ? request.notationTranscript.trim() : "";
  const saveAcoustic = rawTranscript.length > 0;
  const saveMathTransform = notationTranscript.length > 0;

  if (!saveAcoustic && !saveMathTransform) {
    throw new Error(
      "Nothing to save: provide a raw transcript (paste one or pick a segment) for the acoustic layer, or fill Layer 2 for the math-transform layer",
    );
  }

  let sessionId: string;
  let segmentId: string;
  let audioRef: string;
  let realAudioRef: string | null;

  if (request.source.mode === "segment") {
    if (
      typeof request.source.sessionId !== "string" ||
      request.source.sessionId.length === 0 ||
      typeof request.source.segmentId !== "string" ||
      request.source.segmentId.length === 0 ||
      typeof request.source.audioRef !== "string" ||
      request.source.audioRef.length === 0
    ) {
      throw new Error("Invalid picked segment");
    }
    sessionId = request.source.sessionId;
    segmentId = request.source.segmentId;
    audioRef = request.source.audioRef;
    realAudioRef = request.source.audioRef;
  } else {
    const minted = mintManualId();
    sessionId = minted.sessionId;
    segmentId = minted.segmentId;
    audioRef = NO_AUDIO_REF;
    realAudioRef = null;
  }

  return {
    sessionId,
    segmentId,
    audioRef,
    realAudioRef,
    literalTranscript,
    rawTranscript,
    notationTranscript,
    saveAcoustic,
    saveMathTransform,
    writeSyntheticSttResult: request.source.mode === "paste" && saveAcoustic,
  };
}
