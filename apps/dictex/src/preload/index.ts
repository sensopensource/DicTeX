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
};

type OpenLabResult = {
  ok: boolean;
  error?: string;
};

contextBridge.exposeInMainWorld("dictex", {
  transcribeAudio: (audioBytes: Uint8Array, mimeType: string, options?: TranscriptionOptions) =>
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
  openLab: () => ipcRenderer.invoke("app:open-lab") as Promise<OpenLabResult>,
  getSttConfig: () => ipcRenderer.invoke("diagnostics:get-stt-config") as Promise<SttConfig>,
  getSttModels: () => ipcRenderer.invoke("diagnostics:get-stt-models") as Promise<string[]>,
  setSttModel: (model: string) => ipcRenderer.invoke("settings:set-stt-model", model) as Promise<SttConfig>,
  getRecentSegments: (limit = 20) => ipcRenderer.invoke("history:get-recent-segments", limit) as Promise<RecentSegment[]>,
  getSegmentAudio: (audioSegment: AudioSegmentRecord) =>
    ipcRenderer.invoke("audio:get-segment", audioSegment) as Promise<AudioSegmentPlayback>,
});
