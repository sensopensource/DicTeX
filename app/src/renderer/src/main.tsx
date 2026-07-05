import React, { useEffect, useRef, useState } from "react";
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
};

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
  onDictationToggle: (callback: () => void) => () => void;
  onHotkeyStatus: (callback: (status: HotkeyStatus) => void) => () => void;
};

declare global {
  interface Window {
    dictex: DictationApi;
  }
}

type Status = "idle" | "recording" | "transcribing" | "done" | "error";

function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [lastPasteState, setLastPasteState] = useState<"none" | "pasted" | "clipboard-only">("none");
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

    return () => {
      removeToggleListener();
      removeHotkeyStatusListener();
    };
  }, []);

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
      setStatus("done");
    } catch (transcriptionError) {
      setStatus("error");
      setError(transcriptionError instanceof Error ? transcriptionError.message : "Transcription failed");
    }
  }

  async function copyTranscript(): Promise<void> {
    if (transcript) {
      await navigator.clipboard.writeText(transcript);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">DicTeX MVP</p>
        <h1>Speak once. Get text on your clipboard.</h1>
        <p className="lede">
          This first brick validates the OpenWhispr-like loop: record a short voice segment,
          send it to the local engine, show the transcript, and copy it automatically.
        </p>
        <p className="shortcut">
          Global shortcut: <strong>Win+Alt+Space</strong>{" "}
          {hotkeyStatus?.registered === false && <span className="shortcut-warning">not registered</span>}
        </p>
      </section>

      <section className="dictation-card">
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
          {status === "recording" ? "Release to transcribe" : "Hold to dictate"}
        </button>

        <div className={`status status-${status}`}>
          {status === "idle" && "Ready"}
          {status === "recording" && "Recording..."}
          {status === "transcribing" && "Transcribing locally..."}
          {status === "done" &&
            (lastPasteState === "pasted" ? "Transcript pasted into active app" : "Transcript copied to clipboard")}
          {status === "error" && "Something failed"}
        </div>

        {error && <pre className="error">{error}</pre>}

        <label className="transcript-label" htmlFor="transcript">
          Transcript
        </label>
        <textarea
          id="transcript"
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Your transcript will appear here."
        />

        <button className="secondary-button" disabled={!transcript} onClick={copyTranscript}>
          Copy transcript
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
