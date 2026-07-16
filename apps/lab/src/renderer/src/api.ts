import type {
  AudioSegmentRecord,
  BenchmarkCandidateIdentity,
  BenchmarkMathTransformRunProjection,
  BenchmarkRunListEntry,
  LegacyRuleResolution,
  LegacyRulesMigrationPreview,
  NormalizerBenchmarkRunExportSummary,
  ReconstructedSegment,
  RulesMigrationConfirmation,
  RulesMigrationReceipt,
  SttBenchmarkCandidateSummaryResponse,
  SttBenchmarkRunDetail,
  SttBenchmarkRunExportSummary,
  SttBenchmarkSetMembershipRequest,
  SttBenchmarkSetMembershipResponse,
  SttBenchmarkSetPreview,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSplit,
  SttCandidateSelectionRequest,
  SttCandidateSelectionResponse,
  SttCorrectionRequest,
  SttCorrectionResponse,
  SttDatasetExportSummary,
} from "@dictex/shared";
import type { DatasetBuilderSaveRequest, DatasetBuilderSaveResponse } from "../../main/datasetBuilder.js";
import type { SttBenchmarkCandidateOption } from "../../main/candidateCatalog.js";
import type { SttPromptVariantCreateRequest, SttPromptVariantListEntry } from "../../main/promptVariants.js";
import type {
  NormalizerBenchmarkRunResponse,
  NormalizerBenchmarkSetPreview,
} from "../../main/normalizerBenchmark.js";

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

export type DataFolderStatus = {
  path: string;
  isDefault: boolean;
};

export type SourceFolderCheck = {
  exists: boolean;
  eventsFound: boolean;
};

type BenchmarkRunExportSummary = SttBenchmarkRunExportSummary | NormalizerBenchmarkRunExportSummary;

export type LabApi = {
  getDataFolder: () => Promise<DataFolderStatus>;
  setDataFolder: (folder: string) => Promise<DataFolderStatus>;
  resetDataFolder: () => Promise<DataFolderStatus>;
  pickDataFolder: () => Promise<DataFolderStatus | null>;
  checkDataFolder: () => Promise<SourceFolderCheck>;
  getSegments: (limit?: number) => Promise<ReconstructedSegment[]>;
  getSegmentAudio: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  saveSttCorrection: (correction: SttCorrectionRequest) => Promise<SttCorrectionResponse>;
  markSttBenchmarkSetMembership: (
    membership: SttBenchmarkSetMembershipRequest,
  ) => Promise<SttBenchmarkSetMembershipResponse>;
  previewSttBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkSetPreview>;
  previewNormalizerBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<NormalizerBenchmarkSetPreview>;
  runSetSttBenchmark: (
    split: SttBenchmarkSetSplit,
    candidates: BenchmarkCandidateIdentity[],
  ) => Promise<SttBenchmarkSetRunResponse>;
  runSetNormalizerBenchmark: (
    split: SttBenchmarkSetSplit,
    candidate: BenchmarkCandidateIdentity,
  ) => Promise<NormalizerBenchmarkRunResponse>;
  previewRulesMigration: (resolutions?: LegacyRuleResolution[]) => Promise<LegacyRulesMigrationPreview>;
  migrateRules: (confirmation: RulesMigrationConfirmation) => Promise<RulesMigrationReceipt>;
  getBenchmarkRunDetail: (
    runId: string,
  ) => Promise<SttBenchmarkRunDetail | BenchmarkMathTransformRunProjection | null>;
  listBenchmarkRuns: (split: SttBenchmarkSetSplit) => Promise<BenchmarkRunListEntry[]>;
  exportBenchmarkRun: (runId: string) => Promise<BenchmarkRunExportSummary>;
  summarizeLegacySttBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkCandidateSummaryResponse>;
  selectSttCandidate: (request: SttCandidateSelectionRequest) => Promise<SttCandidateSelectionResponse>;
  getLatestSttCandidateSelection: () => Promise<SttCandidateSelectionResponse | null>;
  saveDatasetBuilderEntry: (request: DatasetBuilderSaveRequest) => Promise<DatasetBuilderSaveResponse>;
  prefillDatasetBuilderLayer2: (literalTranscript: string) => Promise<string>;
  exportSttDataset: () => Promise<SttDatasetExportSummary>;
  openExportFolder: (exportDir?: string) => Promise<boolean>;
  getSttBenchmarkCandidates: () => Promise<SttBenchmarkCandidateOption[]>;
  listSttPromptVariants: () => Promise<SttPromptVariantListEntry[]>;
  createSttPromptVariant: (request: SttPromptVariantCreateRequest) => Promise<SttPromptVariantListEntry>;
  openLabDataFolder: () => Promise<boolean>;
  openSourceDataFolder: () => Promise<boolean>;
  openSourceRulesFolder: () => Promise<boolean>;
  openLabEventsLog: () => Promise<boolean>;
  onBatchBenchmarkProgress: (callback: (progress: SttBenchmarkSetProgress) => void) => () => void;
};

declare global {
  interface Window {
    dictexLab: LabApi;
  }
}

export const api: LabApi = window.dictexLab;
