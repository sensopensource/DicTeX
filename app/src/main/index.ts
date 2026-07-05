import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TranscriptionResult = {
  transcript: string;
  copiedToClipboard: boolean;
  sessionId: string;
  segmentId: string;
};

type EngineTranscriptionResult = {
  transcript: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
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

  const venvPython =
    process.platform === "win32"
      ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
      : path.join(repoRoot, ".venv", "bin", "python");

  if (existsSync(venvPython)) {
    return {
      command: venvPython,
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

function transcribeWithPython(audioPath: string): Promise<EngineTranscriptionResult> {
  return new Promise((resolve, reject) => {
    const python = getPythonInvocation();
    const child = spawn(python.command, [...python.argsPrefix, enginePath, audioPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        PYTHONIOENCODING: "utf-8",
      },
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
        const parsed = JSON.parse(stdout) as {
          transcript?: unknown;
          stt_engine?: unknown;
          stt_model?: unknown;
          stt_language?: unknown;
          stt_duration?: unknown;
        };
        if (typeof parsed.transcript !== "string") {
          reject(new Error("Transcription process returned no transcript"));
          return;
        }
        resolve({
          transcript: parsed.transcript,
          sttEngine: typeof parsed.stt_engine === "string" ? parsed.stt_engine : "unknown",
          sttModel: typeof parsed.stt_model === "string" ? parsed.stt_model : "unknown",
          sttLanguage: typeof parsed.stt_language === "string" ? parsed.stt_language : "unknown",
          audioDurationSeconds: typeof parsed.stt_duration === "number" ? parsed.stt_duration : null,
        });
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
    const sttResult = await transcribeWithPython(audioPath);
    const transcriptionDurationMs = Date.now() - transcriptionStartedAt;

    await appendEvent({
      event_type: "stt_result",
      session_id: sessionId,
      segment_id: segmentId,
      created_at: new Date().toISOString(),
      audio_ref: audioRef,
      stt_engine: sttResult.sttEngine,
      stt_model: sttResult.sttModel,
      stt_language: sttResult.sttLanguage,
      stt_output: sttResult.transcript,
      corrected_transcript: null,
      audio_duration_seconds: sttResult.audioDurationSeconds,
      transcription_duration_ms: transcriptionDurationMs,
    });

    clipboard.writeText(sttResult.transcript);

    return {
      transcript: sttResult.transcript,
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
