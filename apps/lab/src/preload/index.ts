import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  AudioSegmentRecord,
  ReconstructedSegment,
  SttBenchmarkSetSplit,
  SttBenchmarkResponse,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetProgress,
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

  // Benchmark runs.
  runLatestSttBenchmark: () => ipcRenderer.invoke("benchmark:run-latest-stt") as Promise<SttBenchmarkResponse>,
  runSegmentSttBenchmark: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("benchmark:run-segment-stt", audioSegment) as Promise<SttBenchmarkResponse>,
  runSetSttBenchmark: (split: SttBenchmarkSetSplit, models?: string[]) =>
    ipcRenderer.invoke("benchmark:run-set-stt", { split, models }) as Promise<SttBenchmarkSetRunResponse>,
  summarizeSttBenchmarkSet: (split: SttBenchmarkSetSplit) =>
    ipcRenderer.invoke("benchmark-set:summarize-stt", { split }) as Promise<SttBenchmarkCandidateSummaryResponse>,

  // Candidate selection (own store).
  selectSttCandidate: (request: SttCandidateSelectionRequest) =>
    ipcRenderer.invoke("candidate-selection:save-stt", request) as Promise<SttCandidateSelectionResponse>,
  getLatestSttCandidateSelection: () =>
    ipcRenderer.invoke("candidate-selection:get-latest-stt") as Promise<SttCandidateSelectionResponse | null>,

  // Dataset builder (own store, manual two-layer entries, #78).
  saveDatasetBuilderEntry: (request: DatasetBuilderSaveRequest) =>
    ipcRenderer.invoke("dataset-builder:save-entry", request) as Promise<DatasetBuilderSaveResponse>,

  // Dataset export (own store).
  exportSttDataset: () => ipcRenderer.invoke("dataset:export-stt") as Promise<SttDatasetExportSummary>,
  openExportFolder: (exportDir?: string) =>
    ipcRenderer.invoke("dataset:open-export-folder", exportDir) as Promise<boolean>,

  // Diagnostics / STT benchmark model universe.
  getSttBenchmarkModels: () => ipcRenderer.invoke("diagnostics:get-stt-benchmark-models") as Promise<string[]>,
  openLabDataFolder: () => ipcRenderer.invoke("diagnostics:open-lab-data-folder") as Promise<boolean>,
  openSourceDataFolder: () => ipcRenderer.invoke("diagnostics:open-source-data-folder") as Promise<boolean>,
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
