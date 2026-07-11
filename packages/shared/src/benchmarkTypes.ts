import type { AudioSegmentRecord, BenchmarkCandidateIdentity, CorrectionKind, SttBenchmarkSetSplit } from "./localEvents.js";

/**
 * IPC-facing "live benchmark run" shapes shared by apps/lab's main/preload/
 * renderer (apps/dictex keeps its own pre-existing local copies of these —
 * see the PR description for why that duplication was left in place). Moving
 * these here means the Lab only declares this cross-process contract once
 * instead of three times.
 */

export type BenchmarkStage =
  | "stt"
  | "normalization"
  | "segment_classification"
  | "math_transform"
  | "correction_suggestion";

export type BenchmarkCandidate = {
  stage: BenchmarkStage;
  provider: string;
  model: string;
  variant?: string;
};

export type SttBenchmarkScore = {
  stage: "stt";
  metric: "cer";
  value: number;
  referenceTranscript: string;
  correctionCreatedAt: string | null;
};

export type SttBenchmarkResult = {
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

export type SttBenchmarkResponse = {
  source: AudioSegmentRecord;
  results: SttBenchmarkResult[];
  /** Quiet notes for candidates skipped at runtime (e.g. an optional provider
   * whose deps/model files are absent). Empty when every candidate ran. */
  diagnostics: string[];
};

export type SttCorrectionRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  rawTranscript: string;
  correctedTranscript: string;
  correctionKind: CorrectionKind;
  correctionMethod?: "keyboard";
};

export type SttCorrectionResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  correctionKind: CorrectionKind;
  correctionMethod: "keyboard";
};

export type SttBenchmarkSetMembershipRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  split: SttBenchmarkSetSplit;
};

export type SttBenchmarkSetMembershipResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  split: SttBenchmarkSetSplit;
};

export type SttCandidateSelectionRequest = {
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

export type SttCandidateSelectionResponse = {
  createdAt: string;
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

export type SttBenchmarkSetRunRequest = {
  split: SttBenchmarkSetSplit;
  /**
   * 1 to 3 full candidate identities to run (see issue #94). Omitted means
   * "every catalog candidate" — used by the unfiltered single-segment
   * benchmark endpoints, never by the checkbox-driven set run.
   */
  candidates?: BenchmarkCandidateIdentity[];
};

export type SttBenchmarkSetSegmentOutcome = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  status: "done" | "failed";
  error: string | null;
  results: SttBenchmarkResult[];
};

export type SttBenchmarkSetRunResponse = {
  split: SttBenchmarkSetSplit;
  total: number;
  done: number;
  failed: number;
  outcomes: SttBenchmarkSetSegmentOutcome[];
};

export type SttBenchmarkSetProgress = {
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

export type SttDatasetExportFileSummary = {
  correctionKind: string;
  file: string;
  recordCount: number;
};

export type SttDatasetExportSplitSummary = {
  split: SttBenchmarkSetSplit;
  segmentCount: number;
  correctedSegmentCount: number;
  recordCount: number;
  files: SttDatasetExportFileSummary[];
};

export type SttDatasetExportSummary = {
  createdAt: string;
  /** Absolute path of the export folder, or null when there was nothing to export. */
  exportDir: string | null;
  totalRecords: number;
  skippedUntypedCorrections: number;
  selectedCandidate: BenchmarkCandidateIdentity | null;
  selectionReason: string | null;
  splits: SttDatasetExportSplitSummary[];
};
