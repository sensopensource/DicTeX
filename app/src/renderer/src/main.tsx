import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
};

type TranscriptionResult = {
  transcript: string;
  copiedToClipboard: boolean;
  pastedToActiveApp: boolean;
  sessionId: string;
  segmentId: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
};

type SttConfig = Pick<TranscriptionResult, "sttEngine" | "sttModel" | "sttLanguage">;

type HotkeyStatus = {
  accelerator: string;
  registered: boolean;
};

type DictationApi = {
  transcribeAudio: (
    audioBytes: Uint8Array,
    mimeType: string,
    options?: TranscriptionOptions,
  ) => Promise<TranscriptionResult>;
  getSttConfig: () => Promise<SttConfig>;
  openDataFolder: () => Promise<boolean>;
  openEventsLog: () => Promise<boolean>;
  onDictationToggle: (callback: () => void) => () => void;
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void;
};

declare global {
  interface Window {
    dictex: DictationApi;
  }
}

type Status = "idle" | "recording" | "transcribing" | "done" | "error";
type PasteState = "none" | "pasted" | "clipboard-only";

function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return "-";
  }

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatAudioDuration(durationSeconds: number | null): string {
  if (durationSeconds === null) {
    return "-";
  }

  return `${durationSeconds.toFixed(1)} s`;
}

function formatPasteState(pasteState: PasteState): string {
  if (pasteState === "pasted") {
    return "Pasted";
  }

  if (pasteState === "clipboard-only") {
    return "Clipboard only";
  }

  return "-";
}

