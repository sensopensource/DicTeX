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
  correctedTranscript: string | null;
  correctionCreatedAt: string | null;
  correctionMethod: string | null;
};

type BenchmarkCandidate = {
  stage: "stt";
  provider: string;
  model: string;
  variant?: string;
};

type SttBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  candidate: BenchmarkCandidate;
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

type SttCorrectionTarget = {
  sessionId: string;
  segmentId: string;
  audioRef?: string;
  rawTranscript: string;
};

type SttCorrectionRequest = SttCorrectionTarget & {
  correctedTranscript: string;
  correctionMethod?: "keyboard";
};

type SttCorrectionResult = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
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
  runLatestSttBenchmark?: () => Promise<SttBenchmarkResponse>;
  runSttBenchmarkForSegment?: (source: AudioSegmentRecord) => Promise<SttBenchmarkResponse>;
  getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
  writeClipboardText?: (text: string) => Promise<boolean>;
  saveSttCorrection?: (correction: SttCorrectionRequest) => Promise<SttCorrectionResult>;
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
  const [benchmarkSource, setBenchmarkSource] = useState<AudioSegmentRecord | null>(null);
  const [benchmarkResults, setBenchmarkResults] = useState<SttBenchmarkResult[]>([]);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [recentSegments, setRecentSegments] = useState<RecentSegment[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [benchmarkingSegmentKey, setBenchmarkingSegmentKey] = useState("");
  const [correctionTarget, setCorrectionTarget] = useState<SttCorrectionTarget | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [correctionError, setCorrectionError] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const pendingTranscriptionOptionsRef = useRef<TranscriptionOptions>({ trigger: "manual" });

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
    setCorrectionTarget(null);
    setCorrectionDraft("");
    setCorrectionError("");
    setCorrectionNotice("");

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
      setCorrectionTarget({
        sessionId: result.sessionId,
        segmentId: result.segmentId,
        rawTranscript: result.transcript,
      });
      setCorrectionDraft(result.transcript);
      setLastPasteState(result.pastedToActiveApp ? "pasted" : "clipboard-only");
      setStatus("done");
      void loadRecentSegments();
    } catch (transcriptionError) {
      setStatus("error");
      setError(transcriptionError instanceof Error ? transcriptionError.message : "Transcription failed");
    }
  }

  async function copyTranscript(): Promise<void> {
    if (transcript) {
      await writeClipboardText(transcript);
    }
  }

  async function writeClipboardText(text: string): Promise<void> {
    if (typeof window.dictex.writeClipboardText === "function") {
      await window.dictex.writeClipboardText(text);
      return;
    }

    await navigator.clipboard.writeText(text);
  }

  async function copyHistoryTranscript(segment: RecentSegment): Promise<void> {
    await writeClipboardText(segment.transcript);
    setNotice(`Copied raw ${segment.segmentId}`);
  }

  async function copyCorrectedHistoryTranscript(segment: RecentSegment): Promise<void> {
    if (!segment.correctedTranscript) {
      return;
    }

    await writeClipboardText(segment.correctedTranscript);
    setNotice(`Copied corrected ${segment.segmentId}`);
  }

  function selectCorrectionTarget(segment: RecentSegment): void {
    setCorrectionTarget({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      rawTranscript: segment.transcript,
    });
    setCorrectionDraft(segment.transcript);
    setCorrectionError("");
    setCorrectionNotice("");
    setNotice(`Correction target ${segment.segmentId}`);
  }

  async function saveSttCorrection(): Promise<void> {
    if (!correctionTarget) {
      return;
    }

    if (typeof window.dictex.saveSttCorrection !== "function") {
      setCorrectionError("Restart DicTeX to load the correction preload API");
      return;
    }

    setCorrectionError("");
    setCorrectionNotice("");
    setIsSavingCorrection(true);

    try {
      const result = await window.dictex.saveSttCorrection({
        ...correctionTarget,
        correctedTranscript: correctionDraft,
        correctionMethod: "keyboard",
      });
      setCorrectionNotice(`Saved correction for ${result.segmentId}`);
      void loadRecentSegments();
    } catch (saveError) {
      setCorrectionError(saveError instanceof Error ? saveError.message : "Could not save correction");
    } finally {
      setIsSavingCorrection(false);
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
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Could not load history");
    } finally {
      setIsLoadingHistory(false);
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
      void loadRecentSegments();
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
    }
  }

  async function runSegmentSttBenchmark(segment: RecentSegment): Promise<void> {
    if (typeof window.dictex.runSttBenchmarkForSegment !== "function") {
      setBenchmarkError("Restart DicTeX to load the selected segment benchmark API");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    setBenchmarkError("");
    setNotice("");
    setBenchmarkingSegmentKey(segmentKey);
    setIsBenchmarking(true);

    try {
      const result = await window.dictex.runSttBenchmarkForSegment({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
      void loadRecentSegments();
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setBenchmarkingSegmentKey("");
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
              <article className="benchmark-result" key={`${result.candidate.stage}:${result.candidate.provider}:${result.candidate.model}:${result.candidate.variant ?? ""}`}>
                <div className="benchmark-meta">
                  <strong title={formatBenchmarkCandidate(result.candidate)}>{result.candidate.model}</strong>
                  <span>{result.candidate.provider}</span>
                  <span>{result.candidate.stage}</span>
                  <span>{result.candidate.variant ?? result.sttLanguage}</span>
                  <span>{formatAudioDuration(result.audioDurationSeconds)}</span>
                  <span>{result.transcriptionDurationMs} ms</span>
                </div>
                <p>{result.transcript || "-"}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel history-panel" aria-busy={isLoadingHistory}>
        <div className="history-header">
          <div>
            <h2>Recent segments</h2>
            <p>{recentSegments.length > 0 ? `${recentSegments.length} local dictations` : "No local dictations yet"}</p>
          </div>
          <button className="secondary-button" disabled={isLoadingHistory} onClick={() => void loadRecentSegments()}>
            {isLoadingHistory ? "Loading" : "Refresh"}
          </button>
        </div>

        {historyError && <pre className="error">{historyError}</pre>}

        {recentSegments.length > 0 && (
          <div className="history-list">
            {recentSegments.map((segment) => {
              const segmentKey = getSegmentKey(segment);
              return (
                <article className="history-item" key={segmentKey}>
                  <div className="history-meta">
                    <strong title={segment.createdAt ?? undefined}>{formatTimestamp(segment.createdAt)}</strong>
                    <span title={segment.sessionId}>{segment.sessionId}</span>
                    <span>{segment.segmentId}</span>
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds)}</span>
                    <span>{segment.transcriptionDurationMs === null ? "-" : `${segment.transcriptionDurationMs} ms`}</span>
                    <span className={segment.correctedTranscript ? "signal-good" : "signal-muted"}>
                      {segment.correctedTranscript ? "corrected" : "raw"}
                    </span>
                  </div>
                  {segment.correctedTranscript ? (
                    <div className="history-transcripts">
                      <p>
                        <span>Raw</span>
                        {segment.transcript || "-"}
                      </p>
                      <p>
                        <span>Corrected</span>
                        {segment.correctedTranscript}
                      </p>
                    </div>
                  ) : (
                    <p>{segment.transcript || "-"}</p>
                  )}
                  <div className="history-actions">
                    <button className="secondary-button" disabled={!segment.transcript} onClick={() => void copyHistoryTranscript(segment)}>
                      Copy raw
                    </button>
                    {segment.correctedTranscript && (
                      <button className="secondary-button" onClick={() => void copyCorrectedHistoryTranscript(segment)}>
                        Copy corrected
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      disabled={
                        typeof window.dictex.runSttBenchmarkForSegment !== "function" ||
                        isBenchmarking ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      onClick={() => void runSegmentSttBenchmark(segment)}
                    >
                      {benchmarkingSegmentKey === segmentKey ? "Running" : "Benchmark"}
                    </button>
                    <button className="secondary-button" disabled={!segment.transcript} onClick={() => selectCorrectionTarget(segment)}>
                      Correct
                    </button>
                  </div>
                </article>
              );
            })}
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

        {correctionTarget && (
          <div className="correction-box">
            <div className="correction-header">
              <div>
                <h2>STT correction</h2>
                <p title={`${correctionTarget.sessionId} / ${correctionTarget.segmentId}`}>
                  {correctionTarget.sessionId} / {correctionTarget.segmentId}
                </p>
              </div>
              <button
                className="secondary-button"
                disabled={isSavingCorrection || correctionDraft.length === 0}
                onClick={() => void saveSttCorrection()}
              >
                {isSavingCorrection ? "Saving" : "Save correction"}
              </button>
            </div>
            <textarea
              aria-label="Corrected transcript"
              value={correctionDraft}
              onChange={(event) => setCorrectionDraft(event.target.value)}
            />
            {correctionError && <pre className="error">{correctionError}</pre>}
            {correctionNotice && <p className="notice">{correctionNotice}</p>}
          </div>
        )}

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

function getSegmentKey(segment: { sessionId: string; segmentId: string }): string {
  return `${segment.sessionId}:${segment.segmentId}`;
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBenchmarkCandidate(candidate: BenchmarkCandidate): string {
  return `${candidate.stage} / ${candidate.provider} / ${candidate.model}${candidate.variant ? ` / ${candidate.variant}` : ""}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
