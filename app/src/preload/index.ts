import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type TranscriptionResponse = {
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

contextBridge.exposeInMainWorld("dictex", {
  transcribeAudio: (audioBytes: Uint8Array, mimeType: string, options: TranscriptionOptions = {}) =>
    ipcRenderer.invoke("dictation:transcribe", audioBytes, mimeType, options) as Promise<TranscriptionResponse>,
  onDictationToggle: (callback: () => void) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("dictation:toggle", listener);
    return () => {
      ipcRenderer.removeListener("dictation:toggle", listener);
    };
  },
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: HotkeyStatus) => {
      callback(status);
    };
    ipcRenderer.on("dictation:hotkey-status", listener);
    return () => {
      ipcRenderer.removeListener("dictation:hotkey-status", listener);
    };
  },
  openDataFolder: () => ipcRenderer.invoke("diagnostics:open-data-folder") as Promise<boolean>,
  openEventsLog: () => ipcRenderer.invoke("diagnostics:open-events-log") as Promise<boolean>,
  openDictionaryFile: () => ipcRenderer.invoke("diagnostics:open-dictionary") as Promise<boolean>,
  openRulesFile: () => ipcRenderer.invoke("diagnostics:open-rules") as Promise<boolean>,
  getSttConfig: () => ipcRenderer.invoke("diagnostics:get-stt-config") as Promise<SttConfig>,
  getSttBenchmarkModels: () => ipcRenderer.invoke("diagnostics:get-stt-benchmark-models") as Promise<string[]>,
  getSttModels: () => ipcRenderer.invoke("diagnostics:get-stt-models") as Promise<string[]>,
  setSttModel: (model: string) => ipcRenderer.invoke("settings:set-stt-model", model) as Promise<SttConfig>,
  getRecentSegments: (limit = 20) => ipcRenderer.invoke("history:get-recent-segments", limit) as Promise<RecentSegment[]>,
  getSegmentAudio: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("audio:get-segment", audioSegment) as Promise<AudioSegmentPlayback>,
  saveSttCorrection: (correction: SttCorrectionRequest) =>
    ipcRenderer.invoke("corrections:save-stt", correction) as Promise<SttCorrectionResponse>,
  markSttBenchmarkSetMembership: (membership: SttBenchmarkSetMembershipRequest) =>
    ipcRenderer.invoke("benchmark-set:mark-stt", membership) as Promise<SttBenchmarkSetMembershipResponse>,
  runLatestSttBenchmark: () => ipcRenderer.invoke("benchmark:run-latest-stt") as Promise<SttBenchmarkResponse>,
  runSegmentSttBenchmark: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("benchmark:run-segment-stt", audioSegment) as Promise<SttBenchmarkResponse>,
  runSetSttBenchmark: (split: SttBenchmarkSetSplit, models?: string[]) =>
    ipcRenderer.invoke("benchmark:run-set-stt", { split, models }) as Promise<SttBenchmarkSetRunResponse>,
  summarizeSttBenchmarkSet: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:summarize-stt", { split }) as Promise<SttBenchmarkCandidateSummaryResponse>,
  selectSttCandidate: (request: SttCandidateSelectionRequest) =>
    ipcRenderer.invoke("candidate-selection:save-stt", request) as Promise<SttCandidateSelectionResponse>,
  getLatestSttCandidateSelection: () =>
    ipcRenderer.invoke("candidate-selection:get-latest-stt") as Promise<SttCandidateSelectionResponse | null>,
  onBatchBenchmarkProgress: (callback: (progress: SttBenchmarkSetProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: SttBenchmarkSetProgress) => {
      callback(progress);
    };
    ipcRenderer.on("benchmark:set-progress", listener);
    return () => {
      ipcRenderer.removeListener("benchmark:set-progress", listener);
    };
  },
});
