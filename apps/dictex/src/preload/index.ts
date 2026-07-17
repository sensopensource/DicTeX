import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import type { DictationTranscriptionOutcome } from "../main/dictationFlow.js";
import type { HomeOverlayState } from "../main/overlayPresenter.js";

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

type SttWorkerState = "starting" | "ready" | "busy" | "restarting" | "error" | "stopped";

type SttWorkerStatus = {
  state: SttWorkerState;
  workerGeneration: string | null;
  workerStartupMs: number | null;
  modelLoadMs: number | null;
  lastInferenceDurationMs: number | null;
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
};

type OpenLabResult = {
  ok: boolean;
  error?: string;
};

contextBridge.exposeInMainWorld("dictex", {
  transcribeAudio: (audioBytes: Uint8Array, mimeType: string, options?: TranscriptionOptions) =>
    ipcRenderer.invoke("dictation:transcribe", audioBytes, mimeType, options) as Promise<DictationTranscriptionOutcome>,
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
  openLab: () => ipcRenderer.invoke("app:open-lab") as Promise<OpenLabResult>,
  getSttConfig: () => ipcRenderer.invoke("diagnostics:get-stt-config") as Promise<SttConfig>,
  getSttModels: () => ipcRenderer.invoke("diagnostics:get-stt-models") as Promise<string[]>,
  getSttWorkerStatus: () => ipcRenderer.invoke("diagnostics:get-stt-worker-status") as Promise<SttWorkerStatus>,
  onSttWorkerStatus: (callback: (status: SttWorkerStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: SttWorkerStatus) => callback(status);
    ipcRenderer.on("stt-worker:status", listener);
    return () => ipcRenderer.removeListener("stt-worker:status", listener);
  },
  setSttModel: (model: string) => ipcRenderer.invoke("settings:set-stt-model", model) as Promise<SttConfig>,
  getNormalizerEnabled: () => ipcRenderer.invoke("settings:get-normalizer-enabled") as Promise<boolean>,
  setNormalizerEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("settings:set-normalizer-enabled", enabled) as Promise<boolean>,
  getRecentSegments: (limit = 20) => ipcRenderer.invoke("history:get-recent-segments", limit) as Promise<RecentSegment[]>,
  getSegmentAudio: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("audio:get-segment", audioSegment) as Promise<AudioSegmentPlayback>,
  // Home publishes the overlay states it owns (#166). `send`, not `invoke`: the
  // HUD must never make Home await anything, so a stalled or missing overlay
  // cannot slow a dictation down.
  publishOverlayState: (state: HomeOverlayState) => ipcRenderer.send("overlay:publish", state),
});
