import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";

type Status = "idle" | "recording" | "transcribing" | "done" | "error";

type TranscriptionResult = {
  transcript: string;
  normalizedTranscript: string;
  normalizationApplied: boolean;
  normalizationDiagnostics: string[];
  copiedToClipboard: boolean;
  pastedToActiveApp: boolean;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
};

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

type HotkeyStatus = {
  accelerator: string;
  registered: boolean;
};

type SttConfig = {
  engine: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
};

type SttWorkerState = "starting" | "ready" | "busy" | "restarting" | "error" | "stopped";

type SttWorkerStatus = {
  state: SttWorkerState;
  workerGeneration: string | null;
  workerStartupMs: number | null;
  modelLoadMs: number | null;
  lastInferenceDurationMs: number | null;
};

type AudioSegmentRecord = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
};

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

type RecentSegment = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  transcript: string;
  normalizedTranscript: string | null;
  normalizationCreatedAt: string | null;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number | null;
};

type OpenLabResult = {
  ok: boolean;
  error?: string;
};

declare global {
  interface Window {
    dictex: {
      transcribeAudio: (
        audioBytes: Uint8Array,
        mimeType: string,
        options?: TranscriptionOptions,
      ) => Promise<TranscriptionResult>;
      onDictationToggle: (callback: () => void) => () => void;
      onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void;
      openDataFolder: () => Promise<boolean>;
      openEventsLog: () => Promise<boolean>;
      openDictionaryFile: () => Promise<boolean>;
      openRulesFile: () => Promise<boolean>;
      openLab: () => Promise<OpenLabResult>;
      getSttConfig: () => Promise<SttConfig>;
      getSttModels?: () => Promise<string[]>;
      getSttWorkerStatus?: () => Promise<SttWorkerStatus>;
      onSttWorkerStatus?: (callback: (status: SttWorkerStatus) => void) => () => void;
      setSttModel?: (model: string) => Promise<SttConfig>;
      getNormalizerEnabled?: () => Promise<boolean>;
      setNormalizerEnabled?: (enabled: boolean) => Promise<boolean>;
      getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
      getSegmentAudio?: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
    };
  }
}

