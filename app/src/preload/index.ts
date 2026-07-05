import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type TranscriptionResponse = {
  transcript: string;
  copiedToClipboard: boolean;
  pastedToActiveApp: boolean;
  sessionId: string;
  segmentId: string;
};

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

type HotkeyStatus = {
  accelerator: string;
  registered: boolean;
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
});
