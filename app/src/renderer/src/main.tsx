import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

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
  normalizedTranscript: string | null;
  normalizationCreatedAt: string | null;
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

type BenchmarkCandidateIdentity = {
  stage: string;
  provider: string;
  model: string;
  variant: string | null;
};

type SttBenchmarkCandidateSummary = {
  candidate: BenchmarkCandidateIdentity;
  resultCount: number;
  missingCount: number;
  scoredCount: number;
  meanCer: number | null;
  medianCer: number | null;
  meanWer: number | null;
  medianWer: number | null;
  meanLatencyMs: number | null;
};

type SttBenchmarkCandidateSummaryResponse = {
  split: SttBenchmarkSetSplit;
  totalSegments: number;
  candidates: SttBenchmarkCandidateSummary[];
};

type SttCandidateSelectionRequest = {
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

type SttCandidateSelectionResponse = {
  createdAt: string;
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

type SttDatasetExportFileSummary = {
  correctionKind: string;
  file: string;
  recordCount: number;
};

type SttDatasetExportSplitSummary = {
  split: SttBenchmarkSetSplit;
  segmentCount: number;
  correctedSegmentCount: number;
  recordCount: number;
  files: SttDatasetExportFileSummary[];
};

type SttDatasetExportSummary = {
  createdAt: string;
  exportDir: string | null;
  totalRecords: number;
  skippedUntypedCorrections: number;
  selectedCandidate: BenchmarkCandidateIdentity | null;
  selectionReason: string | null;
  splits: SttDatasetExportSplitSummary[];
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
  openDictionaryFile?: () => Promise<boolean>;
  openRulesFile?: () => Promise<boolean>;
  getSttConfig: () => Promise<SttConfig>;
  getSttBenchmarkModels?: () => Promise<string[]>;
  getSttModels?: () => Promise<string[]>;
  setSttModel?: (model: string) => Promise<SttConfig>;
  getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
  getSegmentAudio?: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  saveSttCorrection?: (correction: SttCorrectionRequest) => Promise<SttCorrectionResponse>;
  markSttBenchmarkSetMembership?: (
    membership: SttBenchmarkSetMembershipRequest,
  ) => Promise<SttBenchmarkSetMembershipResponse>;
  runLatestSttBenchmark?: () => Promise<SttBenchmarkResponse>;
  runSegmentSttBenchmark?: (audioSegment: AudioSegmentRecord) => Promise<SttBenchmarkResponse>;
  runSetSttBenchmark?: (split: SttBenchmarkSetSplit, models?: string[]) => Promise<SttBenchmarkSetRunResponse>;
  onBatchBenchmarkProgress?: (callback: (progress: SttBenchmarkSetProgress) => void) => () => void;
  summarizeSttBenchmarkSet?: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkCandidateSummaryResponse>;
  selectSttCandidate?: (request: SttCandidateSelectionRequest) => Promise<SttCandidateSelectionResponse>;
  getLatestSttCandidateSelection?: () => Promise<SttCandidateSelectionResponse | null>;
  exportSttDataset?: () => Promise<SttDatasetExportSummary>;
  openExportFolder?: (exportDir?: string) => Promise<boolean>;
};

declare global {
  interface Window {
    dictex: DictationApi;
  }
}

type Status = "idle" | "recording" | "transcribing" | "done" | "error";

type View = "home" | "benchmark" | "dataset";

function App(): React.ReactElement {
  const [view, setView] = useState<View>("home");
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [sttConfig, setSttConfig] = useState<SttConfig | null>(null);
  const [availableSttModels, setAvailableSttModels] = useState<string[]>([]);
  const [isSettingSttModel, setIsSettingSttModel] = useState(false);
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
  const [selectedBenchmarkModels, setSelectedBenchmarkModels] = useState<string[]>([]);
  const [benchmarkTargetKey, setBenchmarkTargetKey] = useState<string | null>(null);
  const [batchSplit, setBatchSplit] = useState<SttBenchmarkSetSplit>("test_frozen");
  const [batchProgress, setBatchProgress] = useState<SttBenchmarkSetProgress | null>(null);
  const [batchOutcomes, setBatchOutcomes] = useState<SttBenchmarkSetSegmentOutcome[]>([]);
  const [batchError, setBatchError] = useState("");
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [candidateSummary, setCandidateSummary] = useState<SttBenchmarkCandidateSummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<SttCandidateSelectionResponse | null>(null);
  const [selectionReasonDraft, setSelectionReasonDraft] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [isSelectingCandidateKey, setIsSelectingCandidateKey] = useState("");
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionKind, setCorrectionKind] = useState<CorrectionKind | "">("");
  const [benchmarkSetTargetKey, setBenchmarkSetTargetKey] = useState<string | null>(null);
  const [historyCorrectionTarget, setHistoryCorrectionTarget] = useState<HistoryCorrectionTarget | null>(null);
  const [historyCorrectionDraft, setHistoryCorrectionDraft] = useState("");
  const [historyCorrectionKind, setHistoryCorrectionKind] = useState<CorrectionKind | "">("");
  const [datasetExportSummary, setDatasetExportSummary] = useState<SttDatasetExportSummary | null>(null);
  const [datasetExportError, setDatasetExportError] = useState("");
  const [isExportingDataset, setIsExportingDataset] = useState(false);
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
    if (typeof window.dictex.getSttModels === "function") {
      void window.dictex.getSttModels().then(setAvailableSttModels).catch(() => {
        // Selector is optional; without the list the visible config line still shows the active model.
      });
    }
    if (typeof window.dictex.getSttBenchmarkModels === "function") {
      void window.dictex
        .getSttBenchmarkModels()
        .then((models) => {
          setBenchmarkModels(models);
          setSelectedBenchmarkModels(models.slice(0, 3));
        })
        .catch(() => {
          // Silently fail if benchmark models cannot be fetched; default UI behavior is fine
        });
    }
    if (typeof window.dictex.getLatestSttCandidateSelection === "function") {
      void window.dictex.getLatestSttCandidateSelection().then(setCurrentSelection).catch(() => {
        // Silently fail if the current selection cannot be fetched; the panel just shows none selected
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

  async function openDictionaryFile(): Promise<void> {
    if (typeof window.dictex.openDictionaryFile !== "function") {
      setNotice("Restart DicTeX to load the dictionary preload API");
      return;
    }

    try {
      const opened = await window.dictex.openDictionaryFile();
      setNotice(opened ? "Opened normalizer dictionary" : "Could not open normalizer dictionary");
    } catch (openError) {
      setNotice(openError instanceof Error ? openError.message : "Could not open normalizer dictionary");
    }
  }

  async function openRulesFile(): Promise<void> {
    if (typeof window.dictex.openRulesFile !== "function") {
      setNotice("Restart DicTeX to load the rules preload API");
      return;
    }

    try {
      const opened = await window.dictex.openRulesFile();
      setNotice(opened ? "Opened normalizer rules" : "Could not open normalizer rules");
    } catch (openError) {
      setNotice(openError instanceof Error ? openError.message : "Could not open normalizer rules");
    }
  }

  async function exportSttDataset(): Promise<void> {
    if (typeof window.dictex.exportSttDataset !== "function") {
      setDatasetExportError("Restart DicTeX to load the dataset export API");
      return;
    }

    setIsExportingDataset(true);
    setDatasetExportError("");
    try {
      const summary = await window.dictex.exportSttDataset();
      setDatasetExportSummary(summary);
    } catch (exportError) {
      setDatasetExportError(exportError instanceof Error ? exportError.message : "Dataset export failed");
    } finally {
      setIsExportingDataset(false);
    }
  }

  async function openExportFolder(): Promise<void> {
    if (typeof window.dictex.openExportFolder !== "function") {
      return;
    }

    try {
      await window.dictex.openExportFolder(datasetExportSummary?.exportDir ?? undefined);
    } catch {
      // Opening the folder is a convenience; a failure here is non-fatal.
    }
  }

  async function changeSttModel(model: string): Promise<void> {
    if (typeof window.dictex.setSttModel !== "function") {
      setNotice("Restart DicTeX to load the STT model preload API");
      return;
    }

    if (!model || model === sttConfig?.model) {
      return;
    }

    setIsSettingSttModel(true);

    try {
      const updated = await window.dictex.setSttModel(model);
      setSttConfig(updated);
      setNotice(`STT model set to ${updated.model} (applies to the next dictation)`);
    } catch (modelError) {
      setNotice(modelError instanceof Error ? modelError.message : "Could not set STT model");
    } finally {
      setIsSettingSttModel(false);
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

  function toggleBenchmarkModel(model: string): void {
    setSelectedBenchmarkModels((current) => {
      if (current.includes(model)) {
        return current.filter((selected) => selected !== model);
      }
      if (current.length >= 3) {
        return current;
      }
      return [...current, model];
    });
  }

  async function runSetSttBenchmark(): Promise<void> {
    if (typeof window.dictex.runSetSttBenchmark !== "function") {
      setBatchError("Restart DicTeX to load the benchmark set preload API");
      return;
    }

    if (selectedBenchmarkModels.length < 1) {
      setBatchError("Check at least one STT candidate to run");
      return;
    }

    setBatchError("");
    setNotice("");
    setBatchOutcomes([]);
    setBatchProgress(null);
    setIsRunningBatch(true);

    try {
      const response = await window.dictex.runSetSttBenchmark(batchSplit, selectedBenchmarkModels);
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

  async function summarizeCandidates(): Promise<void> {
    if (typeof window.dictex.summarizeSttBenchmarkSet !== "function") {
      setSummaryError("Restart DicTeX to load the benchmark summary preload API");
      return;
    }

    setSummaryError("");
    setIsSummarizing(true);

    try {
      const response = await window.dictex.summarizeSttBenchmarkSet(batchSplit);
      setCandidateSummary({
        ...response,
        candidates: response.candidates.filter((summary) => selectedBenchmarkModels.includes(summary.candidate.model)),
      });
    } catch (summaryRunError) {
      setSummaryError(summaryRunError instanceof Error ? summaryRunError.message : "Benchmark summary failed");
    } finally {
      setIsSummarizing(false);
    }
  }

  async function runAnalysis(): Promise<void> {
    await runSetSttBenchmark();
    await summarizeCandidates();
  }

  async function selectCandidate(candidate: BenchmarkCandidateIdentity): Promise<void> {
    if (typeof window.dictex.selectSttCandidate !== "function") {
      setSelectionError("Restart DicTeX to load the candidate selection preload API");
      return;
    }

    if (selectionReasonDraft.trim() === "") {
      setSelectionError("Enter a selection reason before marking a candidate selected");
      return;
    }

    const candidateKey = formatCandidateIdentityKey(candidate);
    setSelectionError("");
    setIsSelectingCandidateKey(candidateKey);

    try {
      const selection = await window.dictex.selectSttCandidate({
        candidate,
        selectionReason: selectionReasonDraft.trim(),
      });
      setCurrentSelection(selection);
      setSelectionReasonDraft("");
    } catch (selectionSaveError) {
      setSelectionError(selectionSaveError instanceof Error ? selectionSaveError.message : "Could not save candidate selection");
    } finally {
      setIsSelectingCandidateKey("");
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

  function handleTranscriptChange(value: string): void {
    setTranscript(value);
    setCorrectionNotice("");
  }

  function handleCorrectionKindChange(kind: CorrectionKind | ""): void {
    setCorrectionKind(kind);
    setCorrectionNotice("");
  }

  function handleHistoryCorrectionDraftChange(value: string): void {
    setHistoryCorrectionDraft(value);
    setCorrectionNotice("");
  }

  function handleHistoryCorrectionKindChange(kind: CorrectionKind | ""): void {
    setHistoryCorrectionKind(kind);
    setCorrectionNotice("");
  }

  function cancelHistoryCorrection(): void {
    setHistoryCorrectionTarget(null);
    setHistoryCorrectionDraft("");
    setHistoryCorrectionKind("");
  }

  function handleSelectionReasonDraftChange(value: string): void {
    setSelectionReasonDraft(value);
    setSelectionError("");
  }

  const statusLabel =
    status === "done" && lastPasteState === "pasted"
      ? "pasted"
      : status === "done" && lastPasteState === "clipboard-only"
        ? "copied"
        : status;

  if (view === "benchmark") {
    return (
      <main className="app-shell">
        <BenchmarkView
          status={status}
          benchmarkSource={benchmarkSource}
          benchmarkResults={benchmarkResults}
          benchmarkError={benchmarkError}
          isBenchmarking={isBenchmarking}
          benchmarkModels={benchmarkModels}
          benchmarkTargetKey={benchmarkTargetKey}
          runLatestSttBenchmark={runLatestSttBenchmark}
          isRunningBatch={isRunningBatch}
          batchSplit={batchSplit}
          setBatchSplit={setBatchSplit}
          batchProgress={batchProgress}
          batchOutcomes={batchOutcomes}
          batchError={batchError}
          runSetSttBenchmark={runSetSttBenchmark}
          selectedBenchmarkModels={selectedBenchmarkModels}
          toggleBenchmarkModel={toggleBenchmarkModel}
          runAnalysis={runAnalysis}
          candidateSummary={candidateSummary}
          summaryError={summaryError}
          isSummarizing={isSummarizing}
          summarizeCandidates={summarizeCandidates}
          currentSelection={currentSelection}
          selectionReasonDraft={selectionReasonDraft}
          setSelectionReasonDraft={handleSelectionReasonDraftChange}
          selectionError={selectionError}
          isSelectingCandidateKey={isSelectingCandidateKey}
          selectCandidate={selectCandidate}
          errorAnalysis={errorAnalysis}
          onBack={() => setView("home")}
        />
      </main>
    );
  }

  if (view === "dataset") {
    return (
      <main className="app-shell">
        <DatasetView
          exportSttDataset={() => void exportSttDataset()}
          openExportFolder={() => void openExportFolder()}
          isExportingDataset={isExportingDataset}
          datasetExportSummary={datasetExportSummary}
          datasetExportError={datasetExportError}
          onBack={() => setView("home")}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <HomeView
        status={status}
        statusLabel={statusLabel}
        startRecording={() => void startRecording()}
        stopRecording={() => stopRecording()}
        hotkeyStatus={hotkeyStatus}
        sttConfig={sttConfig}
        availableSttModels={availableSttModels}
        isSettingSttModel={isSettingSttModel}
        changeSttModel={(model) => void changeSttModel(model)}
        lastResult={lastResult}
        lastPasteState={lastPasteState}
        recentSegments={recentSegments}
        historyError={historyError}
        isLoadingHistory={isLoadingHistory}
        loadRecentSegments={() => void loadRecentSegments()}
        audioError={audioError}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        playHistoryAudio={(segment) => void playHistoryAudio(segment)}
        copyHistoryTranscript={(segment, mode) => void copyHistoryTranscript(segment, mode)}
        benchmarkSetTargetKey={benchmarkSetTargetKey}
        markSttBenchmarkSetMembership={(segment, split) => void markSttBenchmarkSetMembership(segment, split)}
        isSavingCorrection={isSavingCorrection}
        startHistoryCorrection={startHistoryCorrection}
        benchmarkTargetKey={benchmarkTargetKey}
        runSegmentSttBenchmark={(segment) => void runSegmentSttBenchmark(segment)}
        isBenchmarking={isBenchmarking}
        isRunningBatch={isRunningBatch}
        historyCorrectionTarget={historyCorrectionTarget}
        historyCorrectionDraft={historyCorrectionDraft}
        setHistoryCorrectionDraft={handleHistoryCorrectionDraftChange}
        historyCorrectionKind={historyCorrectionKind}
        setHistoryCorrectionKind={handleHistoryCorrectionKindChange}
        saveHistoryCorrection={() => void saveHistoryCorrection()}
        cancelHistoryCorrection={cancelHistoryCorrection}
        transcript={transcript}
        setTranscript={handleTranscriptChange}
        error={error}
        notice={notice}
        correctionNotice={correctionNotice}
        copyTranscript={() => void copyTranscript()}
        correctionKind={correctionKind}
        setCorrectionKind={handleCorrectionKindChange}
        saveSttCorrection={() => void saveSttCorrection()}
        openDataFolder={() => void openDataFolder()}
        openEventsLog={() => void openEventsLog()}
        openDictionaryFile={() => void openDictionaryFile()}
        openRulesFile={() => void openRulesFile()}
        onNavigate={setView}
      />
    </main>
  );
}

type HomeViewProps = {
  status: Status;
  statusLabel: string;
  startRecording: () => void;
  stopRecording: () => void;
  hotkeyStatus: HotkeyStatus | null;
  sttConfig: SttConfig | null;
  availableSttModels: string[];
  isSettingSttModel: boolean;
  changeSttModel: (model: string) => void;
  lastResult: TranscriptionResult | null;
  lastPasteState: "none" | "pasted" | "clipboard-only";
  recentSegments: RecentSegment[];
  historyError: string;
  isLoadingHistory: boolean;
  loadRecentSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playHistoryAudio: (segment: RecentSegment) => void;
  copyHistoryTranscript: (segment: RecentSegment, mode: "raw" | "corrected") => void;
  benchmarkSetTargetKey: string | null;
  markSttBenchmarkSetMembership: (segment: RecentSegment, split: SttBenchmarkSetSplit) => void;
  isSavingCorrection: boolean;
  startHistoryCorrection: (segment: RecentSegment) => void;
  benchmarkTargetKey: string | null;
  runSegmentSttBenchmark: (segment: RecentSegment) => void;
  isBenchmarking: boolean;
  isRunningBatch: boolean;
  historyCorrectionTarget: HistoryCorrectionTarget | null;
  historyCorrectionDraft: string;
  setHistoryCorrectionDraft: (value: string) => void;
  historyCorrectionKind: CorrectionKind | "";
  setHistoryCorrectionKind: (kind: CorrectionKind | "") => void;
  saveHistoryCorrection: () => void;
  cancelHistoryCorrection: () => void;
  transcript: string;
  setTranscript: (value: string) => void;
  error: string;
  notice: string;
  correctionNotice: string;
  copyTranscript: () => void;
  correctionKind: CorrectionKind | "";
  setCorrectionKind: (kind: CorrectionKind | "") => void;
  saveSttCorrection: () => void;
  openDataFolder: () => void;
  openEventsLog: () => void;
  openDictionaryFile: () => void;
  openRulesFile: () => void;
  onNavigate: (view: View) => void;
};

function HomeView({
  status,
  statusLabel,
  startRecording,
  stopRecording,
  hotkeyStatus,
  sttConfig,
  availableSttModels,
  isSettingSttModel,
  changeSttModel,
  lastResult,
  lastPasteState,
  recentSegments,
  historyError,
  isLoadingHistory,
  loadRecentSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playHistoryAudio,
  copyHistoryTranscript,
  benchmarkSetTargetKey,
  markSttBenchmarkSetMembership,
  isSavingCorrection,
  startHistoryCorrection,
  benchmarkTargetKey,
  runSegmentSttBenchmark,
  isBenchmarking,
  isRunningBatch,
  historyCorrectionTarget,
  historyCorrectionDraft,
  setHistoryCorrectionDraft,
  historyCorrectionKind,
  setHistoryCorrectionKind,
  saveHistoryCorrection,
  cancelHistoryCorrection,
  transcript,
  setTranscript,
  error,
  notice,
  correctionNotice,
  copyTranscript,
  correctionKind,
  setCorrectionKind,
  saveSttCorrection,
  openDataFolder,
  openEventsLog,
  openDictionaryFile,
  openRulesFile,
  onNavigate,
}: HomeViewProps): React.ReactElement {
  const [historyExpanded, setHistoryExpanded] = useState(false);

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Local dictation</h1>
        </div>
        <div className={`status-pill status-${statusLabel}`}>{statusLabel}</div>
      </header>

      <section className="panel nav-panel">
        <button className="nav-button" onClick={() => onNavigate("benchmark")}>
          Benchmark
        </button>
        <button className="nav-button" onClick={() => onNavigate("dataset")}>
          Dataset
        </button>
      </section>

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

        <div className="shortcut-row">
          <span>STT model</span>
          <select
            aria-label="Active STT model"
            className="secondary-select"
            disabled={
              typeof window.dictex.setSttModel !== "function" ||
              isSettingSttModel ||
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

        {historyExpanded && (recentSegments.length === 0 && !historyError ? (
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
        ))}
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
            <button className="secondary-button" disabled={isSavingCorrection} onClick={cancelHistoryCorrection}>
              Cancel
            </button>
          </div>

          <p className="correction-raw">Raw: {historyCorrectionTarget.rawTranscript || "-"}</p>
          <textarea
            value={historyCorrectionDraft}
            onChange={(event) => setHistoryCorrectionDraft(event.target.value)}
            aria-label="Corrected transcript"
          />
          <div className="actions">
            <CorrectionKindSelect
              ariaLabel={`Correction kind for ${historyCorrectionTarget.sessionId} / ${historyCorrectionTarget.segmentId}`}
              value={historyCorrectionKind}
              disabled={isSavingCorrection}
              onChange={(kind) => setHistoryCorrectionKind(kind)}
            />
            <button
              className="secondary-button"
              disabled={isSavingCorrection || historyCorrectionDraft.length === 0 || historyCorrectionKind === ""}
              onClick={saveHistoryCorrection}
            >
              {isSavingCorrection ? "Saving" : "Save correction"}
            </button>
          </div>
        </section>
      )}

      <section className="panel transcript-panel">
        <label className="transcript-label" htmlFor="transcript">
          Last transcript (raw)
        </label>
        <textarea
          id="transcript"
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Your transcript will appear here."
        />

        {lastResult?.normalizationApplied && (
          <div className="normalized-preview">
            <span className="normalized-preview-label">Inserted (normalized)</span>
            <p className="normalized-preview-text">{lastResult.normalizedTranscript || "-"}</p>
          </div>
        )}

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
            onChange={(kind) => setCorrectionKind(kind)}
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
            onClick={saveSttCorrection}
          >
            {isSavingCorrection ? "Saving" : "Save correction"}
          </button>
          <button className="secondary-button" onClick={openDataFolder}>
            Open data folder
          </button>
          <button className="secondary-button" onClick={openEventsLog}>
            Open events log
          </button>
          <button
            className="secondary-button"
            disabled={typeof window.dictex.openDictionaryFile !== "function"}
            onClick={openDictionaryFile}
          >
            Open dictionary
          </button>
          <button
            className="secondary-button"
            disabled={typeof window.dictex.openRulesFile !== "function"}
            onClick={openRulesFile}
          >
            Open rules
          </button>
        </div>
      </section>
    </>
  );
}

type BenchmarkViewProps = {
  status: Status;
  benchmarkSource: AudioSegmentRecord | null;
  benchmarkResults: SttBenchmarkResult[];
  benchmarkError: string;
  isBenchmarking: boolean;
  benchmarkModels: string[];
  benchmarkTargetKey: string | null;
  runLatestSttBenchmark: () => void;
  isRunningBatch: boolean;
  batchSplit: SttBenchmarkSetSplit;
  setBatchSplit: (split: SttBenchmarkSetSplit) => void;
  batchProgress: SttBenchmarkSetProgress | null;
  batchOutcomes: SttBenchmarkSetSegmentOutcome[];
  batchError: string;
  runSetSttBenchmark: () => void;
  selectedBenchmarkModels: string[];
  toggleBenchmarkModel: (model: string) => void;
  runAnalysis: () => void;
  candidateSummary: SttBenchmarkCandidateSummaryResponse | null;
  summaryError: string;
  isSummarizing: boolean;
  summarizeCandidates: () => void;
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
  errorAnalysis: CandidateErrorAnalysis[];
  onBack: () => void;
};

function BenchmarkView({
  status,
  benchmarkSource,
  benchmarkResults,
  benchmarkError,
  isBenchmarking,
  benchmarkModels,
  benchmarkTargetKey,
  runLatestSttBenchmark,
  isRunningBatch,
  batchSplit,
  setBatchSplit,
  batchProgress,
  batchOutcomes,
  batchError,
  runSetSttBenchmark,
  selectedBenchmarkModels,
  toggleBenchmarkModel,
  runAnalysis,
  candidateSummary,
  summaryError,
  isSummarizing,
  summarizeCandidates,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
  errorAnalysis,
  onBack,
}: BenchmarkViewProps): React.ReactElement {
  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Benchmark</h1>
        </div>
        <button className="secondary-button" onClick={onBack}>
          Back to home
        </button>
      </header>

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
            <p>Compare 1-3 STT candidates over every corrected {formatBenchmarkSetSplit(batchSplit)} segment</p>
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
                selectedBenchmarkModels.length < 1 ||
                status === "recording" ||
                status === "transcribing"
              }
              onClick={() => void runAnalysis()}
            >
              {typeof window.dictex.runSetSttBenchmark !== "function"
                ? "Restart app"
                : isRunningBatch
                  ? "Running"
                  : "Run analysis"}
            </button>
          </div>
        </div>

        {benchmarkModels.length > 0 && (
          <div className="candidate-checkbox-row" role="group" aria-label="STT candidates to compare (1-3)">
            {benchmarkModels.map((model) => {
              const isChecked = selectedBenchmarkModels.includes(model);
              return (
                <label key={model} className="candidate-checkbox">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isRunningBatch || isBenchmarking || (!isChecked && selectedBenchmarkModels.length >= 3)}
                    onChange={() => toggleBenchmarkModel(model)}
                  />
                  {model}
                </label>
              );
            })}
          </div>
        )}

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

      <section className="panel summary-panel">
        <div className="benchmark-header">
          <div>
            <h2>Candidate summary</h2>
            <p>
              Compare {selectedBenchmarkModels.length > 0 ? selectedBenchmarkModels.join(", ") : "checked candidates"} over{" "}
              {formatBenchmarkSetSplit(batchSplit)}. CER/WER: lower is better.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={typeof window.dictex.summarizeSttBenchmarkSet !== "function" || isSummarizing}
            onClick={() => void summarizeCandidates()}
          >
            {typeof window.dictex.summarizeSttBenchmarkSet !== "function"
              ? "Restart app"
              : isSummarizing
                ? "Summarizing"
                : "Summarize by candidate"}
          </button>
        </div>

        {summaryError && <pre className="error">{summaryError}</pre>}

        <p className="empty-state">
          {currentSelection
            ? `Selected base candidate: ${formatCandidateIdentity(currentSelection.candidate)} — ${currentSelection.selectionReason}${
                currentSelection.createdAt ? ` (${formatTimestamp(currentSelection.createdAt)})` : ""
              }. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting.`
            : "No base STT candidate selected yet. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting."}
        </p>

        {!candidateSummary && (
          <p className="empty-state">Run analysis above, or summarize by candidate, to see per-candidate scores.</p>
        )}

        {candidateSummary && candidateSummary.split !== batchSplit && (
          <p className="empty-state">
            Showing {formatBenchmarkSetSplit(candidateSummary.split)}; select the split again and re-run to refresh.
          </p>
        )}

        {candidateSummary && candidateSummary.totalSegments === 0 && (
          <p className="empty-state">No corrected segments in {formatBenchmarkSetSplit(candidateSummary.split)} yet.</p>
        )}

        {candidateSummary && candidateSummary.totalSegments > 0 && candidateSummary.candidates.length === 0 && (
          <p className="empty-state">No candidate results match the checked candidates above yet.</p>
        )}

        {candidateSummary && candidateSummary.candidates.length > 0 && (
          <>
            <div className="actions">
              <input
                aria-label="Candidate selection reason"
                className="reason-input"
                placeholder="Selection reason (e.g. best quality/latency tradeoff on test_frozen)"
                value={selectionReasonDraft}
                onChange={(event) => setSelectionReasonDraft(event.target.value)}
              />
            </div>

            {selectionError && <pre className="error">{selectionError}</pre>}

            <table className="summary-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Segments</th>
                  <th>Mean CER</th>
                  <th>Median CER</th>
                  <th>Mean WER</th>
                  <th>Median WER</th>
                  <th>Mean latency</th>
                  <th>Missing</th>
                  <th>Selection</th>
                </tr>
              </thead>
              <tbody>
                {candidateSummary.candidates.map((summary) => {
                  const candidateKey = formatCandidateIdentityKey(summary.candidate);
                  const isSelected = currentSelection !== null && formatCandidateIdentityKey(currentSelection.candidate) === candidateKey;

                  return (
                    <tr key={candidateKey}>
                      <td title={candidateKey}>
                        {formatCandidateIdentity(summary.candidate)}
                        {isSelected && <span className="selected-badge">Selected</span>}
                      </td>
                      <td>{summary.resultCount}</td>
                      <td>{formatRatePercent(summary.meanCer)}</td>
                      <td>{formatRatePercent(summary.medianCer)}</td>
                      <td>{formatRatePercent(summary.meanWer)}</td>
                      <td>{formatRatePercent(summary.medianWer)}</td>
                      <td>{formatLatency(summary.meanLatencyMs === null ? null : Math.round(summary.meanLatencyMs))}</td>
                      <td>{summary.missingCount}</td>
                      <td>
                        <button
                          className="secondary-button"
                          disabled={
                            typeof window.dictex.selectSttCandidate !== "function" || isSelectingCandidateKey === candidateKey
                          }
                          onClick={() => void selectCandidate(summary.candidate)}
                        >
                          {isSelectingCandidateKey === candidateKey ? "Saving" : isSelected ? "Reselect" : "Select"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="panel error-analysis-panel">
        <div className="benchmark-header">
          <div>
            <h2>Error analysis</h2>
            <p>Heuristic diagnostics from the last benchmark set run, not a training signal</p>
          </div>
        </div>

        {errorAnalysis.length === 0 ? (
          <p className="empty-state">Run analysis above to see per-candidate error diagnostics.</p>
        ) : (
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
        )}
      </section>
    </>
  );
}

type DatasetViewProps = {
  exportSttDataset: () => void;
  openExportFolder: () => void;
  isExportingDataset: boolean;
  datasetExportSummary: SttDatasetExportSummary | null;
  datasetExportError: string;
  onBack: () => void;
};

function DatasetView({
  exportSttDataset,
  openExportFolder,
  isExportingDataset,
  datasetExportSummary,
  datasetExportError,
  onBack,
}: DatasetViewProps): React.ReactElement {
  const exportAvailable = typeof window.dictex.exportSttDataset === "function";
  const summary = datasetExportSummary;

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Dataset</h1>
        </div>
        <button className="secondary-button" onClick={onBack}>
          Back to home
        </button>
      </header>

      <section className="panel" aria-busy={isExportingDataset}>
        <div className="benchmark-header">
          <div>
            <h2>Export corrected STT dataset</h2>
            <p>
              Writes local JSONL under the data folder, split by train pool / validation / test frozen and by correction
              kind. Reads the event log only — history is never rewritten, nothing is uploaded.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={!exportAvailable || isExportingDataset}
            onClick={exportSttDataset}
          >
            {!exportAvailable ? "Restart app" : isExportingDataset ? "Exporting" : "Export dataset"}
          </button>
        </div>

        {datasetExportError && <pre className="error">{datasetExportError}</pre>}

        {summary && (
          <div className="dataset-export-summary">
            {summary.exportDir === null ? (
              <p className="empty-state">
                No corrected segments in any benchmark split yet. Correct segments and add them to a split first.
              </p>
            ) : (
              <>
                <p className="dataset-export-path" title={summary.exportDir}>
                  {summary.exportDir}
                </p>
                <div className="benchmark-meta">
                  <span>{summary.totalRecords} records</span>
                  <span>
                    Base:{" "}
                    {summary.selectedCandidate ? formatCandidateIdentity(summary.selectedCandidate) : "none selected"}
                  </span>
                  {summary.skippedUntypedCorrections > 0 && (
                    <span title="Legacy corrections without a correction kind cannot be routed into the dataset">
                      {summary.skippedUntypedCorrections} untyped skipped
                    </span>
                  )}
                </div>

                {summary.splits.length === 0 ? (
                  <p className="empty-state">No records were written.</p>
                ) : (
                  <ul className="dataset-export-splits">
                    {summary.splits.map((splitSummary) => (
                      <li key={splitSummary.split}>
                        <strong>{formatBenchmarkSetSplit(splitSummary.split)}</strong>{" "}
                        <span>
                          {splitSummary.recordCount} records · {splitSummary.correctedSegmentCount}/
                          {splitSummary.segmentCount} corrected segments
                        </span>
                        <ul>
                          {splitSummary.files.map((file) => (
                            <li key={file.file} title={file.file}>
                              {formatDatasetCorrectionKind(file.correctionKind)}: {file.recordCount} · {file.file}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}

                {typeof window.dictex.openExportFolder === "function" && (
                  <button className="secondary-button" onClick={openExportFolder}>
                    Open export folder
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function formatDatasetCorrectionKind(correctionKind: string): string {
  return isCorrectionKind(correctionKind) ? formatCorrectionKind(correctionKind) : correctionKind;
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

function formatCandidateIdentity(candidate: BenchmarkCandidateIdentity): string {
  return `${candidate.stage}:${candidate.provider}/${candidate.model}${candidate.variant ? ` (${candidate.variant})` : ""}`;
}

function formatCandidateIdentityKey(candidate: BenchmarkCandidateIdentity): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

function formatRatePercent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
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
