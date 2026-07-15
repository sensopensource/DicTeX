import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  AudioSegmentRecord,
  BenchmarkCandidateIdentity,
  ReconstructedSegment,
  SttBenchmarkSetSplit,
  SttBenchmarkSetPreview,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetProgress,
  SttBenchmarkRunDetail,
  BenchmarkMathTransformRunProjection,
  BenchmarkRunListEntry,
  SttBenchmarkRunExportSummary,
  NormalizerBenchmarkRunExportSummary,
  LegacyRuleResolution,
  LegacyRulesMigrationPreview,
  RulesMigrationReceipt,
  RulesMigrationConfirmation,
  SttBenchmarkCandidateSummaryResponse,
  SttCandidateSelectionRequest,
  SttCandidateSelectionResponse,
  SttCorrectionRequest,
  SttCorrectionResponse,
  SttBenchmarkSetMembershipRequest,
  SttBenchmarkSetMembershipResponse,
  SttDatasetExportSummary,
} from "@dictex/shared";
import type { DatasetBuilderSaveRequest, DatasetBuilderSaveResponse } from "../main/datasetBuilder.js";
import type { SttBenchmarkCandidateOption } from "../main/candidateCatalog.js";
import type { SttPromptVariantCreateRequest, SttPromptVariantListEntry } from "../main/promptVariants.js";
import type {
  NormalizerBenchmarkRunResponse,
  NormalizerBenchmarkSetPreview,
} from "../main/normalizerBenchmark.js";

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

type DataFolderStatus = {
  path: string;
  isDefault: boolean;
};

type SourceFolderCheck = {
  exists: boolean;
  eventsFound: boolean;
};

