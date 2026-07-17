/**
 * The floating HUD overlay's derived view (#166).
 *
 * The overlay is a READ-ONLY surface. Every input below keeps the owner it
 * already had: the dictation `status` and the paste outcome belong to Home (it
 * drives the recorder and receives the transcription result), the worker state
 * and the normalizer setting belong to the main process. This module is only the
 * projection from those existing states onto what the HUD draws — it introduces
 * no state of its own, so the overlay can never disagree with Home about what
 * DicTeX is currently doing.
 *
 * It is deliberately pure and Electron-free: the phase machine and the preview
 * cap are the parts worth testing, and they must be exercisable without opening
 * a window. The overlay is never on dictation's critical path, so a mistake here
 * can change what is *shown*, never what is transcribed, inserted or stored.
 */

/** Home's dictation status. Mirrors the renderer's own `Status` union. */
export type DictationStatus = "idle" | "recording" | "transcribing" | "done" | "error";

/** The STT worker lifecycle, as already published by `SttWorkerManager`. */
export type WorkerLifecycleState = "starting" | "ready" | "busy" | "restarting" | "error" | "stopped";

/** The paste outcome of the last dictation, as already tracked by Home. */
export type PasteState = "none" | "pasted" | "clipboard-only";

/** Every existing state the HUD reflects, merged from its two owners. */
export type OverlayInput = {
  status: DictationStatus;
  /** Null until the first worker status notification arrives. */
  workerState: WorkerLifecycleState | null;
  /** Null until the persisted setting has been read. */
  normalizerEnabled: boolean | null;
  pasteState: PasteState;
  /** Epoch ms when the current recording started; null when not recording. */
  recordingStartedAt: number | null;
  /** Microphone level, 0..1. Null when unavailable (the VU tap is optional). */
  inputLevel: number | null;
  /** Raw STT output of the last dictation. */
  rawTranscript: string;
  /** Text actually inserted (normalized when the normalizer ran, raw otherwise). */
  insertedTranscript: string;
  /** Policy and result facts frozen with the completed dictation. They belong
   * to the result, not to the setting for the next run. */
  normalizerEnabledForRun: boolean | null;
  normalizationApplied: boolean;
  /** True only after the audio file and `audio_segment` were both persisted. */
  audioKept: boolean;
  /** Home's last error message, if any. */
  errorMessage: string;
};

/**
 * A capped preview. `summary` is the honest degradation for a long dictation:
 * rather than showing a sliver of the text and implying it is the result, the
 * HUD states how much was inserted and leaves reading to the notebook.
 */
export type OverlayPreview =
  | { kind: "empty" }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "summary"; characters: number };

export type OverlayView =
  | { phase: "ready" }
  | { phase: "warming" }
  | { phase: "recording"; startedAt: number; level: number }
  | { phase: "transcribing" }
  | {
      phase: "inserted";
      raw: OverlayPreview;
      normalized: OverlayPreview;
      /** True only when the normalizer ran AND changed the text, i.e. when a raw
       * vs normalized toggle would actually show two different things. */
      hasNormalized: boolean;
      normalizerEnabled: boolean | null;
      paste: "pasted" | "clipboard-only";
    }
  | { phase: "error"; message: string; audioKept: boolean };

/**
 * Hard cap on a preview, roughly two lines at the HUD's width. The overlay is a
 * glance surface, not a reader: the notebook holds the text.
 */
export const PREVIEW_CHAR_CAP = 120;

/**
 * Past this length, cutting at the cap would hide the overwhelming majority of
 * the dictation, so the preview stops pretending and degrades to a count.
 */
export const PREVIEW_SUMMARY_CAP = 360;

/** How long the "inserted" card stays up before the HUD collapses to its pill. */
export const INSERTED_VISIBLE_MS = 6000;

/** Never cut mid-token when a word boundary sits reasonably close to the cap. */
const MIN_BOUNDARY_RATIO = 0.6;

function countCharacters(text: string): number {
  // Code points, not UTF-16 units: a count shown to a human should not report 2
  // for one character.
  return [...text].length;
}

