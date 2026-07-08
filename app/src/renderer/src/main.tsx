import React, { useEffect, useMemo, useRef, useState } from "react";
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
  correctionKind: CorrectionKind | null;
  benchmarkSetSplit: SttBenchmarkSetSplit | null;
  benchmarkSetCreatedAt: string | null;
};

type SttBenchmarkSetSplit = "train_candidate_pool" | "validation" | "test_frozen";

type CorrectionKind = "acoustic" | "math_transform" | "normalization" | "rephrasing";

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
  correctionKind: CorrectionKind;
  correctionMethod?: "keyboard";
};

type SttCorrectionResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  correctionKind: CorrectionKind;
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

type SttBenchmarkSetSegmentOutcome = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  status: "done" | "failed";
  error: string | null;
  results: SttBenchmarkResult[];
};

type SttBenchmarkSetRunResponse = {
  split: SttBenchmarkSetSplit;
  total: number;
  done: number;
  failed: number;
  outcomes: SttBenchmarkSetSegmentOutcome[];
};

type SttBenchmarkSetProgress = {
  split: SttBenchmarkSetSplit;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  current: { sessionId: string; segmentId: string } | null;
  lastOutcome: {
    sessionId: string;
    segmentId: string;
    status: "done" | "failed";
    error: string | null;
    resultCount: number;
  } | null;
};

type SttErrorCategory =
  | "empty_output"
  | "high_cer"
  | "symbol_mismatch"
  | "keyword_mismatch"
  | "latency_outlier";

type SttErrorExample = {
  sessionId: string;
  segmentId: string;
  category: SttErrorCategory;
  detail: string;
  transcript: string;
  referenceTranscript: string | null;
  cer: number | null;
  transcriptionDurationMs: number;
};

type CandidateErrorAnalysis = {
  candidateKey: string;
  candidateLabel: string;
  scoredResultCount: number;
  categoryCounts: Record<SttErrorCategory, number>;
  examples: SttErrorExample[];
};

