import { contextBridge, ipcRenderer } from "electron";

type TranscriptionResponse = {
  transcript: string;
  copiedToClipboard: boolean;
  sessionId: string;
  segmentId: string;
};

contextBridge.exposeInMainWorld("dictex", {
  transcribeAudio: (audioBytes: Uint8Array, mimeType: string) =>
    ipcRenderer.invoke("dictation:transcribe", audioBytes, mimeType) as Promise<TranscriptionResponse>,
});