function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [lastPasteState, setLastPasteState] = useState<PasteState>("none");
  const [sttConfig, setSttConfig] = useState<SttConfig>({
    sttEngine: "faster-whisper",
    sttModel: "-",
    sttLanguage: "-",
  });
  const [lastSegment, setLastSegment] = useState<{
    sessionId: string;
    segmentId: string;
    audioDurationSeconds: number | null;
    transcriptionDurationMs: number | null;
  }>({
    sessionId: "-",
    segmentId: "-",
    audioDurationSeconds: null,
    transcriptionDurationMs: null,
  });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const pendingTranscriptionOptionsRef = useRef<TranscriptionOptions>({ trigger: "manual" });

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const removeToggleListener = window.dictex.onDictationToggle(() => {
      if (statusRef.current === "recording") {
        stopRecording({ autoPaste: true, trigger: "global_hotkey" });
        return;
      }

      if (statusRef.current === "transcribing") {
        return;
      }

      void startRecording();
    });
    const removeHotkeyStatusListener = window.dictex.onHotkeyStatus(setHotkeyStatus);

    void window.dictex.getSttConfig().then(setSttConfig).catch(() => {
      setError("Could not load STT diagnostics");
    });

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
    };
  }, []);

  const statusText = useMemo(() => {
    if (status === "idle") {
      return "Ready";
    }

    if (status === "recording") {
      return "Recording";
    }

    if (status === "transcribing") {
      return "Transcribing";
    }

    if (status === "done") {
      return lastPasteState === "pasted" ? "Pasted" : "Copied";
    }

    return "Error";
  }, [lastPasteState, status]);

  async function startRecording(): Promise<void> {
    if (isStartingRef.current || recorderRef.current?.state === "recording" || statusRef.current === "transcribing") {
      return;
    }

    isStartingRef.current = true;
    stopRequestedRef.current = false;
    pendingTranscriptionOptionsRef.current = { trigger: "manual" };
    setError("");
    setStatus("recording");
    setTranscript("");
    setLastPasteState("none");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void transcribeRecording(recorder.mimeType || "audio/webm");
      };

      recorder.start();

      if (stopRequestedRef.current) {
        stopRecording();
      }
    } catch (recordingError) {
      setStatus("error");
      setError(recordingError instanceof Error ? recordingError.message : "Microphone access failed");
    } finally {
      isStartingRef.current = false;
    }
  }

  function stopRecording(options: TranscriptionOptions = { trigger: "manual" }): void {
    pendingTranscriptionOptionsRef.current = options;

    if (recorderRef.current && recorderRef.current.state === "recording") {
      setStatus("transcribing");
      recorderRef.current.stop();
      return;
    }

    if (isStartingRef.current) {
      stopRequestedRef.current = true;
    }
  }

  async function transcribeRecording(mimeType: string): Promise<void> {
    try {
      const audioBlob = new Blob(chunksRef.current, { type: mimeType });
      const audioBuffer = await audioBlob.arrayBuffer();
      const result = await window.dictex.transcribeAudio(
        new Uint8Array(audioBuffer),
        mimeType,
        pendingTranscriptionOptionsRef.current,
      );

      setTranscript(result.transcript);
      setLastPasteState(result.pastedToActiveApp ? "pasted" : "clipboard-only");
      setSttConfig({
        sttEngine: result.sttEngine,
        sttModel: result.sttModel,
        sttLanguage: result.sttLanguage,
      });
      setLastSegment({
        sessionId: result.sessionId,
        segmentId: result.segmentId,
        audioDurationSeconds: result.audioDurationSeconds,
        transcriptionDurationMs: result.transcriptionDurationMs,
      });
      setStatus("done");
    } catch (transcriptionError) {
      setStatus("error");
      setError(transcriptionError instanceof Error ? transcriptionError.message : "Transcription failed");
    }
  }

  async function copyTranscript(): Promise<void> {
    if (transcript) {
      await navigator.clipboard.writeText(transcript);
      setLastPasteState("clipboard-only");
    }
  }

  async function openLocalPath(openPath: () => Promise<boolean>, failureMessage: string): Promise<void> {
    setError("");
    try {
      const opened = await openPath();
      if (!opened) {
        setError(failureMessage);
      }
    } catch {
      setError(failureMessage);
    }
  }

  return (
    <main className="shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Local dictation</h1>
        </div>
        <div className={`status-pill status-${status}`}>{statusText}</div>
      </header>

      <section className="utility-grid">
        <section className="panel dictation-panel" aria-labelledby="dictation-title">
          <div className="panel-header">
            <div>
              <h2 id="dictation-title">Dictation</h2>
            </div>
            <div className="shortcut">
              <span>{hotkeyStatus?.accelerator ?? "Win+Alt+Space"}</span>
              <strong className={hotkeyStatus?.registered ? "is-on" : hotkeyStatus ? "is-off" : "is-pending"}>
                {hotkeyStatus ? (hotkeyStatus.registered ? "Registered" : "Not registered") : "Checking"}
              </strong>
            </div>
          </div>

          <button
            className="record-button"
            disabled={status === "transcribing"}
            onMouseDown={startRecording}
            onMouseUp={() => stopRecording()}
            onMouseLeave={() => stopRecording()}
            onTouchStart={(event) => {
              event.preventDefault();
              void startRecording();
            }}
            onTouchEnd={(event) => {
              event.preventDefault();
              stopRecording();
            }}
          >
            {status === "recording" ? "Release to transcribe" : "Hold to Dictate"}
          </button>

          {error && <pre className="error">{error}</pre>}

          <label className="transcript-label" htmlFor="transcript">
            Latest transcript
          </label>
          <textarea
            id="transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="The latest transcript will appear here."
          />

          <button className="secondary-button" disabled={!transcript} onClick={copyTranscript}>
            Copy transcript
          </button>
        </section>

        <aside className="panel diagnostics-panel" aria-labelledby="diagnostics-title">
          <div className="panel-header">
            <div>
              <h2 id="diagnostics-title">Diagnostics</h2>
            </div>
          </div>

          <dl className="diagnostic-list">
            <div>
              <dt>Status</dt>
              <dd>{statusText}</dd>
            </div>
            <div>
              <dt>Paste result</dt>
              <dd>{formatPasteState(lastPasteState)}</dd>
            </div>
            <div>
              <dt>STT engine</dt>
              <dd>{sttConfig.sttEngine}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{sttConfig.sttModel}</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{sttConfig.sttLanguage}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{lastSegment.sessionId}</dd>
            </div>
            <div>
              <dt>Segment</dt>
              <dd>{lastSegment.segmentId}</dd>
            </div>
            <div>
              <dt>Audio duration</dt>
              <dd>{formatAudioDuration(lastSegment.audioDurationSeconds)}</dd>
            </div>
            <div>
              <dt>Transcription latency</dt>
              <dd>{formatDurationMs(lastSegment.transcriptionDurationMs)}</dd>
            </div>
          </dl>

          <div className="diagnostic-actions">
            <button
              className="secondary-button"
              onClick={() => void openLocalPath(window.dictex.openDataFolder, "Could not open the data folder")}
            >
              Open data folder
            </button>
            <button
              className="secondary-button"
              onClick={() => void openLocalPath(window.dictex.openEventsLog, "Could not open the events log")}
            >
              Open events log
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
