import {
  deriveOverlayView,
  INSERTED_VISIBLE_MS,
  type DictationStatus,
  type OverlayInput,
  type OverlayView,
  type PasteState,
  type WorkerLifecycleState,
} from "./overlayState.js";

/**
 * Merges the HUD's two state owners and drives what the overlay window shows.
 *
 * Home owns the dictation status, the paste outcome and the transcripts (it runs
 * the recorder and receives the result); the main process owns the worker state
 * and the normalizer setting. Neither is copied into a new source of truth: this
 * presenter holds the latest value each owner published and re-derives the view.
 *
 * It also owns the one thing that is genuinely the overlay's own concern — how
 * long the "inserted" card stays up. Home's status stays `done` until the next
 * dictation, so without a dismissal the card would never leave; the ticket asks
 * it to fade after the paste. Timers are injected so that schedule is testable
 * without waiting six seconds.
 *
 * Everything here is off dictation's critical path: it reacts to states that
 * have already happened and can only change what the HUD draws.
 */

export type HomeOverlayState = {
  status: DictationStatus;
  pasteState: PasteState;
  recordingStartedAt: number | null;
  inputLevel: number | null;
  rawTranscript: string;
  insertedTranscript: string;
  normalizerEnabledForRun: boolean | null;
  normalizationApplied: boolean;
  audioKept: boolean;
  errorMessage: string;
};

const DICTATION_STATUSES: readonly DictationStatus[] = ["idle", "recording", "transcribing", "done", "error"];
const PASTE_STATES: readonly PasteState[] = ["none", "pasted", "clipboard-only"];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

/**
 * Validate a state published over IPC before it reaches the view derivation.
 *
 * Home is our own code, but it is still a separate process on the other side of
 * a bridge: a malformed or stale payload must degrade to "ignored", never throw
 * inside the main process, where it could take dictation down with it. Returns
 * null when the payload cannot be trusted at all.
 */
export function sanitizeHomeOverlayState(value: unknown): HomeOverlayState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  if (!DICTATION_STATUSES.includes(status as DictationStatus)) {
    return null;
  }

  const pasteState = candidate.pasteState;
  return {
    status: status as DictationStatus,
    pasteState: PASTE_STATES.includes(pasteState as PasteState) ? (pasteState as PasteState) : "none",
    recordingStartedAt: asFiniteNumber(candidate.recordingStartedAt),
    inputLevel: asFiniteNumber(candidate.inputLevel),
    rawTranscript: asString(candidate.rawTranscript),
    insertedTranscript: asString(candidate.insertedTranscript),
    normalizerEnabledForRun:
      typeof candidate.normalizerEnabledForRun === "boolean" ? candidate.normalizerEnabledForRun : null,
    normalizationApplied: asBoolean(candidate.normalizationApplied),
    audioKept: asBoolean(candidate.audioKept),
    errorMessage: asString(candidate.errorMessage),
  };
}

export type TimerHandle = unknown;

export type OverlayPresenterDeps = {
  /** Publish a view to the overlay window. Called only when the view changes. */
  emit: (view: OverlayView) => void;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
};

const initialInput: OverlayInput = {
  status: "idle",
  workerState: null,
  normalizerEnabled: null,
  pasteState: "none",
  recordingStartedAt: null,
  inputLevel: null,
  rawTranscript: "",
  insertedTranscript: "",
  normalizerEnabledForRun: null,
  normalizationApplied: false,
  audioKept: false,
  errorMessage: "",
};

export class OverlayPresenter {
  private input: OverlayInput = { ...initialInput };
  private insertedDismissed = false;
  private dismissTimer: TimerHandle | null = null;
  private lastEmitted: string | null = null;

  constructor(private readonly deps: OverlayPresenterDeps) {}

  /** Apply the slice of state Home owns. */
  updateFromHome(state: HomeOverlayState): void {
    const previousStatus = this.input.status;
    this.input = { ...this.input, ...state };

    if (state.status !== previousStatus) {
      this.onStatusChanged(state.status);
    }

    this.publish();
  }

  /** Apply the worker lifecycle the main process already tracks. */
  setWorkerState(workerState: WorkerLifecycleState): void {
    this.input = { ...this.input, workerState };
    this.publish();
  }

  /** Apply the persisted normalizer setting the main process already holds. */
  setNormalizerEnabled(normalizerEnabled: boolean): void {
    this.input = { ...this.input, normalizerEnabled };
    this.publish();
  }

  /** The current view, for a window that has just finished loading. */
  getView(): OverlayView {
    return deriveOverlayView(this.input, { insertedDismissed: this.insertedDismissed });
  }

  /** Re-send the current view unconditionally (a fresh window has no history). */
  resend(): void {
    const view = this.getView();
    this.lastEmitted = JSON.stringify(view);
    this.deps.emit(view);
  }

  dispose(): void {
    this.cancelDismiss();
  }

  private onStatusChanged(status: DictationStatus): void {
    this.cancelDismiss();
    // Any new activity re-opens the card: leaving `done` must not carry the
    // previous dictation's dismissal into the next one.
    this.insertedDismissed = false;

    if (status === "done") {
      this.dismissTimer = this.deps.setTimer(() => {
        this.dismissTimer = null;
        this.insertedDismissed = true;
        this.publish();
      }, INSERTED_VISIBLE_MS);
    }
  }

  private cancelDismiss(): void {
    if (this.dismissTimer !== null) {
      this.deps.clearTimer(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private publish(): void {
    const view = this.getView();
    // A recording publishes a level several times a second; most of those carry
    // an unchanged view (the level is rounded for the VU). Comparing keeps the
    // IPC quiet instead of redrawing the HUD on every sample.
    const serialized = JSON.stringify(view);
    if (serialized === this.lastEmitted) {
      return;
    }

    this.lastEmitted = serialized;
    this.deps.emit(view);
  }
}
