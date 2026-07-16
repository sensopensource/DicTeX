import { useEffect, useRef, useState } from "react";
import type { ReconstructedSegment, SttBenchmarkSetSplit } from "@dictex/shared";
import { formatBenchmarkSetSplit, formatDatasetCorrectionKind, getSegmentKey } from "@dictex/shared/formatting";
import type { LabApi } from "../api.js";
import type { DatasetBuilderSource } from "../../../main/datasetBuilder.js";

/** How long Layer 1 must settle before the pipeline is asked for a Layer 2 prefill. */
export const LAYER2_PREFILL_DEBOUNCE_MS = 350;

export type DatasetBuilderMode = "paste" | "segment";

export type DatasetBuilder = {
  builderMode: DatasetBuilderMode;
  setBuilderMode: (mode: DatasetBuilderMode) => void;
  builderSegmentKey: string;
  setBuilderSegmentKey: (key: string) => void;
  builderRawTranscript: string;
  setBuilderRawTranscript: (raw: string) => void;
  builderLiteral: string;
  setBuilderLiteral: (literal: string) => void;
  builderNotation: string;
  setBuilderNotation: (notation: string) => void;
  builderSplit: SttBenchmarkSetSplit;
  setBuilderSplit: (split: SttBenchmarkSetSplit) => void;

  builderNotationPrefill: string;
  isPrefillingLayer2: boolean;
  builderPrefillError: string;

  isSavingBuilderEntry: boolean;
  builderNotice: string;
  builderError: string;
  saveDatasetBuilderEntry: () => Promise<void>;
};

/**
 * The Lab's manual, no-microphone dataset entry (issue #78): a pasted
 * transcription or a picked DicTeX segment, qualified through Layer 1 (literal)
 * and Layer 2 (notation).
 *
 * @param segments the corpus a "segment" source picks from — the same list the
 *   Corpus view shows, so a saved entry carries a real identity and audio ref.
 * @param onSaved runs after a successful save so the corpus re-reads what the
 *   append produced.
 */