type HistoryCorrectionTarget = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  rawTranscript: string;
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
  getSttBenchmarkModels?: () => Promise<string[]>;
  getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
  getSegmentAudio?: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  saveSttCorrection?: (correction: SttCorrectionRequest) => Promise<SttCorrectionResponse>;
  markSttBenchmarkSetMembership?: (
    membership: SttBenchmarkSetMembershipRequest,
  ) => Promise<SttBenchmarkSetMembershipResponse>;
  runLatestSttBenchmark?: () => Promise<SttBenchmarkResponse>;
  runSegmentSttBenchmark?: (audioSegment: AudioSegmentRecord) => Promise<SttBenchmarkResponse>;
  runSetSttBenchmark?: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkSetRunResponse>;
  onBatchBenchmarkProgress?: (callback: (progress: SttBenchmarkSetProgress) => void) => () => void;
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
  const [benchmarkModels, setBenchmarkModels] = useState<string[]>([]);
  const [benchmarkTargetKey, setBenchmarkTargetKey] = useState<string | null>(null);
  const [batchSplit, setBatchSplit] = useState<SttBenchmarkSetSplit>("test_frozen");
  const [batchProgress, setBatchProgress] = useState<SttBenchmarkSetProgress | null>(null);
  const [batchOutcomes, setBatchOutcomes] = useState<SttBenchmarkSetSegmentOutcome[]>([]);
  const [batchError, setBatchError] = useState("");
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionKind, setCorrectionKind] = useState<CorrectionKind | "">("");
  const [benchmarkSetTargetKey, setBenchmarkSetTargetKey] = useState<string | null>(null);
  const [historyCorrectionTarget, setHistoryCorrectionTarget] = useState<HistoryCorrectionTarget | null>(null);
  const [historyCorrectionDraft, setHistoryCorrectionDraft] = useState("");
  const [historyCorrectionKind, setHistoryCorrectionKind] = useState<CorrectionKind | "">("");
  const errorAnalysis = useMemo(() => analyzeBatchErrors(batchOutcomes), [batchOutcomes]);
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
    const removeBatchProgressListener =
      typeof window.dictex.onBatchBenchmarkProgress === "function"
        ? window.dictex.onBatchBenchmarkProgress(setBatchProgress)
        : undefined;
    void window.dictex.getSttConfig().then(setSttConfig).catch(() => {
      setNotice("Could not read STT config");
    });
    if (typeof window.dictex.getSttBenchmarkModels === "function") {
      void window.dictex.getSttBenchmarkModels().then(setBenchmarkModels).catch(() => {
        // Silently fail if benchmark models cannot be fetched; default UI behavior is fine
      });
    }
    void loadRecentSegments();

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
      removeBatchProgressListener?.();
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
    setCorrectionKind("");
    setHistoryCorrectionTarget(null);
    setHistoryCorrectionDraft("");
    setHistoryCorrectionKind("");

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

    if (correctionKind === "") {
      setCorrectionNotice("Choose a correction kind before saving");
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
        correctionKind,
        correctionMethod: "keyboard",
      });
      setCorrectionNotice(`Saved ${formatCorrectionKind(saved.correctionKind)} correction for ${saved.sessionId} / ${saved.segmentId}`);
      void loadRecentSegments();
    } catch (saveError) {
      setCorrectionNotice(saveError instanceof Error ? saveError.message : "Could not save correction");
    } finally {
      setIsSavingCorrection(false);
    }
  }

  function startHistoryCorrection(segment: RecentSegment): void {
    setHistoryCorrectionTarget({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      rawTranscript: segment.transcript,
    });
    setHistoryCorrectionDraft(segment.correctedTranscript ?? segment.transcript);
    setHistoryCorrectionKind("");
    setCorrectionNotice("");
    setNotice(`Correction target ${segment.sessionId} / ${segment.segmentId}`);
  }

  async function saveHistoryCorrection(): Promise<void> {
    if (!historyCorrectionTarget) {
      return;
    }

    if (typeof window.dictex.saveSttCorrection !== "function") {
      setCorrectionNotice("Restart DicTeX to load the correction preload API");
      return;
    }

    if (historyCorrectionKind === "") {
      setCorrectionNotice("Choose a correction kind before saving");
      return;
    }

    setCorrectionNotice("");
    setIsSavingCorrection(true);

    try {
      const saved = await window.dictex.saveSttCorrection({
        sessionId: historyCorrectionTarget.sessionId,
        segmentId: historyCorrectionTarget.segmentId,
        audioRef: historyCorrectionTarget.audioRef,
        rawTranscript: historyCorrectionTarget.rawTranscript,
        correctedTranscript: historyCorrectionDraft,
        correctionKind: historyCorrectionKind,
        correctionMethod: "keyboard",
      });
      setCorrectionNotice(`Saved ${formatCorrectionKind(saved.correctionKind)} correction for ${saved.sessionId} / ${saved.segmentId}`);
      setHistoryCorrectionTarget(null);
      setHistoryCorrectionDraft("");
      setHistoryCorrectionKind("");
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

  async function runSetSttBenchmark(): Promise<void> {
    if (typeof window.dictex.runSetSttBenchmark !== "function") {
      setBatchError("Restart DicTeX to load the benchmark set preload API");
      return;
    }

    setBatchError("");
    setNotice("");
    setBatchOutcomes([]);
    setBatchProgress(null);
    setIsRunningBatch(true);

    try {
      const response = await window.dictex.runSetSttBenchmark(batchSplit);
      setBatchOutcomes(response.outcomes);
      setNotice(
        `Benchmarked ${formatBenchmarkSetSplit(response.split)}: ${response.done} done, ${response.failed} failed of ${response.total}`,
      );
    } catch (runError) {
      setBatchError(runError instanceof Error ? runError.message : "Benchmark set run failed");
    } finally {
      setIsRunningBatch(false);
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
                    {segment.correctionKind && (
                      <span className="correction-kind-state" title={`Correction kind: ${formatCorrectionKind(segment.correctionKind)}`}>
                        {formatCorrectionKind(segment.correctionKind)}
                      </span>
                    )}
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
                      disabled={isSavingCorrection || status === "recording" || status === "transcribing"}
                      onClick={() => startHistoryCorrection(segment)}
                    >
                      Correct
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        typeof window.dictex.runSegmentSttBenchmark !== "function" ||
                        isBenchmarking ||
                        isRunningBatch ||
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

      {historyCorrectionTarget && (
        <section className="panel correction-panel">
          <div className="correction-header">
            <div>
              <h2>STT correction</h2>
              <p title={`${historyCorrectionTarget.sessionId} / ${historyCorrectionTarget.segmentId}`}>
                {historyCorrectionTarget.sessionId} / {historyCorrectionTarget.segmentId}
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={isSavingCorrection}
              onClick={() => {
                setHistoryCorrectionTarget(null);
                setHistoryCorrectionDraft("");
                setHistoryCorrectionKind("");
              }}
            >
              Cancel
            </button>
          </div>

          <p className="correction-raw">Raw: {historyCorrectionTarget.rawTranscript || "-"}</p>
          <textarea
            value={historyCorrectionDraft}
            onChange={(event) => {
              setHistoryCorrectionDraft(event.target.value);
              setCorrectionNotice("");
            }}
            aria-label="Corrected transcript"
          />
          <div className="actions">
            <CorrectionKindSelect
              ariaLabel={`Correction kind for ${historyCorrectionTarget.sessionId} / ${historyCorrectionTarget.segmentId}`}
              value={historyCorrectionKind}
              disabled={isSavingCorrection}
              onChange={(kind) => {
                setHistoryCorrectionKind(kind);
                setCorrectionNotice("");
              }}
            />
            <button
              className="secondary-button"
              disabled={isSavingCorrection || historyCorrectionDraft.length === 0 || historyCorrectionKind === ""}
              onClick={() => void saveHistoryCorrection()}
            >
              {isSavingCorrection ? "Saving" : "Save correction"}
            </button>
          </div>
        </section>
      )}

      <section className="panel benchmark-panel" aria-busy={isBenchmarking}>
        <div className="benchmark-header">
          <div>
            <h2>STT benchmark</h2>
            <p title={benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : undefined}>
              {benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : "Latest audio segment"}
            </p>
            {benchmarkModels.length > 0 && (
              <p className="benchmark-models">Models: {benchmarkModels.join(", ")}</p>
            )}
          </div>
          <button
            className="secondary-button"
            disabled={
              typeof window.dictex.runLatestSttBenchmark !== "function" ||
              isBenchmarking ||
              isRunningBatch ||
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

      <section className="panel benchmark-panel" aria-busy={isRunningBatch}>
        <div className="benchmark-header">
          <div>
            <h2>Benchmark set</h2>
            <p>Run STT candidates over every corrected {formatBenchmarkSetSplit(batchSplit)} segment</p>
          </div>
          <div className="batch-controls">
            <select
              aria-label="STT benchmark set split to run"
              className="secondary-select"
              disabled={isRunningBatch || isBenchmarking || status === "recording" || status === "transcribing"}
              value={batchSplit}
              onChange={(event) => {
                const split = event.currentTarget.value;
                if (isSttBenchmarkSetSplit(split)) {
                  setBatchSplit(split);
                }
              }}
            >
              <option value="test_frozen">Test frozen</option>
              <option value="validation">Validation</option>
            </select>
            <button
              className="secondary-button"
              disabled={
                typeof window.dictex.runSetSttBenchmark !== "function" ||
                isRunningBatch ||
                isBenchmarking ||
                status === "recording" ||
                status === "transcribing"
              }
              onClick={() => void runSetSttBenchmark()}
            >
              {typeof window.dictex.runSetSttBenchmark !== "function"
                ? "Restart app"
                : isRunningBatch
                  ? "Running"
                  : "Run set benchmark"}
            </button>
          </div>
        </div>

        {batchError && <pre className="error">{batchError}</pre>}

        {batchProgress && (
          <div className="batch-progress">
            <div className="batch-progress-counts">
              <span className="batch-count">Total {batchProgress.total}</span>
              <span className="batch-count">Queued {batchProgress.queued}</span>
              <span className="batch-count">Running {batchProgress.running}</span>
              <span className="batch-count batch-count-done">Done {batchProgress.done}</span>
              <span className="batch-count batch-count-failed">Failed {batchProgress.failed}</span>
            </div>
            {batchProgress.current && (
              <p className="batch-current" title={`${batchProgress.current.sessionId} / ${batchProgress.current.segmentId}`}>
                Running {batchProgress.current.sessionId} / {batchProgress.current.segmentId}
              </p>
            )}
            {batchProgress.lastOutcome && (
              <p className={batchProgress.lastOutcome.status === "failed" ? "batch-last batch-last-failed" : "batch-last"}>
                {batchProgress.lastOutcome.status === "failed"
                  ? `Failed ${batchProgress.lastOutcome.sessionId} / ${batchProgress.lastOutcome.segmentId}: ${batchProgress.lastOutcome.error ?? "error"}`
                  : `Done ${batchProgress.lastOutcome.sessionId} / ${batchProgress.lastOutcome.segmentId} (${batchProgress.lastOutcome.resultCount} candidates)`}
              </p>
            )}
          </div>
        )}

        {batchProgress && batchProgress.total === 0 && !isRunningBatch && (
          <p className="empty-state">No corrected segments in {formatBenchmarkSetSplit(batchSplit)} yet.</p>
        )}

        {batchOutcomes.length > 0 && (
          <div className="batch-outcomes">
            {batchOutcomes.map((outcome) => (
              <article
                className={outcome.status === "failed" ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
                key={`${outcome.sessionId}/${outcome.segmentId}`}
              >
                <div className="batch-outcome-heading">
                  <strong title={`${outcome.sessionId} / ${outcome.segmentId}`}>
                    {outcome.sessionId} / {outcome.segmentId}
                  </strong>
                  <em
                    className={
                      outcome.status === "failed" ? "batch-outcome-state batch-outcome-state-failed" : "batch-outcome-state"
                    }
                  >
                    {outcome.status}
                  </em>
                </div>
                {outcome.status === "failed" ? (
                  <p className="batch-outcome-error">{outcome.error ?? "Benchmark failed"}</p>
                ) : (
                  <p className="batch-outcome-meta">
                    {outcome.results.length} candidates{formatBatchOutcomeScore(outcome)}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {errorAnalysis.length > 0 && (
        <section className="panel error-analysis-panel">
          <div className="benchmark-header">
            <div>
              <h2>Error analysis</h2>
              <p>Heuristic diagnostics from the last benchmark set run, not a training signal</p>
            </div>
          </div>

          <div className="error-analysis-candidates">
            {errorAnalysis.map((analysis) => (
              <article className="error-analysis-candidate" key={analysis.candidateKey}>
                <strong title={analysis.candidateLabel}>{analysis.candidateLabel}</strong>
                <div className="error-category-badges">
                  {(Object.keys(analysis.categoryCounts) as SttErrorCategory[])
                    .filter((category) => analysis.categoryCounts[category] > 0)
                    .map((category) => (
                      <span className="error-category-badge" key={category}>
                        {ERROR_CATEGORY_LABELS[category]} · {analysis.categoryCounts[category]}
                      </span>
                    ))}
                </div>
                <ul className="error-examples">
                  {analysis.examples.map((example, index) => (
                    <li className="error-example" key={`${example.sessionId}/${example.segmentId}/${example.category}/${index}`}>
                      <span className="error-example-heading">
                        {ERROR_CATEGORY_LABELS[example.category]} · {example.sessionId} / {example.segmentId}
                      </span>
                      <span className="error-example-detail">{example.detail}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      )}

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
          <CorrectionKindSelect
            ariaLabel="Correction kind for the last transcript"
            value={correctionKind}
            disabled={!lastResult || isSavingCorrection || status === "recording" || status === "transcribing"}
            onChange={(kind) => {
              setCorrectionKind(kind);
              setCorrectionNotice("");
            }}
          />
          <button
            className="secondary-button"
            disabled={
              !lastResult ||
              isSavingCorrection ||
              correctionKind === "" ||
              status === "recording" ||
              status === "transcribing"
            }
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

const CORRECTION_KIND_OPTIONS: { value: CorrectionKind; label: string }[] = [
  { value: "acoustic", label: "Acoustic" },
  { value: "math_transform", label: "Math notation" },
  { value: "normalization", label: "Cleanup" },
  { value: "rephrasing", label: "Rephrase" },
];

function CorrectionKindSelect({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: CorrectionKind | "";
  onChange: (kind: CorrectionKind | "") => void;
  disabled?: boolean;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <select
      aria-label={ariaLabel}
      className="secondary-select"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onChange(isCorrectionKind(next) ? next : "");
      }}
    >
      <option value="">Correction kind…</option>
      {CORRECTION_KIND_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function formatCorrectionKind(kind: CorrectionKind): string {
  return CORRECTION_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function isCorrectionKind(value: string): value is CorrectionKind {
  return (
    value === "acoustic" ||
    value === "math_transform" ||
    value === "normalization" ||
    value === "rephrasing"
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

function formatBatchOutcomeScore(outcome: SttBenchmarkSetSegmentOutcome): string {
  const scores = outcome.results
    .map((result) => result.score)
    .filter((score): score is SttBenchmarkScore => score !== null);
  if (scores.length === 0) {
    return "";
  }

  const bestCer = Math.min(...scores.map((score) => score.value));
  return ` · best CER ${(bestCer * 100).toFixed(1)}%`;
}

const HIGH_CER_THRESHOLD = 0.3;
const LATENCY_OUTLIER_MULTIPLIER = 2;
const LATENCY_OUTLIER_FLOOR_MS = 500;
const MAX_EXAMPLES_PER_CANDIDATE = 4;

// Small local list; not exhaustive on purpose (heuristic diagnostic, not NLP).
const FRENCH_MATH_KEYWORDS = [
  "plus",
  "moins",
  "fois",
  "divise",
  "carre",
  "racine",
  "egal",
  "egale",
  "fraction",
  "puissance",
  "pi",
  "virgule",
  "parenthese",
  "racine carree",
  "au carre",
];

const ERROR_CATEGORY_LABELS: Record<SttErrorCategory, string> = {
  empty_output: "Empty output",
  high_cer: "High CER",
  symbol_mismatch: "Symbol/letter mismatch",
  keyword_mismatch: "French math keyword mismatch",
  latency_outlier: "Latency outlier",
};

function normalizeAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeForKeywordMatch(value: string): string {
  return ` ${normalizeAccents(value.toLowerCase()).replace(/[^a-z0-9]+/g, " ")} `;
}

function getSingleCharTokens(value: string): Set<string> {
  return new Set(
    normalizeAccents(value.toLowerCase())
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length === 1),
  );
}

function findMissingSymbolTokens(transcript: string, referenceTranscript: string): string[] {
  const referenceTokens = getSingleCharTokens(referenceTranscript);
  const transcriptTokens = getSingleCharTokens(transcript);
  return Array.from(referenceTokens).filter((token) => !transcriptTokens.has(token));
}

function findMissingKeywords(transcript: string, referenceTranscript: string): string[] {
  const normalizedReference = normalizeForKeywordMatch(referenceTranscript);
  const normalizedTranscript = normalizeForKeywordMatch(transcript);
  return FRENCH_MATH_KEYWORDS.filter(
    (keyword) => normalizedReference.includes(` ${keyword} `) && !normalizedTranscript.includes(` ${keyword} `),
  );
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function createEmptyCategoryCounts(): Record<SttErrorCategory, number> {
  return {
    empty_output: 0,
    high_cer: 0,
    symbol_mismatch: 0,
    keyword_mismatch: 0,
    latency_outlier: 0,
  };
}

/**
 * Deterministic, local heuristics only (see issue #41): no LaTeX parsing, no
 * semantic math equivalence, no model training. Flags are diagnostics to help
 * distinguish quality problems from latency problems, not a scoring system.
 */
function analyzeBatchErrors(outcomes: SttBenchmarkSetSegmentOutcome[]): CandidateErrorAnalysis[] {
  const byCandidate = new Map<
    string,
    { candidateLabel: string; entries: { sessionId: string; segmentId: string; result: SttBenchmarkResult }[] }
  >();

  for (const outcome of outcomes) {
    if (outcome.status !== "done") {
      continue;
    }

    for (const result of outcome.results) {
      const key = formatBenchmarkCandidateKey(result);
      const bucket = byCandidate.get(key) ?? { candidateLabel: formatBenchmarkCandidate(result), entries: [] };
      bucket.entries.push({ sessionId: outcome.sessionId, segmentId: outcome.segmentId, result });
      byCandidate.set(key, bucket);
    }
  }

  const analyses: CandidateErrorAnalysis[] = [];

  for (const [candidateKey, bucket] of byCandidate) {
    const candidateMedianDurationMs = median(bucket.entries.map((entry) => entry.result.transcriptionDurationMs));
    const categoryCounts = createEmptyCategoryCounts();
    const examples: SttErrorExample[] = [];

    for (const { sessionId, segmentId, result } of bucket.entries) {
      const flagged: { category: SttErrorCategory; detail: string }[] = [];

      if (result.transcript.trim().length === 0) {
        flagged.push({ category: "empty_output", detail: "STT candidate returned no text" });
      }

      if (result.score && result.score.value > HIGH_CER_THRESHOLD) {
        flagged.push({
          category: "high_cer",
          detail: `CER ${(result.score.value * 100).toFixed(1)}% above ${(HIGH_CER_THRESHOLD * 100).toFixed(0)}% threshold`,
        });
      }

      if (result.score) {
        const missingSymbols = findMissingSymbolTokens(result.transcript, result.score.referenceTranscript);
        if (missingSymbols.length > 0) {
          flagged.push({
            category: "symbol_mismatch",
            detail: `Missing symbol/letter token(s): ${missingSymbols.join(", ")}`,
          });
        }

        const missingKeywords = findMissingKeywords(result.transcript, result.score.referenceTranscript);
        if (missingKeywords.length > 0) {
          flagged.push({
            category: "keyword_mismatch",
            detail: `Missing keyword(s): ${missingKeywords.join(", ")}`,
          });
        }
      }

      if (
        candidateMedianDurationMs > 0 &&
        result.transcriptionDurationMs > candidateMedianDurationMs * LATENCY_OUTLIER_MULTIPLIER &&
        result.transcriptionDurationMs - candidateMedianDurationMs > LATENCY_OUTLIER_FLOOR_MS
      ) {
        flagged.push({
          category: "latency_outlier",
          detail: `${result.transcriptionDurationMs} ms vs candidate median ${Math.round(candidateMedianDurationMs)} ms`,
        });
      }

      for (const flag of flagged) {
        categoryCounts[flag.category] += 1;
        examples.push({
          sessionId,
          segmentId,
          category: flag.category,
          detail: flag.detail,
          transcript: result.transcript,
          referenceTranscript: result.score?.referenceTranscript ?? null,
          cer: result.score?.value ?? null,
          transcriptionDurationMs: result.transcriptionDurationMs,
        });
      }
    }

    const totalFlags = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
    if (totalFlags === 0) {
      continue;
    }

    analyses.push({
      candidateKey,
      candidateLabel: bucket.candidateLabel,
      scoredResultCount: bucket.entries.filter((entry) => entry.result.score !== null).length,
      categoryCounts,
      examples: examples.slice(0, MAX_EXAMPLES_PER_CANDIDATE),
    });
  }

  return analyses.sort((left, right) => left.candidateLabel.localeCompare(right.candidateLabel));
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
