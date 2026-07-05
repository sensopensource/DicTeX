import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TranscriptionResult = {
  transcript: string;
  copiedToClipboard: boolean;
  sessionId: string;
  segmentId: string;
};

type PythonInvocation = {
  command: string;
  argsPrefix: string[];
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const enginePath = path.join(repoRoot, "engine", "transcribe.py");
const sessionId = `session_${new Date().toISOString().replace(/\D/g, "")}`;

let segmentCounter = 0;

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: "DicTeX",
    backgroundColor: "#f5efe1",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function getPythonInvocation(): PythonInvocation {
  if (process.env.DICTEX_PYTHON) {
    return {
      command: process.env.DICTEX_PYTHON,
      argsPrefix: [],
    };
  }

  if (process.platform === "win32") {
    return {
      command: "py",
      argsPrefix: ["-3.11"],
    };
  }

  return {
    command: "python3",
    argsPrefix: [],
  };
}

function getDataRoot(): string {
  return path.join(app.getPath("userData"), "data");
}

function getAudioExtension(mimeType: string): string {
  if (mimeType.includes("webm")) {
    return "webm";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  return "audio";
}

function getNextSegmentId(): string {
  segmentCounter += 1;
  return `seg_${String(segmentCounter).padStart(4, "0")}`;
}

function toPortableRef(basePath: string, targetPath: string): string {
  return path.relative(basePath, targetPath).split(path.sep).join("/");
}

async function appendEvent(event: Record<string, JsonValue>): Promise<void> {
  const dataRoot = getDataRoot();
  await mkdir(dataRoot, { recursive: true });
  await appendFile(path.join(dataRoot, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function transcribeWithPython(audioPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = getPythonInvocation();
    const child = spawn(python.command, [...python.argsPrefix, enginePath, audioPath], {
      cwd: repoRoot,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Transcription process exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as { transcript?: unknown };
        if (typeof parsed.transcript !== "string") {
          reject(new Error("Transcription process returned no transcript"));
          return;
        }
        resolve(parsed.transcript);
      } catch (error) {
        reject(error);
      }
    });
  });
}

ipcMain.handle(
  "dictation:transcribe",
  async (_event, audioBytes: Uint8Array, mimeType: string): Promise<TranscriptionResult> => {
    const createdAt = new Date().toISOString();
    const segmentId = getNextSegmentId();
    const extension = getAudioExtension(mimeType);
    const dataRoot = getDataRoot();
    const audioDir = path.join(dataRoot, "audio", sessionId);
    await mkdir(audioDir, { recursive: true });

    const audioPath = path.join(audioDir, `${segmentId}.${extension}`);
    await writeFile(audioPath, Buffer.from(audioBytes));
    const audioRef = toPortableRef(dataRoot, audioPath);

    await appendEvent({
      event_type: "audio_segment",
      session_id: sessionId,
      segment_id: segmentId,
      created_at: createdAt,
      audio_ref: audioRef,
      audio_mime_type: mimeType || "unknown",
      audio_size_bytes: audioBytes.byteLength,
    });

    const transcriptionStartedAt = Date.now();
    const transcript = await transcribeWithPython(audioPath);
    const transcriptionDurationMs = Date.now() - transcriptionStartedAt;

    await appendEvent({
      event_type: "stt_result",
      session_id: sessionId,
      segment_id: segmentId,
      created_at: new Date().toISOString(),
      audio_ref: audioRef,
      stt_engine: "dictex-local-engine",
      stt_model: "fake-transcriber-v0",
      stt_language: "fr",
      stt_output: transcript,
      corrected_transcript: null,
      transcription_duration_ms: transcriptionDurationMs,
    });

    clipboard.writeText(transcript);

    return {
      transcript,
      copiedToClipboard: true,
      sessionId,
      segmentId,
    };
  },
);

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