export function useDatasetBuilder({
  api,
  segments,
  onSaved,
}: {
  api: LabApi;
  segments: ReconstructedSegment[];
  onSaved: () => void;
}): DatasetBuilder {
  const [builderMode, setBuilderMode] = useState<DatasetBuilderMode>("paste");
  const [builderSegmentKey, setBuilderSegmentKey] = useState("");
  const [builderRawTranscript, setBuilderRawTranscript] = useState("");
  const [builderLiteral, setBuilderLiteral] = useState("");
  const [builderNotation, setBuilderNotation] = useState("");
  const [builderSplit, setBuilderSplit] = useState<SttBenchmarkSetSplit>("train_candidate_pool");
  const [isSavingBuilderEntry, setIsSavingBuilderEntry] = useState(false);
  const [builderNotice, setBuilderNotice] = useState("");
  const [builderError, setBuilderError] = useState("");

  // Layer 2 prefill from the pipeline (issue #101): fires whenever Layer 1
  // has content, so picking a segment or typing Layer 1 shows the
  // dictionary+regex output (command words spelled out) as a starting point.
  // `lastPrefillRef` tracks the most recent prefill so a fresh one only
  // overwrites Layer 2 when the field still holds an EARLIER auto-prefill (or
  // is empty) — never when the human has typed something else into it. The
  // prefill is always a starting point; what gets saved is whatever is left
  // in the field.
  const [builderNotationPrefill, setBuilderNotationPrefill] = useState("");
  const [isPrefillingLayer2, setIsPrefillingLayer2] = useState(false);
  const [builderPrefillError, setBuilderPrefillError] = useState("");
  const lastPrefillRef = useRef("");

  // Layer 2 prefill (#101): debounced so it fires once Layer 1 settles rather
  // than on every keystroke. Reads the SOURCE folder's dictionary/rules
  // through the main process (the renderer cannot touch node:fs); the result
  // has already been through the full pipeline and back through
  // restoreCommandWords in the main process, so it is guaranteed sentinel-
  // and newline-free by construction before it ever reaches this hook.
  useEffect(() => {
    const trimmed = builderLiteral.trim();
    if (trimmed.length === 0) {
      lastPrefillRef.current = "";
      setBuilderNotationPrefill("");
      setBuilderPrefillError("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setIsPrefillingLayer2(true);
      void api
        .prefillDatasetBuilderLayer2(trimmed)
        .then((prefill) => {
          if (cancelled) {
            return;
          }
          const previousPrefill = lastPrefillRef.current;
          lastPrefillRef.current = prefill;
          setBuilderNotationPrefill(prefill);
          setBuilderPrefillError("");
          // Only overwrite Layer 2 if it is still empty or still holds the
          // PREVIOUS auto-prefill untouched; a human edit is never clobbered.
          setBuilderNotation((current) => (current.length === 0 || current === previousPrefill ? prefill : current));
        })
        .catch((prefillError) => {
          if (cancelled) {
            return;
          }
          setBuilderPrefillError(
            prefillError instanceof Error ? prefillError.message : "Could not prefill Layer 2 from the pipeline",
          );
        })
        .finally(() => {
          if (!cancelled) {
            setIsPrefillingLayer2(false);
          }
        });
    }, LAYER2_PREFILL_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [builderLiteral, api]);

  async function saveDatasetBuilderEntry(): Promise<void> {
    setBuilderError("");
    setBuilderNotice("");

    const literal = builderLiteral.trim();
    if (literal.length === 0) {
      setBuilderError("Layer 1 (literal transcript) is required");
      return;
    }

    let source: DatasetBuilderSource;
    let rawTranscript: string;

    if (builderMode === "segment") {
      const segment = segments.find((candidate) => getSegmentKey(candidate) === builderSegmentKey);
      if (!segment) {
        setBuilderError("Pick a DicTeX segment first");
        return;
      }
      source = { mode: "segment", sessionId: segment.sessionId, segmentId: segment.segmentId, audioRef: segment.audioRef };
      rawTranscript = segment.transcript;
    } else {
      source = { mode: "paste" };
      rawTranscript = builderRawTranscript.trim();
    }

    const notation = builderNotation.trim();
    // Mirror planDatasetBuilderSave's own "nothing to save" rule exactly (see
    // apps/lab/src/main/datasetBuilder.ts): a "paste" source has no audio and
    // can NEVER save an acoustic pair, no matter how much raw text it has —
    // only Layer 2 (math_transform) can save it. Checking this here (with the
    // same wording the main process would throw) surfaces the real rule
    // before a round trip, instead of a generic message that could imply a
    // pasted raw transcript alone is enough.
    const willSaveAcoustic = rawTranscript.length > 0 && builderMode === "segment";
    const willSaveMathTransform = notation.length > 0;
    if (!willSaveAcoustic && !willSaveMathTransform) {
      setBuilderError(
        builderMode === "segment"
          ? "Nothing to save: the picked segment has no raw transcript for the acoustic layer, and Layer 2 (notation) is empty."
          : "Nothing to save: a pasted (no-audio) entry needs Layer 2 (notation) to build a math_transform pair. Pick a recorded segment if you want an acoustic (audio -> literal) pair.",
      );
      return;
    }

    setIsSavingBuilderEntry(true);
    try {
      const response = await api.saveDatasetBuilderEntry({
        source,
        rawTranscript,
        literalTranscript: literal,
        notationTranscript: notation,
        split: builderSplit,
      });
      const savedLayers = [
        response.savedAcoustic ? formatDatasetCorrectionKind("acoustic") : null,
        response.savedMathTransform ? formatDatasetCorrectionKind("math_transform") : null,
      ].filter((layer): layer is string => layer !== null);
      setBuilderNotice(
        `Saved ${savedLayers.join(" + ")} -> ${formatBenchmarkSetSplit(response.split)} (${response.sessionId} / ${response.segmentId})`,
      );
      setBuilderNotation("");
      lastPrefillRef.current = "";
      setBuilderNotationPrefill("");
      setBuilderPrefillError("");
      if (builderMode === "paste") {
        setBuilderRawTranscript("");
        setBuilderLiteral("");
      }
      onSaved();
    } catch (saveError) {
      setBuilderError(saveError instanceof Error ? saveError.message : "Could not save dataset entry");
    } finally {
      setIsSavingBuilderEntry(false);
    }
  }

  return {
    builderMode,
    setBuilderMode,
    builderSegmentKey,
    setBuilderSegmentKey,
    builderRawTranscript,
    setBuilderRawTranscript,
    builderLiteral,
    setBuilderLiteral,
    builderNotation,
    setBuilderNotation,
    builderSplit,
    setBuilderSplit,

    builderNotationPrefill,
    isPrefillingLayer2,
    builderPrefillError,

    isSavingBuilderEntry,
    builderNotice,
    builderError,
    saveDatasetBuilderEntry,
  };
}