function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [sttConfig, setSttConfig] = useState<SttConfig | null>(null);
  const [availableSttModels, setAvailableSttModels] = useState<string[]>([]);
  const [isSettingSttModel, setIsSettingSttModel] = useState(false);
  const [normalizerEnabled, setNormalizerEnabled] = useState<boolean | null>(null);
  const [sttWorkerStatus, setSttWorkerStatus] = useState<SttWorkerStatus | null>(null);
  const [isSettingNormalizer, setIsSettingNormalizer] = useState(false);
  const [lastPasteState, setLastPasteState] = useState<"none" | "pasted" | "clipboard-only">("none");
  const [lastResult, setLastResult] = useState<TranscriptionResult | null>(null);
  // Diagnostics grid state, kept separate from `lastResult` so it persists across
  // the next recording instead of blanking out: the grid only ever grows or
  // updates, it never reflows back to empty once a dictation has filled it.
  const [diagnostics, setDiagnostics] = useState<{
    result: TranscriptionResult;
    paste: "pasted" | "clipboard-only";
  } | null>(null);
  const [recentSegments, setRecentSegments] = useState<RecentSegment[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [loadingAudioSegmentKey, setLoadingAudioSegmentKey] = useState("");
  const [playingAudioSegmentKey, setPlayingAudioSegmentKey] = useState("");
  const [isOpeningLab, setIsOpeningLab] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const pendingTranscriptionOptionsRef = useRef<TranscriptionOptions>({ trigger: "manual" });
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef("");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const removeToggleListener = window.dictex.onDictationToggle(() => {
      toggleDictation("global_hotkey");
    });
    const removeHotkeyStatusListener = window.dictex.onHotkeyStatus(setHotkeyStatus);
    const removeSttWorkerStatusListener = window.dictex.onSttWorkerStatus?.(setSttWorkerStatus);
    void window.dictex.getSttConfig().then(setSttConfig).catch(() => {
      setNotice("Could not read STT config");
    });
    if (typeof window.dictex.getSttModels === "function") {
      void window.dictex.getSttModels().then(setAvailableSttModels).catch(() => {
        // Selector is optional; without the list the visible config line still shows the active model.
      });
    }
    if (typeof window.dictex.getNormalizerEnabled === "function") {
      void window.dictex
        .getNormalizerEnabled()
        .then(setNormalizerEnabled)
        .catch(() => setNotice("Could not read normalizer setting"));
    }
    if (typeof window.dictex.getSttWorkerStatus === "function") {
      void window.dictex.getSttWorkerStatus().then(setSttWorkerStatus).catch(() => {
        // The live notification still updates the status once the worker changes state.
      });
    }
    void loadRecentSegments();

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
      removeSttWorkerStatusListener?.();
      stopAudioPlayback();
    };
  }, []);

  async function startRecording(): Promise<void> {
    if (isStartingRef.current || recorderRef.current?.state === "recording" || statusRef.current === "transcribing") {
      return;
    }

    isStartingRef.current = true;
    stopRequestedRef.current = false;
    pendingTranscriptionOptionsRef.current = { trigger: "manual" };
    setError("");
    setNotice("");
    setStatus("recording");
    setTranscript("");
    setLastPasteState("none");
    setLastResult(null);

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
        stream.getTracks().forEach((track) => track.stop());
        void transcribeRecording(recorder.mimeType || "audio/webm");
      };

      recorder.start();

      if (stopRequestedRef.current) {
        stopRecording();
      }
    } catch (recordingError) {
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
      const result = await window.dictex.transcribeAudio(
        new Uint8Array(audioBuffer),
        mimeType,
        pendingTranscriptionOptionsRef.current,
      );

      setTranscript(result.transcript);
      setLastResult(result);
      setDiagnostics({ result, paste: result.pastedToActiveApp ? "pasted" : "clipboard-only" });
      setLastPasteState(result.pastedToActiveApp ? "pasted" : "clipboard-only");
      // Surface normalizer diagnostics (e.g. a malformed dictionary) quietly,
      // without blocking the dictation.
      setNotice(result.normalizationDiagnostics.length > 0 ? `Normalizer: ${result.normalizationDiagnostics.join("; ")}` : "");
      setStatus("done");
      void loadRecentSegments();
    } catch (transcriptionError) {
      setStatus("error");
      setError(transcriptionError instanceof Error ? transcriptionError.message : "Transcription failed");
    }
  }

  async function loadRecentSegments(): Promise<void> {
    if (typeof window.dictex.getRecentSegments !== "function") {
      setHistoryError("Restart DicTeX to load the history preload API");
      return;
    }

    setHistoryError("");
    setIsLoadingHistory(true);

    try {
      setRecentSegments(await window.dictex.getRecentSegments(20));
    } catch (historyLoadError) {
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Could not load recent segments");
    } finally {
      setIsLoadingHistory(false);
    }
  }

  async function copyLastInserted(): Promise<void> {
    const text = lastResult?.normalizedTranscript || transcript;
    if (text) {
      await navigator.clipboard.writeText(text);
      setNotice("Copied inserted transcript");
    }
  }

  async function copyHistoryTranscript(segment: RecentSegment, mode: "raw" | "inserted"): Promise<void> {
    const text =
      mode === "inserted"
        ? segment.normalizedTranscript && segment.normalizedTranscript.length > 0
          ? segment.normalizedTranscript
          : segment.transcript
        : segment.transcript;
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setNotice(`Copied ${mode === "inserted" ? "inserted" : "raw"} transcript for ${segment.sessionId} / ${segment.segmentId}`);
  }

  function stopAudioPlayback(): void {
    audioPlayerRef.current?.pause();
    audioPlayerRef.current = null;

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = "";
    }

    setPlayingAudioSegmentKey("");
    setLoadingAudioSegmentKey("");
  }

  async function playHistoryAudio(segment: RecentSegment): Promise<void> {
    if (typeof window.dictex.getSegmentAudio !== "function") {
      setAudioError("Restart DicTeX to load the audio playback API");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    if (playingAudioSegmentKey === segmentKey) {
      stopAudioPlayback();
      return;
    }

    stopAudioPlayback();
    setAudioError("");
    setLoadingAudioSegmentKey(segmentKey);

    try {
      const playback = await window.dictex.getSegmentAudio({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      const audioBytes = new Uint8Array(playback.audioBytes);
      const audioBuffer = audioBytes.buffer.slice(
        audioBytes.byteOffset,
        audioBytes.byteOffset + audioBytes.byteLength,
      ) as ArrayBuffer;
      const audioUrl = URL.createObjectURL(new Blob([audioBuffer], { type: playback.mimeType }));
      const player = new Audio(audioUrl);

      audioPlayerRef.current = player;
      audioObjectUrlRef.current = audioUrl;

      player.onended = stopAudioPlayback;
      player.onerror = () => {
        setAudioError(`Could not play ${segment.sessionId} / ${segment.segmentId}`);
        stopAudioPlayback();
      };

      await player.play();
      setPlayingAudioSegmentKey(segmentKey);
    } catch (playError) {
      setAudioError(playError instanceof Error ? playError.message : "Could not play audio segment");
      stopAudioPlayback();
    } finally {
      setLoadingAudioSegmentKey("");
    }
  }

  async function changeSttModel(model: string): Promise<void> {
    if (typeof window.dictex.setSttModel !== "function") {
      setNotice("Restart DicTeX to load the STT model settings API");
      return;
    }

    setIsSettingSttModel(true);
    setNotice("");
    try {
      const nextConfig = await window.dictex.setSttModel(model);
      setSttConfig(nextConfig);
      setNotice(`STT model set to ${nextConfig.model} (applies to next dictation)`);
    } catch (modelError) {
      setNotice(modelError instanceof Error ? modelError.message : "Could not change STT model");
    } finally {
      setIsSettingSttModel(false);
    }
  }

  async function changeNormalizerEnabled(enabled: boolean): Promise<void> {
    if (typeof window.dictex.setNormalizerEnabled !== "function") {
      setNotice("Restart DicTeX to load the normalizer settings API");
      return;
    }

    setIsSettingNormalizer(true);
    setNotice("");
    try {
      const nextEnabled = await window.dictex.setNormalizerEnabled(enabled);
      setNormalizerEnabled(nextEnabled);
      setNotice(
        nextEnabled
          ? "Normalizer enabled (math rules and command words apply to the next dictation)"
          : "Normalizer disabled (raw STT and literal command words apply to the next dictation)",
      );
    } catch (normalizerError) {
      setNotice(normalizerError instanceof Error ? normalizerError.message : "Could not change normalizer setting");
    } finally {
      setIsSettingNormalizer(false);
    }
  }

  async function openLab(): Promise<void> {
    if (typeof window.dictex.openLab !== "function") {
      setNotice("Restart DicTeX to load the Open Lab API");
      return;
    }

    setIsOpeningLab(true);
    setNotice("");
    try {
      const result = await window.dictex.openLab();
      if (result.ok) {
        setNotice("Opening DicTeX Lab…");
      } else {
        setNotice(result.error ?? "Could not open DicTeX Lab");
      }
    } catch (labError) {
      setNotice(labError instanceof Error ? labError.message : "Could not open DicTeX Lab");
    } finally {
      setIsOpeningLab(false);
    }
  }

  async function openDataFolder(): Promise<void> {
    await window.dictex.openDataFolder();
  }

  async function openEventsLog(): Promise<void> {
    await window.dictex.openEventsLog();
  }

  async function openDictionaryFile(): Promise<void> {
    await window.dictex.openDictionaryFile();
  }

  async function openRulesFile(): Promise<void> {
    await window.dictex.openRulesFile();
  }

  // Idle Home hides empty diagnostics: each metric appears only once a dictation
  // has given it a value (never seeded from config, never a "-" placeholder). The
  // grid grows from the first dictation and then only updates in place.
  const metrics: { label: string; value: string }[] = [];
  if (diagnostics) {
    const { result, paste } = diagnostics;
    metrics.push({ label: "Engine", value: result.sttEngine });
    metrics.push({ label: "Model", value: result.sttModel });
    metrics.push({ label: "Language", value: result.sttLanguage });
    metrics.push({ label: "Latency", value: `${result.transcriptionDurationMs} ms` });
    metrics.push({ label: "Session", value: result.sessionId });
    metrics.push({ label: "Segment", value: result.segmentId });
    if (result.audioDurationSeconds !== null) {
      metrics.push({ label: "Audio", value: `${result.audioDurationSeconds.toFixed(2)} s` });
    }
    metrics.push({ label: "Output", value: paste === "pasted" ? "pasted" : "clipboard" });
  }

  const statusLabel =
    status === "done" && lastPasteState === "pasted"
      ? "pasted"
      : status === "done" && lastPasteState === "clipboard-only"
        ? "copied"
        : status;

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Local dictation</h1>
        </div>
        <div className={`status-pill status-${statusLabel}`}>{statusLabel}</div>
      </header>

      <section className="panel nav-panel">
        <button className="nav-button" disabled={isOpeningLab} onClick={() => void openLab()}>
          {isOpeningLab ? "Opening Lab…" : "Open Lab"}
        </button>
      </section>

      <section className="panel controls-panel">
        <button
          className="record-button"
          disabled={status === "transcribing"}
          onClick={() => toggleDictation("manual")}
        >
          {status === "recording" ? "Arrêter" : "Démarrer"}
        </button>

        <div className="shortcut-row">
          <span>Shortcut</span>
          <strong>Win+Alt+Space</strong>
          <span className={hotkeyStatus === null ? "signal-muted" : hotkeyStatus.registered ? "signal-good" : "signal-bad"}>
            {hotkeyStatus === null ? "checking" : hotkeyStatus.registered ? "registered" : "not registered"}
          </span>
        </div>

        <div className="shortcut-row">
          <span>STT model</span>
          <select
            aria-label="Active STT model"
            className="secondary-select"
            disabled={
              typeof window.dictex.setSttModel !== "function" ||
              isSettingSttModel ||
              isSettingNormalizer ||
              status === "recording" ||
              status === "transcribing"
            }
            value={sttConfig?.model ?? ""}
            onChange={(event) => void changeSttModel(event.currentTarget.value)}
          >
            {sttConfig?.model && !availableSttModels.includes(sttConfig.model) && (
              <option value={sttConfig.model}>{sttConfig.model}</option>
            )}
            {availableSttModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <span className="signal-muted">{isSettingSttModel ? "saving" : "next dictation"}</span>
        </div>

        <div className="shortcut-row">
          <span>Normalizer</span>
          <label className="normalizer-switch">
            <input
              aria-label="Enable normalizer"
              type="checkbox"
              checked={normalizerEnabled ?? true}
              disabled={
                normalizerEnabled === null ||
                typeof window.dictex.setNormalizerEnabled !== "function" ||
                isSettingNormalizer ||
                isSettingSttModel ||
                status === "recording" ||
                status === "transcribing"
              }
              onChange={(event) => void changeNormalizerEnabled(event.currentTarget.checked)}
            />
            <span className="normalizer-switch-track" aria-hidden="true">
              <span className="normalizer-switch-thumb" />
            </span>
            <strong>{normalizerEnabled === null ? "…" : normalizerEnabled ? "On" : "Off"}</strong>
          </label>
          <span className="signal-muted normalizer-hint">
            {isSettingNormalizer
              ? "saving"
              : normalizerEnabled === null
                ? "loading"
                : normalizerEnabled
                  ? "math + commands"
                  : "raw STT; commands stay literal"}
          </span>
        </div>

        <div className="shortcut-row">
          <span>STT engine</span>
          <strong>{formatSttWorkerState(sttWorkerStatus?.state)}</strong>
          <span className={sttWorkerStatus?.state === "error" ? "signal-bad" : "signal-muted"}>
            {sttWorkerStatus?.workerGeneration ?? "starting"}
          </span>
        </div>

        {sttWorkerStatus?.workerStartupMs !== null && sttWorkerStatus?.workerStartupMs !== undefined && (
          <div className="shortcut-row">
            <span>Preparation</span>
            <strong>{formatLatency(sttWorkerStatus.workerStartupMs)}</strong>
            <span className="signal-muted">model load {formatLatency(sttWorkerStatus.modelLoadMs)}</span>
          </div>
        )}

        {sttWorkerStatus?.lastInferenceDurationMs !== null && sttWorkerStatus?.lastInferenceDurationMs !== undefined && (
          <div className="shortcut-row">
            <span>Warm inference</span>
            <strong>{formatLatency(sttWorkerStatus.lastInferenceDurationMs)}</strong>
            <span className="signal-muted">worker request</span>
          </div>
        )}
      </section>

      {metrics.length > 0 && (
        <section className="panel diagnostics-grid">
          {metrics.map((metric) => (
            <Metric key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </section>
      )}

      <HistoryPanel
        recentSegments={recentSegments}
        historyError={historyError}
        isLoadingHistory={isLoadingHistory}
        loadRecentSegments={() => void loadRecentSegments()}
        audioError={audioError}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        playHistoryAudio={(segment) => void playHistoryAudio(segment)}
        copyHistoryTranscript={(segment, mode) => void copyHistoryTranscript(segment, mode)}
        status={status}
      />

      <section className="panel last-transcript-panel">
        <div className="panel-header">
          <div>
            <h2>Last transcript</h2>
            <p>Raw STT output. Inserted text may differ after normalization.</p>
          </div>
          <button className="secondary-button" disabled={!transcript && !lastResult?.normalizedTranscript} onClick={() => void copyLastInserted()}>
            Copy
          </button>
        </div>
        {lastResult?.normalizedTranscript && lastResult.normalizedTranscript !== lastResult.transcript && (
          <p className="history-normalized-transcript" title="Text inserted after normalization">
            Inserted: {lastResult.normalizedTranscript}
          </p>
        )}
        <pre className="transcript">{transcript || "Waiting for dictation…"}</pre>
      </section>

      <section className="panel footer-panel">
        <button className="secondary-button" onClick={() => void openDataFolder()}>
          Open data folder
        </button>
        <button className="secondary-button" onClick={() => void openEventsLog()}>
          Open events log
        </button>
        <button className="secondary-button" onClick={() => void openDictionaryFile()}>
          Open dictionary
        </button>
        <button className="secondary-button" onClick={() => void openRulesFile()}>
          Open rule overlay
        </button>
      </section>

      {notice && <pre className="notice">{notice}</pre>}
      {error && <pre className="error">{error}</pre>}
    </main>
  );
}

type HistoryPanelProps = {
  recentSegments: RecentSegment[];
  historyError: string;
  isLoadingHistory: boolean;
  loadRecentSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playHistoryAudio: (segment: RecentSegment) => void;
  copyHistoryTranscript: (segment: RecentSegment, mode: "raw" | "inserted") => void;
  status: Status;
};

function HistoryPanel({
  recentSegments,
  historyError,
  isLoadingHistory,
  loadRecentSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playHistoryAudio,
  copyHistoryTranscript,
  status,
}: HistoryPanelProps): React.ReactElement {
  const [historyExpanded, setHistoryExpanded] = useState(false);

  return (
    <section className="panel history-panel" aria-busy={isLoadingHistory}>
      <div className="panel-header">
        <button
          className="history-toggle"
          aria-expanded={historyExpanded}
          onClick={() => setHistoryExpanded((expanded) => !expanded)}
        >
          <span className={`history-chevron ${historyExpanded ? "history-chevron-open" : ""}`} aria-hidden="true">
            ▸
          </span>
          <div>
            <h2>Recent segments</h2>
            <p>{recentSegments.length > 0 ? `${recentSegments.length} local dictations` : "Local segment history"}</p>
          </div>
        </button>
        <button
          className="secondary-button"
          disabled={isLoadingHistory || status === "recording" || status === "transcribing"}
          onClick={() => loadRecentSegments()}
        >
          {isLoadingHistory ? "Loading" : "Refresh"}
        </button>
      </div>

      {historyError && <pre className="error">{historyError}</pre>}
      {audioError && <pre className="error">{audioError}</pre>}

      {historyExpanded &&
        (recentSegments.length === 0 && !historyError ? (
          <p className="empty-state">No stored dictation segments found.</p>
        ) : (
          <div className="history-list">
            {recentSegments.map((segment) => (
              <article className="history-item" key={getSegmentKey(segment)}>
                <div className="history-heading">
                  <span title={segment.createdAt ?? undefined}>{formatTimestamp(segment.createdAt)}</span>
                  <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
                    {segment.sessionId} / {segment.segmentId}
                  </strong>
                </div>

                <p className="history-transcript">{segment.transcript || "-"}</p>

                {segment.normalizedTranscript !== null && segment.normalizedTranscript !== segment.transcript && (
                  <p className="history-normalized-transcript" title="Text inserted after normalization">
                    Inserted: {segment.normalizedTranscript || "-"}
                  </p>
                )}

                <div className="history-footer">
                  <div className="history-meta">
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds)}</span>
                    <span>{formatLatency(segment.transcriptionDurationMs)}</span>
                  </div>
                  <div className="history-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        !segment.audioRef ||
                        loadingAudioSegmentKey === getSegmentKey(segment) ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      onClick={() => playHistoryAudio(segment)}
                    >
                      {loadingAudioSegmentKey === getSegmentKey(segment)
                        ? "Loading"
                        : playingAudioSegmentKey === getSegmentKey(segment)
                          ? "Stop"
                          : "Play"}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!segment.transcript && !segment.normalizedTranscript}
                      onClick={() => copyHistoryTranscript(segment, "inserted")}
                    >
                      Copy
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!segment.transcript}
                      onClick={() => copyHistoryTranscript(segment, "raw")}
                    >
                      Copy raw
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ))}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function getSegmentKey(segment: Pick<RecentSegment, "sessionId" | "segmentId">): string {
  return `${segment.sessionId}::${segment.segmentId}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatAudioDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "-";
  }

  return `${seconds.toFixed(2)} s`;
}

function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "-";
  }

  return `${Math.round(ms)} ms`;
}

function formatSttWorkerState(state: SttWorkerState | undefined): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "busy":
      return "Busy";
    case "restarting":
      return "Restarting";
    case "error":
      return "Error";
    case "starting":
    case "stopped":
    default:
      return "Preparing";
  }
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
