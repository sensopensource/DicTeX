import { useEffect, useRef, useState } from "react";
import type { DictationTranscriptionOutcome, TranscriptionResult } from "../../../main/dictationFlow.js";
import type { HomeOverlayState } from "../../../main/overlayPresenter.js";
import type { DictexApi, HotkeyStatus, TranscriptionOptions } from "../api.js";

export type Status = "idle" | "recording" | "transcribing" | "done" | "error";

export type PasteState = "none" | "pasted" | "clipboard-only";

export type Dictation = {
  status: Status;
  transcript: string;
  error: string;
  hotkeyStatus: HotkeyStatus | null;
  lastResult: TranscriptionResult | null;
  lastPasteState: PasteState;
  recordingStartedAt: number | null;
  audioKept: boolean;
  diagnostics: { result: TranscriptionResult; paste: "pasted" | "clipboard-only" } | null;
  toggleDictation: (source: "manual" | "global_hotkey") => void;
  copyLastInserted: () => Promise<void>;
};

/**
 * How often the microphone level is published while recording (#166). Fast
 * enough to read as a live VU, slow enough that the HUD costs a handful of tiny
 * messages a second instead of one per frame.
 */
const LEVEL_PUBLISH_INTERVAL_MS = 80;

/**
 * Map an RMS amplitude onto the 0..1 the VU draws. A linear amplitude looks dead
 * — speech sits around 0.01..0.3 — so this uses the usual dBFS span: about -60
 * dB reads as silence, 0 dB as full scale.
 */
function toDisplayLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return 0;
  }

  const decibels = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (decibels + 60) / 60));
}

/**
 * Owns the whole recording -> transcription -> paste lifecycle: the record
 * button, the `Win+Alt+Space` toggle, the mic-level HUD feed, and the diagnostic
 * state a finished dictation leaves behind. `onTranscribed` lets the
 * composition root refresh the recent-segments history without this hook
 * knowing that panel exists.
 */