// The Lab's IPC surface. No dictation/microphone/hotkey/clipboard: only
// read-only reads of DicTeX's data folder + writes into the Lab's own store.
contextBridge.exposeInMainWorld("dictexLab", {
  // Configurable DicTeX data folder (source, read-only).
  getDataFolder: () => ipcRenderer.invoke("settings:get-data-folder") as Promise<DataFolderStatus>,
  setDataFolder: (folder: string) => ipcRenderer.invoke("settings:set-data-folder", folder) as Promise<DataFolderStatus>,
  resetDataFolder: () => ipcRenderer.invoke("settings:reset-data-folder") as Promise<DataFolderStatus>,
  pickDataFolder: () => ipcRenderer.invoke("settings:pick-data-folder") as Promise<DataFolderStatus | null>,
  checkDataFolder: () => ipcRenderer.invoke("source:check-data-folder") as Promise<SourceFolderCheck>,

  // Segments (read-only source + own correction/split state).
  getSegments: (limit = 50) => ipcRenderer.invoke("segments:list", limit) as Promise<ReconstructedSegment[]>,
  getSegmentAudio: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("segments:get-audio", audioSegment) as Promise<AudioSegmentPlayback>,

  // Corrections + splits (own store).
  saveSttCorrection: (correction: SttCorrectionRequest) =>
    ipcRenderer.invoke("corrections:save-stt", correction) as Promise<SttCorrectionResponse>,
  markSttBenchmarkSetMembership: (membership: SttBenchmarkSetMembershipRequest) =>
    ipcRenderer.invoke("benchmark-set:mark-stt", membership) as Promise<SttBenchmarkSetMembershipResponse>,

  // Experiments: what a run over this split would freeze, then the launch
  // itself (issue #138). A benchmark result only ever exists inside a run.
  previewSttBenchmarkSet: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:preview", { split }) as Promise<SttBenchmarkSetPreview>,
  previewNormalizerBenchmarkSet: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:preview-normalizer", { split }) as Promise<NormalizerBenchmarkSetPreview>,
  runSetSttBenchmark: (split: SttBenchmarkSetSplit, candidates: BenchmarkCandidateIdentity[]) =>
    ipcRenderer.invoke("benchmark:run-set-stt", { split, candidates }) as Promise<SttBenchmarkSetRunResponse>,
  runSetNormalizerBenchmark: (split: SttBenchmarkSetSplit, candidate: BenchmarkCandidateIdentity) =>
    ipcRenderer.invoke("benchmark:run-set-normalizer", { split, candidate }) as Promise<NormalizerBenchmarkRunResponse>,
  previewRulesMigration: (resolutions: LegacyRuleResolution[] = []) =>
    ipcRenderer.invoke("normalizer-rules:preview-migration", resolutions) as Promise<LegacyRulesMigrationPreview>,
  migrateRules: (confirmation: RulesMigrationConfirmation) =>
    ipcRenderer.invoke("normalizer-rules:migrate", confirmation) as Promise<RulesMigrationReceipt>,
  // Results: the run list of a split, then one run's own snapshot, outputs,
  // failures and summary (issues #122/#138). The legacy summary reads only
  // pre-#122 results (no run_id).
  getBenchmarkRunDetail: (runId: string) =>
    ipcRenderer.invoke("benchmark-run:detail", { runId }) as Promise<
      SttBenchmarkRunDetail | BenchmarkMathTransformRunProjection | null
    >,
  listBenchmarkRuns: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:list-runs", { split }) as Promise<BenchmarkRunListEntry[]>,
  exportBenchmarkRun: (runId: string) =>
    ipcRenderer.invoke("benchmark-run:export-llm", { runId }) as Promise<
      SttBenchmarkRunExportSummary | NormalizerBenchmarkRunExportSummary
    >,
  summarizeLegacySttBenchmarkSet: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:summarize-legacy-stt", { split }) as Promise<SttBenchmarkCandidateSummaryResponse>,

  // Candidate selection (own store).
  selectSttCandidate: (request: SttCandidateSelectionRequest) =>
    ipcRenderer.invoke("candidate-selection:save-stt", request) as Promise<SttCandidateSelectionResponse>,
  getLatestSttCandidateSelection: () =>
    ipcRenderer.invoke("candidate-selection:get-latest-stt") as Promise<SttCandidateSelectionResponse | null>,

  // Dataset builder (own store, manual two-layer entries, #78).
  saveDatasetBuilderEntry: (request: DatasetBuilderSaveRequest) =>
    ipcRenderer.invoke("dataset-builder:save-entry", request) as Promise<DatasetBuilderSaveResponse>,
  // Layer 2 prefill from the SOURCE folder's normalizer (read-only, #101).
  prefillDatasetBuilderLayer2: (literalTranscript: string) =>
    ipcRenderer.invoke("dataset-builder:prefill-layer2", literalTranscript) as Promise<string>,

  // Dataset export (own store).
  exportSttDataset: () => ipcRenderer.invoke("dataset:export-stt") as Promise<SttDatasetExportSummary>,
  openExportFolder: (exportDir?: string) =>
    ipcRenderer.invoke("dataset:open-export-folder", exportDir) as Promise<boolean>,

  // Diagnostics / STT benchmark candidate catalog (issue #94).
  getSttBenchmarkCandidates: () =>
    ipcRenderer.invoke("diagnostics:get-stt-benchmark-candidates") as Promise<SttBenchmarkCandidateOption[]>,

  // STT prompt variants (own store; issue #121).
  listSttPromptVariants: () => ipcRenderer.invoke("prompt-variants:list") as Promise<SttPromptVariantListEntry[]>,
  createSttPromptVariant: (request: SttPromptVariantCreateRequest) =>
    ipcRenderer.invoke("prompt-variants:create", request) as Promise<SttPromptVariantListEntry>,
  openLabDataFolder: () => ipcRenderer.invoke("diagnostics:open-lab-data-folder") as Promise<boolean>,
  openSourceDataFolder: () => ipcRenderer.invoke("diagnostics:open-source-data-folder") as Promise<boolean>,
  openSourceRulesFolder: () => ipcRenderer.invoke("diagnostics:open-source-rules-folder") as Promise<boolean>,
  openLabEventsLog: () => ipcRenderer.invoke("diagnostics:open-lab-events-log") as Promise<boolean>,

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
