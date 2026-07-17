import type { DictationTranscriptionOutcome } from "../../main/dictationFlow.js";
import type { HomeOverlayState } from "../../main/overlayPresenter.js";

export type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

export type HotkeyStatus = {
  accelerator: string;
  registered: boolean;
};

export type SttConfig = {
  engine: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
};

export type SttWorkerState = "starting" | "ready" | "busy" | "restarting" | "error" | "stopped";

export type SttWorkerStatus = {
  state: SttWorkerState;
  workerGeneration: string | null;
  workerStartupMs: number | null;
  modelLoadMs: number | null;
  lastInferenceDurationMs: number | null;
};

export type AudioSegmentRecord = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
};

export type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

export type RecentSegment = {
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
};

export type OpenLabResult = {
  ok: boolean;
  error?: string;
};

export type DictexApi = {
  transcribeAudio: (
    audioBytes: Uint8Array,
    mimeType: string,
    options?: TranscriptionOptions,
  ) => Promise<DictationTranscriptionOutcome>;
  onDictationToggle: (callback: () => void) => () => void;
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void;
  openDataFolder: () => Promise<boolean>;
  openEventsLog: () => Promise<boolean>;
  openDictionaryFile: () => Promise<boolean>;
  openRulesFile: () => Promise<boolean>;
  openLab: () => Promise<OpenLabResult>;
  getSttConfig: () => Promise<SttConfig>;
  getSttModels?: () => Promise<string[]>;
  getSttWorkerStatus?: () => Promise<SttWorkerStatus>;
  onSttWorkerStatus?: (callback: (status: SttWorkerStatus) => void) => () => void;
  setSttModel?: (model: string) => Promise<SttConfig>;
  getNormalizerEnabled?: () => Promise<boolean>;
  setNormalizerEnabled?: (enabled: boolean) => Promise<boolean>;
  getRecentSegments?: (limit?: number) => Promise<RecentSegment[]>;
  getSegmentAudio?: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  publishOverlayState?: (state: HomeOverlayState) => void;
};

declare global {
  interface Window {
    dictex: DictexApi;
  }
}

export const api: DictexApi = window.dictex;
