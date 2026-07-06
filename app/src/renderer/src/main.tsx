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
  audioRef: string;
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
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number | null;
  correctedTranscript: string | null;
  correctionCreatedAt: string | null;
  correctionMethod: string | null;
  benchmarkSetSplit: SttBenchmarkSetSplit | null;
  benchmarkSetCreatedAt: string | null;
};

type SttBenchmarkSetSplit = "train_candidate_pool" | "validation" | "test_frozen";

type BenchmarkStage =
  | "stt"
  | "normalization"
  | "segment_classification"
  | "math_transform"
  | "correction_suggestion";

type BenchmarkCandidate = {
  stage: BenchmarkStage;
  provider: string;
  model: string;
  variant?: string;
};

type SttBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  candidate: BenchmarkCandidate;
  stage: BenchmarkStage;
  provider: string;
  model: string;
  variant: string | null;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  transcript: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
  score: SttBenchmarkScore | null;
};

type SttBenchmarkScore = {
  stage: "stt";
  metric: "cer";
  value: number;
  referenceTranscript: string;
  correctionCreatedAt: string | null;
};

type SttBenchmarkResponse = {
  source: AudioSegmentRecord;
  results: SttBenchmarkResult[];
};

type SttCorrectionRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  rawTranscript: string;
  correctedTranscript: string;
  correctionMethod?: "keyboard";
};

type SttCorrectionResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  correctionMethod: "keyboard";
};

type SttBenchmarkSetMembershipRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  split: SttBenchmarkSetSplit;
};

type SttBenchmarkSetMembershipResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  split: SttBenchmarkSetSplit;
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
  getSegmentAudio?: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  saveSttCorrection?: (correction: SttCorrectionRequest) => Promise<SttCorrectionResponse>;
  markSttBenchmarkSetMembership?: (
    membership: SttBenchmarkSetMembershipRequest,
  ) => Promise<SttBenchmarkSetMembershipResponse>;
  runLatestSttBenchmark?: () => Promise<SttBenchmarkResponse>;
  runSegmentSttBenchmark?: (audioSegment: AudioSegmentRecord) => Promise<SttBenchmarkResponse>;
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
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [sttConfig, setSttConfig] = useState<SttConfig | null>(null);
  const [lastPasteState, setLastPasteState] = useState<"none" | "pasted" | "clipboard-only">("none");
  const [lastResult, setLastResult] = useState<TranscriptionResult | null>(null);
  const [recentSegments, setRecentSegments] = useState<RecentSegment[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [loadingAudioSegmentKey, setLoadingAudioSegmentKey] = useState("");
  const [playingAudioSegmentKey, setPlayingAudioSegmentKey] = useState("");
  const [benchmarkSource, setBenchmarkSource] = useState<AudioSegmentRecord | null>(null);
  const [benchmarkResults, setBenchmarkResults] = useState<SttBenchmarkResult[]>([]);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkTargetKey, setBenchmarkTargetKey] = useState<string | null>(null);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [benchmarkSetTargetKey, setBenchmarkSetTargetKey] = useState<string | null>(null);
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
    setCorrectionNotice("");
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
      setCorrectionNotice("");
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

  async function copyHistoryTranscript(segment: RecentSegment, mode: "raw" | "corrected"): Promise<void> {
    const text = mode === "corrected" ? segment.correctedTranscript : segment.transcript;
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setNotice(`Copied ${mode} transcript for ${segment.sessionId} / ${segment.segmentId}`);
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

  async function saveSttCorrection(): Promise<void> {
    if (!lastResult) {
      setCorrectionNotice("No transcript segment to correct");
      return;
    }

    if (typeof window.dictex.saveSttCorrection !== "function") {
      setCorrectionNotice("Restart DicTeX to load the correction preload API");
      return;
    }

    setCorrectionNotice("");
    setIsSavingCorrection(true);

    try {
      const saved = await window.dictex.saveSttCorrection({
        sessionId: lastResult.sessionId,
        segmentId: lastResult.segmentId,
        audioRef: lastResult.audioRef,
        rawTranscript: lastResult.transcript,
        correctedTranscript: transcript,
        correctionMethod: "keyboard",
      });
      setCorrectionNotice(`Saved correction for ${saved.sessionId} / ${saved.segmentId}`);
      void loadRecentSegments();
    } catch (saveError) {
      setCorrectionNotice(saveError instanceof Error ? saveError.message : "Could not save correction");
    } finally {
      setIsSavingCorrection(false);
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
    setBenchmarkTargetKey("latest");

    try {
      const result = await window.dictex.runLatestSttBenchmark();
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
      setBenchmarkTargetKey(null);
    }
  }

  async function runSegmentSttBenchmark(segment: RecentSegment): Promise<void> {
    if (typeof window.dictex.runSegmentSttBenchmark !== "function") {
      setBenchmarkError("Restart DicTeX to load the selected segment benchmark API");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    setBenchmarkError("");
    setNotice("");
    setIsBenchmarking(true);
    setBenchmarkTargetKey(segmentKey);

    try {
      const result = await window.dictex.runSegmentSttBenchmark({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
      setBenchmarkTargetKey(null);
    }
  }

  async function markSttBenchmarkSetMembership(segment: RecentSegment, split: SttBenchmarkSetSplit): Promise<void> {
    if (typeof window.dictex.markSttBenchmarkSetMembership !== "function") {
      setHistoryError("Restart DicTeX to load the benchmark set preload API");
      return;
    }

    if (!segment.correctedTranscript) {
      setHistoryError("Correct the transcript before adding it to an STT benchmark set");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    setHistoryError("");
    setNotice("");
    setBenchmarkSetTargetKey(segmentKey);

    try {
      const marked = await window.dictex.markSttBenchmarkSetMembership({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
        split,
      });
      setNotice(`Marked ${marked.sessionId} / ${marked.segmentId} as ${formatBenchmarkSetSplit(marked.split)}`);
      void loadRecentSegments();
    } catch (markError) {
      setHistoryError(markError instanceof Error ? markError.message : "Could not mark benchmark set membership");
    } finally {
      setBenchmarkSetTargetKey(null);
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
                  <em className={segment.correctedTranscript ? "correction-state correction-state-done" : "correction-state"}>
                    {segment.correctedTranscript ? "corrected" : "raw"}
                  </em>
                </div>

                {segment.correctedTranscript ? (
                  <div className="history-transcripts">
                    <p className="history-transcript history-transcript-corrected">{segment.correctedTranscript}</p>
                    <p className="history-raw-transcript">Raw: {segment.transcript || "-"}</p>
                  </div>
                ) : (
                  <p className="history-transcript">{segment.transcript || "-"}</p>
                )}

                <div className="history-footer">
                  <div className="history-meta">
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds)}</span>
                    <span>{formatLatency(segment.transcriptionDurationMs)}</span>
                    {segment.correctionMethod && <span>{segment.correctionMethod}</span>}
                    {segment.benchmarkSetSplit && (
                      <span className="benchmark-set-state" title={segment.benchmarkSetCreatedAt ?? undefined}>
                        {formatBenchmarkSetSplit(segment.benchmarkSetSplit)}
                      </span>
                    )}
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
                      onClick={() => void playHistoryAudio(segment)}
                    >
                      {loadingAudioSegmentKey === getSegmentKey(segment)
                        ? "Loading"
                        : playingAudioSegmentKey === getSegmentKey(segment)
                          ? "Stop"
                          : "Play"}
                    </button>
                    <button className="secondary-button" disabled={!segment.transcript} onClick={() => void copyHistoryTranscript(segment, "raw")}>
                      Copy raw
                    </button>
                    {segment.correctedTranscript && (
                      <button className="secondary-button" onClick={() => void copyHistoryTranscript(segment, "corrected")}>
                        Copy corrected
                      </button>
                    )}
                    <select
                      aria-label={`STT benchmark set split for ${segment.sessionId} / ${segment.segmentId}`}
                      className="secondary-select"
                      disabled={
                        !segment.correctedTranscript ||
                        typeof window.dictex.markSttBenchmarkSetMembership !== "function" ||
                        benchmarkSetTargetKey === getSegmentKey(segment) ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      value={segment.benchmarkSetSplit ?? ""}
                      onChange={(event) => {
                        const split = event.currentTarget.value;
                        if (isSttBenchmarkSetSplit(split)) {
                          void markSttBenchmarkSetMembership(segment, split);
                        }
                      }}
                    >
                      <option value="">Set split</option>
                      <option value="train_candidate_pool">Train pool</option>
                      <option value="validation">Validation</option>
                      <option value="test_frozen">Test frozen</option>
                    </select>
                    <button
                      className="secondary-button"
                      disabled={
                        typeof window.dictex.runSegmentSttBenchmark !== "function" ||
                        isBenchmarking ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      onClick={() => void runSegmentSttBenchmark(segment)}
                    >
                      {benchmarkTargetKey === getSegmentKey(segment) ? "Running" : "Benchmark"}
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
              : benchmarkTargetKey === "latest"
                ? "Running"
                : "Benchmark latest"}
          </button>
        </div>

        {benchmarkError && <pre className="error">{benchmarkError}</pre>}

        {benchmarkResults.length > 0 && (
          <div className="benchmark-results">
            {benchmarkResults.map((result) => (
              <article className="benchmark-result" key={formatBenchmarkCandidateKey(result)}>
                <div className="benchmark-meta">
                  <strong title={formatBenchmarkCandidate(result)}>{formatBenchmarkCandidate(result)}</strong>
                  <span>{result.sttLanguage}</span>
                  <span>{formatAudioDuration(result.audioDurationSeconds)}</span>
                  <span>{result.transcriptionDurationMs} ms</span>
                  {result.score && <span title={`Reference: ${result.score.referenceTranscript}`}>{formatScore(result.score)}</span>}
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
          onChange={(event) => {
            setTranscript(event.target.value);
            setCorrectionNotice("");
          }}
          placeholder="Your transcript will appear here."
        />

        {error && <pre className="error">{error}</pre>}
        {notice && <p className="notice">{notice}</p>}
        {correctionNotice && <p className="notice">{correctionNotice}</p>}

        <div className="actions">
          <button className="secondary-button" disabled={!transcript} onClick={copyTranscript}>
            Copy
          </button>
          <button
            className="secondary-button"
            disabled={!lastResult || isSavingCorrection || status === "recording" || status === "transcribing"}
            onClick={() => void saveSttCorrection()}
          >
            {isSavingCorrection ? "Saving" : "Save correction"}
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

function formatBenchmarkCandidate(result: SttBenchmarkResult): string {
  return `${result.stage}:${result.provider}/${result.model}${result.variant ? ` (${result.variant})` : ""}`;
}

function formatBenchmarkCandidateKey(result: SttBenchmarkResult): string {
  return `${result.stage}/${result.provider}/${result.model}/${result.variant ?? ""}`;
}

function formatScore(score: SttBenchmarkScore): string {
  return `${score.metric.toUpperCase()} ${(score.value * 100).toFixed(1)}%`;
}

function formatBenchmarkSetSplit(split: SttBenchmarkSetSplit): string {
  if (split === "train_candidate_pool") {
    return "train pool";
  }

  if (split === "test_frozen") {
    return "test frozen";
  }

  return "validation";
}

function isSttBenchmarkSetSplit(value: string): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}

function getSegmentKey(segment: Pick<RecentSegment, "sessionId" | "segmentId">): string {
  return `${segment.sessionId}/${segment.segmentId}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