export function useDictation({
  api,
  onNotice,
  onTranscribed,
}: {
  api: DictexApi;
  onNotice: (message: string) => void;
  onTranscribed: () => void;
}): Dictation {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [lastPasteState, setLastPasteState] = useState<PasteState>("none");
  const [lastResult, setLastResult] = useState<TranscriptionResult | null>(null);
  // Diagnostics grid state, kept separate from `lastResult` so it persists across
  // the next recording instead of blanking out: the grid only ever grows or
  // updates, it never reflows back to empty once a dictation has filled it.
  const [diagnostics, setDiagnostics] = useState<{
    result: TranscriptionResult;
    paste: "pasted" | "clipboard-only";
  } | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [audioKept, setAudioKept] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const pendingTranscriptionOptionsRef = useRef<TranscriptionOptions>({ trigger: "manual" });
  // The HUD's view of Home, kept in a ref so the level can be published several
  // times a second without re-rendering Home for a window it does not draw.
  const overlayStateRef = useRef<HomeOverlayState>({
    status: "idle",
    pasteState: "none",
    recordingStartedAt: null,
    inputLevel: null,
    rawTranscript: "",
    insertedTranscript: "",
    normalizerEnabledForRun: null,
    normalizationApplied: false,
    audioKept: false,
    errorMessage: "",
  });
  const levelAudioContextRef = useRef<AudioContext | null>(null);
  const levelTimerRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /**
   * Publish the overlay states Home owns (#166). Fire-and-forget and fully
   * guarded: the HUD is never on dictation's critical path, so a missing preload
   * API or a failed send must be invisible to the person dictating.
   */
  function publishOverlay(patch: Partial<HomeOverlayState>): void {
    const next = { ...overlayStateRef.current, ...patch };
    overlayStateRef.current = next;

    try {
      api.publishOverlayState?.(next);
    } catch {
      // An overlay that cannot be told about a dictation simply misses it.
    }
  }

  // Home's own states reach the HUD from here; the level is published separately
  // by the meter below, which must not drive a re-render.
  useEffect(() => {
    publishOverlay({
      status,
      pasteState: lastPasteState,
      recordingStartedAt,
      rawTranscript: lastResult?.transcript ?? "",
      insertedTranscript: lastResult?.normalizedTranscript ?? "",
      normalizerEnabledForRun: lastResult?.normalizerEnabledForRun ?? null,
      normalizationApplied: lastResult?.normalizationApplied ?? false,
      audioKept,
      errorMessage: error,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lastPasteState, recordingStartedAt, lastResult, audioKept, error]);

  /**
   * Read the microphone level for the HUD's VU. A read-only tap on the stream the
   * recorder already has: the analyser is never connected to the destination, so
   * it neither routes the microphone to the speakers nor changes a single byte of
   * the recorded audio. Entirely optional — if the Web Audio graph cannot be
   * built, the HUD simply shows a chronometer with no VU and dictation is
   * unaffected.
   */
  function startInputLevelMonitor(stream: MediaStream): void {
    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      levelAudioContextRef.current = audioContext;

      const samples = new Float32Array(analyser.fftSize);
      levelTimerRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sumOfSquares = 0;
        for (const sample of samples) {
          sumOfSquares += sample * sample;
        }
        publishOverlay({ inputLevel: toDisplayLevel(Math.sqrt(sumOfSquares / samples.length)) });
      }, LEVEL_PUBLISH_INTERVAL_MS);
    } catch {
      // No VU; the rest of the HUD is unaffected.
    }
  }

  function stopInputLevelMonitor(): void {
    if (levelTimerRef.current) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = 0;
    }

    const audioContext = levelAudioContextRef.current;
    levelAudioContextRef.current = null;
    if (audioContext) {
      void audioContext.close().catch(() => {
        // Closing a context that already went away is not worth reporting.
      });
    }

    publishOverlay({ inputLevel: null });
  }

  useEffect(() => {
    const removeToggleListener = api.onDictationToggle(() => {
      toggleDictation("global_hotkey");
    });
    const removeHotkeyStatusListener = api.onHotkeyStatus(setHotkeyStatus);

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
      stopInputLevelMonitor();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording(): Promise<void> {
    if (isStartingRef.current || recorderRef.current?.state === "recording" || statusRef.current === "transcribing") {
      return;
    }

    isStartingRef.current = true;
    stopRequestedRef.current = false;
    pendingTranscriptionOptionsRef.current = { trigger: "manual" };
    setError("");
    onNotice("");
    setStatus("recording");
    setRecordingStartedAt(Date.now());
    setTranscript("");
    setLastPasteState("none");
    setLastResult(null);
    setAudioKept(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopInputLevelMonitor();
        stream.getTracks().forEach((track) => track.stop());
        void transcribeRecording(recorder.mimeType || "audio/webm");
      };

      recorder.start();
      startInputLevelMonitor(stream);

      if (stopRequestedRef.current) {
        stopRecording();
      }
    } catch (recordingError) {
      stopInputLevelMonitor();
      setRecordingStartedAt(null);
      setAudioKept(false);
      setStatus("error");
      setError(recordingError instanceof Error ? recordingError.message : "Microphone access failed");
    } finally {
      isStartingRef.current = false;
    }
  }

  function stopRecording(options: TranscriptionOptions = { trigger: "manual" }): void {
    pendingTranscriptionOptionsRef.current = options;

    if (recorderRef.current && recorderRef.current.state === "recording") {
      setStatus("transcribing");
      recorderRef.current.stop();
      return;
    }

    if (isStartingRef.current) {
      stopRequestedRef.current = true;
    }
  }

  // Single toggle shared by the record button and the Win+Alt+Space hotkey, so
  // the two can never desynchronise: both read the same status and drive the same
  // start/stop. The hotkey path keeps its auto-paste into the active app; the
  // button stays a plain manual dictation.
  function toggleDictation(source: "manual" | "global_hotkey"): void {
    if (statusRef.current === "recording") {
      stopRecording(
        source === "global_hotkey"
          ? { autoPaste: true, trigger: "global_hotkey" }
          : { trigger: "manual" },
      );
      return;
    }

    if (statusRef.current === "transcribing") {
      return;
    }

    void startRecording();
  }

  async function transcribeRecording(mimeType: string): Promise<void> {
    try {
      const audioBlob = new Blob(chunksRef.current, { type: mimeType });
      const audioBuffer = await audioBlob.arrayBuffer();
      const outcome: DictationTranscriptionOutcome = await api.transcribeAudio(
        new Uint8Array(audioBuffer),
        mimeType,
        pendingTranscriptionOptionsRef.current,
      );

      if (!outcome.ok) {
        setAudioKept(outcome.audioKept);
        setStatus("error");
        setError(outcome.error);
        return;
      }

      const { result } = outcome;

      setTranscript(result.transcript);
      setLastResult(result);
      setAudioKept(true);
      setDiagnostics({ result, paste: result.pastedToActiveApp ? "pasted" : "clipboard-only" });
      setLastPasteState(result.pastedToActiveApp ? "pasted" : "clipboard-only");
      // Surface normalizer diagnostics (e.g. a malformed dictionary) quietly,
      // without blocking the dictation.
      onNotice(result.normalizationDiagnostics.length > 0 ? `Normalizer: ${result.normalizationDiagnostics.join("; ")}` : "");
      setStatus("done");
      onTranscribed();
    } catch (transcriptionError) {
      // A Blob conversion or IPC transport failure carries no confirmation that
      // the main process persisted anything, so never promise that it did.
      setAudioKept(false);
      setStatus("error");
      setError(transcriptionError instanceof Error ? transcriptionError.message : "Transcription failed");
    }
  }

  async function copyLastInserted(): Promise<void> {
    const text = lastResult?.normalizedTranscript || transcript;
    if (text) {
      await navigator.clipboard.writeText(text);
      onNotice("Copied inserted transcript");
    }
  }

  return {
    status,
    transcript,
    error,
    hotkeyStatus,
    lastResult,
    lastPasteState,
    recordingStartedAt,
    audioKept,
    diagnostics,
    toggleDictation,
    copyLastInserted,
  };
}
