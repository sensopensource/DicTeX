import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

type TranscriptionResult = {
  transcript: string;
  copiedToClipboard: boolean;
  pastedToActiveApp: boolean;
  sessionId: string;
  segmentId: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
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

type AudioSegmentRecord = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
};

type RecentSegment = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  transcript: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number | null;
};

type SttBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  transcript: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
};

type SttBenchmarkResponse = {
  source: AudioSegmentRecord;
  results: SttBenchmarkResult[];
};

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  audioMimeType: string;
};

type DictationApi = {
  transcribeAudio: (
    audioBytes: Uint8Array,
    mimeType: string,
    options?: TranscriptionOptions,
  ) => Promise<TranscriptionResult>;
  onDictationToggle: (callback: () => void) => () => void;
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void;
  openDataFolder: () => Promise<boolean>;
  openEventsLog: () => Promise<boolean>;
  getSttConfig: () => Promise<SttConfig>;
  getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
  getSegmentAudio?: (audioRef: string) => Promise<AudioSegmentPlayback>;
  runLatestSttBenchmark?: () => Promise<SttBenchmarkResponse>;
};

declare global {
  interface Window {
    dictex: DictationApi;
  }
}

type Status = "idle" | "recording" | "transcribing" | "done" | "error";

function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [sttConfig, setSttConfig] = useState<SttConfig | null>(null);
  const [lastPasteState, setLastPasteState] = useState<"none" | "pasted" | "clipboard-only">("none");
  const [lastResult, setLastResult] = useState<TranscriptionResult | null>(null);
  const [recentSegments, setRecentSegments] = useState<RecentSegment[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadingAudioKey, setLoadingAudioKey] = useState<string | null>(null);
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null);
  const [audioError, setAudioError] = useState("");
  const [benchmarkSource, setBenchmarkSource] = useState<AudioSegmentRecord | null>(null);
  const [benchmarkResults, setBenchmarkResults] = useState<SttBenchmarkResult[]>([]);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const pendingTranscriptionOptionsRef = useRef<TranscriptionOptions>({ trigger: "manual" });
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const removeToggleListener = window.dictex.onDictationToggle(() => {
      if (statusRef.current === "recording") {
        stopRecording({ autoPaste: true, trigger: "global_hotkey" });
        return;
      }

      if (statusRef.current === "transcribing") {
        return;
      }

      void startRecording();
    });
    const removeHotkeyStatusListener = window.dictex.onHotkeyStatus(setHotkeyStatus);
    void window.dictex.getSttConfig().then(setSttConfig).catch(() => {
      setNotice("Could not read STT config");
    });
    void loadRecentSegments();

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
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
      setLastPasteState(result.pastedToActiveApp ? "pasted" : "clipboard-only");
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

  async function copyTranscript(): Promise<void> {
    if (transcript) {
      await navigator.clipboard.writeText(transcript);
    }
  }

  async function copyHistoryTranscript(segment: RecentSegment): Promise<void> {
    await navigator.clipboard.writeText(segment.transcript);
    setNotice(`Copied ${segment.sessionId} / ${segment.segmentId}`);
  }

  function stopAudioPlayback(): void {
    audioPlayerRef.current?.pause();
    audioPlayerRef.current = null;

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }

    setPlayingAudioKey(null);
    setLoadingAudioKey(null);
  }

  async function playHistoryAudio(segment: RecentSegment): Promise<void> {
    if (typeof window.dictex.getSegmentAudio !== "function") {
      setAudioError("Restart DicTeX to load the audio playback API");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    if (playingAudioKey === segmentKey) {
      stopAudioPlayback();
      return;
    }

    stopAudioPlayback();
    setAudioError("");
    setLoadingAudioKey(segmentKey);

    try {
      const audio = await window.dictex.getSegmentAudio(segment.audioRef);
      const audioBuffer = new ArrayBuffer(audio.audioBytes.byteLength);
      new Uint8Array(audioBuffer).set(audio.audioBytes);
      const blob = new Blob([audioBuffer], { type: audio.audioMimeType });
      const audioUrl = URL.createObjectURL(blob);
      const player = new Audio(audioUrl);

      audioObjectUrlRef.current = audioUrl;
      audioPlayerRef.current = player;

      player.onended = stopAudioPlayback;
      player.onerror = () => {
        setAudioError(`Could not play ${segment.sessionId} / ${segment.segmentId}`);
        stopAudioPlayback();
      };

      await player.play();
      setPlayingAudioKey(segmentKey);
    } catch (playError) {
      setAudioError(playError instanceof Error ? playError.message : "Could not play audio segment");
      stopAudioPlayback();
    } finally {
      setLoadingAudioKey(null);
    }
  }

  async function openDataFolder(): Promise<void> {
    try {
      const opened = await window.dictex.openDataFolder();
      setNotice(opened ? "Opened data folder" : "Could not open data folder");
    } catch (openError) {
      setNotice(openError instanceof Error ? openError.message : "Could not open data folder");
    }
  }

  async function openEventsLog(): Promise<void> {
    try {
      const opened = await window.dictex.openEventsLog();
      setNotice(opened ? "Opened events log" : "Could not open events log");
    } catch (openError) {
      setNotice(openError instanceof Error ? openError.message : "Could not open events log");
    }
  }

  async function runLatestSttBenchmark(): Promise<void> {
    if (typeof window.dictex.runLatestSttBenchmark !== "function") {
      setBenchmarkError("Restart DicTeX to load the benchmark preload API");
      return;
    }

    setBenchmarkError("");
    setNotice("");
    setIsBenchmarking(true);

    try {
      const result = await window.dictex.runLatestSttBenchmark();
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
    }
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

      <section className="panel controls-panel">
        <button
          className="record-button"
          disabled={status === "transcribing"}
          onMouseDown={startRecording}
          onMouseUp={() => stopRecording()}
          onMouseLeave={() => stopRecording()}
          onTouchStart={(event) => {
            event.preventDefault();
            void startRecording();
          }}
          onTouchEnd={(event) => {
            event.preventDefault();
            stopRecording();
          }}
        >
          {status === "recording" ? "Release to transcribe" : "Hold to dictate"}
        </button>

        <div className="shortcut-row">
          <span>Shortcut</span>
          <strong>Win+Alt+Space</strong>
          <span className={hotkeyStatus === null ? "signal-muted" : hotkeyStatus.registered ? "signal-good" : "signal-bad"}>
            {hotkeyStatus === null ? "checking" : hotkeyStatus.registered ? "registered" : "not registered"}
          </span>
        </div>
      </section>

      <section className="panel diagnostics-grid">
        <Metric label="Engine" value={lastResult?.sttEngine ?? sttConfig?.engine ?? "-"} />
        <Metric label="Model" value={lastResult?.sttModel ?? sttConfig?.model ?? "-"} />
        <Metric label="Language" value={lastResult?.sttLanguage ?? sttConfig?.language ?? "-"} />
        <Metric label="Latency" value={lastResult ? `${lastResult.transcriptionDurationMs} ms` : "-"} />
        <Metric label="Session" value={lastResult?.sessionId ?? "-"} />
        <Metric label="Segment" value={lastResult?.segmentId ?? "-"} />
        <Metric
          label="Audio"
          value={lastResult?.audioDurationSeconds !== null && lastResult?.audioDurationSeconds !== undefined ? `${lastResult.audioDurationSeconds.toFixed(2)} s` : "-"}
        />
        <Metric label="Output" value={lastPasteState === "pasted" ? "pasted" : lastPasteState === "clipboard-only" ? "clipboard" : "-"} />
      </section>

      <section className="panel history-panel" aria-busy={isLoadingHistory}>
        <div className="history-header">
          <div>
            <h2>Recent segments</h2>
            <p>{recentSegments.length > 0 ? `${recentSegments.length} local dictations` : "Local segment history"}</p>
          </div>
          <button
            className="secondary-button"
            disabled={isLoadingHistory || status === "recording" || status === "transcribing"}
            onClick={() => void loadRecentSegments()}
          >
            {isLoadingHistory ? "Loading" : "Refresh"}
          </button>
        </div>

        {historyError && <pre className="error">{historyError}</pre>}
        {audioError && <pre className="error">{audioError}</pre>}

        {recentSegments.length === 0 && !historyError ? (
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
                        loadingAudioKey === getSegmentKey(segment) ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      onClick={() => void playHistoryAudio(segment)}
                    >
                      {loadingAudioKey === getSegmentKey(segment)
                        ? "Loading"
                        : playingAudioKey === getSegmentKey(segment)
                          ? "Stop"
                          : "Play"}
                    </button>
                    <button className="secondary-button" disabled={!segment.transcript} onClick={() => void copyHistoryTranscript(segment)}>
                      Copy
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel benchmark-panel" aria-busy={isBenchmarking}>
        <div className="benchmark-header">
          <div>
            <h2>STT benchmark</h2>
            <p title={benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : undefined}>
              {benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : "Latest audio segment"}
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={
              typeof window.dictex.runLatestSttBenchmark !== "function" ||
              isBenchmarking ||
              status === "recording" ||
              status === "transcribing"
            }
            onClick={runLatestSttBenchmark}
          >
            {typeof window.dictex.runLatestSttBenchmark !== "function"
              ? "Restart app"
              : isBenchmarking
                ? "Running"
                : "Benchmark latest"}
          </button>
        </div>

        {benchmarkError && <pre className="error">{benchmarkError}</pre>}

        {benchmarkResults.length > 0 && (
          <div className="benchmark-results">
            {benchmarkResults.map((result) => (
              <article className="benchmark-result" key={result.sttModel}>
                <div className="benchmark-meta">
                  <strong>{result.sttModel}</strong>
                  <span>{result.sttLanguage}</span>
                  <span>{formatAudioDuration(result.audioDurationSeconds)}</span>
                  <span>{result.transcriptionDurationMs} ms</span>
                </div>
                <p>{result.transcript || "-"}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel transcript-panel">
        <label className="transcript-label" htmlFor="transcript">
          Last transcript
        </label>
        <textarea
          id="transcript"
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Your transcript will appear here."
        />

        {error && <pre className="error">{error}</pre>}
        {notice && <p className="notice">{notice}</p>}

        <div className="actions">
          <button className="secondary-button" disabled={!transcript} onClick={copyTranscript}>
            Copy
          </button>
          <button className="secondary-button" onClick={openDataFolder}>
            Open data folder
          </button>
          <button className="secondary-button" onClick={openEventsLog}>
            Open events log
          </button>
        </div>
      </section>
    </main>
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

function formatAudioDuration(durationSeconds: number | null): string {
  return durationSeconds === null ? "-" : `${durationSeconds.toFixed(2)} s`;
}

function formatLatency(durationMs: number | null): string {
  return durationMs === null ? "-" : `${durationMs} ms`;
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getSegmentKey(segment: Pick<RecentSegment, "sessionId" | "segmentId">): string {
  return `${segment.sessionId}/${segment.segmentId}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