/**
 * Collapse every whitespace run — including the real newlines a "retour à la
 * ligne" command produces — into single spaces. This makes the character cap
 * mean what it says (~2 lines); without it a short but newline-heavy result
 * would still blow the HUD's height budget. Preview-only: the inserted text and
 * everything stored on disk keep their exact bytes.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateAtBoundary(text: string, cap: number): string {
  const hardCut = text.slice(0, cap);
  const lastSpace = hardCut.lastIndexOf(" ");
  // A single long token (a LaTeX blob with no spaces) has no usable boundary, so
  // cut it flat rather than collapsing the preview to almost nothing.
  return lastSpace >= Math.floor(cap * MIN_BOUNDARY_RATIO) ? hardCut.slice(0, lastSpace) : hardCut;
}

/**
 * Build the capped preview of one transcript variant. The summary's count
 * describes the text as it was actually inserted, not the collapsed preview
 * string, so "N characters inserted" stays true to what reached the notebook.
 */
export function buildPreview(text: string): OverlayPreview {
  const collapsed = collapseWhitespace(text);

  if (collapsed.length === 0) {
    return { kind: "empty" };
  }

  if (collapsed.length > PREVIEW_SUMMARY_CAP) {
    return { kind: "summary", characters: countCharacters(text) };
  }

  if (collapsed.length > PREVIEW_CHAR_CAP) {
    return { kind: "text", text: `${truncateAtBoundary(collapsed, PREVIEW_CHAR_CAP)}…`, truncated: true };
  }

  return { kind: "text", text: collapsed, truncated: false };
}

function clampLevel(level: number | null): number {
  if (level === null || !Number.isFinite(level)) {
    return 0;
  }
  return Math.min(1, Math.max(0, level));
}

/**
 * The resting phase, shared by a true idle and by a dismissed "inserted" card.
 * The worker mapping mirrors Home's own `formatSttWorkerState`: anything that is
 * not yet usable reads as preparation rather than inventing a fourth label.
 */
function deriveRestingPhase(workerState: WorkerLifecycleState | null): OverlayView {
  switch (workerState) {
    case "ready":
    case "busy":
      return { phase: "ready" };
    case "error":
      // The engine cannot transcribe; no audio is at stake at rest, so this is
      // not the "audio kept" reassurance a failed dictation gets.
      return { phase: "error", message: "STT engine unavailable", audioKept: false };
    case "starting":
    case "restarting":
    case "stopped":
    case null:
    default:
      return { phase: "warming" };
  }
}

export type DeriveOverlayOptions = {
  /** True once the "inserted" card has had its time on screen. Home's status
   * stays "done" until the next dictation, so without this the card would never
   * leave; the timer itself is the HUD's own presentation concern. */
  insertedDismissed: boolean;
};

export function deriveOverlayView(input: OverlayInput, options: DeriveOverlayOptions): OverlayView {
  switch (input.status) {
    case "recording":
      return {
        phase: "recording",
        // A timestamp, not a tick: the HUD runs the chronometer locally instead
        // of the main process pushing one message per frame.
        startedAt: input.recordingStartedAt ?? 0,
        level: clampLevel(input.inputLevel),
      };

    case "transcribing":
      return { phase: "transcribing" };

    case "error":
      return {
        phase: "error",
        message: input.errorMessage || "Dictation failed",
        // A microphone or persistence failure has no audio guarantee. The
        // reassurance appears only after the main process confirmed both writes.
        audioKept: input.audioKept,
      };

    case "done": {
      if (options.insertedDismissed) {
        return deriveRestingPhase(input.workerState);
      }

      return {
        phase: "inserted",
        raw: buildPreview(input.rawTranscript),
        normalized: buildPreview(input.insertedTranscript),
        // With the normalizer Off the inserted text is byte-identical to the raw
        // STT, and a pipeline that ran without changing anything is equally
        // identical: in both cases a toggle would show the same text twice.
        hasNormalized: input.normalizationApplied && input.insertedTranscript !== input.rawTranscript,
        normalizerEnabled: input.normalizerEnabledForRun,
        paste: input.pasteState === "pasted" ? "pasted" : "clipboard-only",
      };
    }

    case "idle":
    default:
      return deriveRestingPhase(input.workerState);
  }
}
