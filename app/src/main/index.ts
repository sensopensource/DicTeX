import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalEvents, reconstructSegments, type ReconstructedSegment } from "./local-events";

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

type TranscriptionOptions = {
  autoPaste?: boolean;
  trigger?: "manual" | "global_hotkey";
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

type RecentSegment = ReconstructedSegment;

type SttBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  transcript: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
};

type SttBenchmarkResponse = {
  source: AudioSegmentRecord;
  results: SttBenchmarkResult[];
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
const globalHotkey = "Super+Alt+Space";
const sttBenchmarkModels = ["tiny", "base", "small"];

let mainWindow: BrowserWindow | null = null;
let globalHotkeyRegistered = false;
let segmentCounter = 0;

function getSttConfig(): SttConfig {
  return {
    engine: "faster-whisper",
    model: process.env.DICTEX_STT_MODEL || "base",
    language: process.env.DICTEX_STT_LANGUAGE || "fr",
    device: process.env.DICTEX_STT_DEVICE || "cpu",
    computeType: process.env.DICTEX_STT_COMPUTE_TYPE || "int8",
  };
}

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
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

  mainWindow.webContents.on("did-finish-load", () => {
    sendHotkeyStatus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function sendHotkeyStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("dictation:hotkey-status", {
    accelerator: "Win+Alt+Space",
    registered: globalHotkeyRegistered,
  });
}

function registerGlobalHotkey(): void {
  globalHotkeyRegistered = globalShortcut.register(globalHotkey, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dictation:toggle");
    }
  });

  sendHotkeyStatus();
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

function getEventsPath(): string {
  return path.join(getDataRoot(), "events.jsonl");
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

function getAudioMimeType(audioRef: string): string {
  if (audioRef.endsWith(".webm")) {
    return "audio/webm";
  }

  if (audioRef.endsWith(".wav")) {
    return "audio/wav";
  }

  return "application/octet-stream";
}

function getNextSegmentId(): string {
  segmentCounter += 1;
  return `seg_${String(segmentCounter).padStart(4, "0")}`;
}

function toPortableRef(basePath: string, targetPath: string): string {
  return path.relative(basePath, targetPath).split(path.sep).join("/");
}

function resolveDataRef(portableRef: string): string {
  const dataRoot = path.resolve(getDataRoot());
  const targetPath = path.resolve(dataRoot, portableRef);
  const relative = path.relative(dataRoot, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Data reference points outside data directory: ${portableRef}`);
  }

  return targetPath;
}

async function appendEvent(event: Record<string, JsonValue>): Promise<void> {
  const dataRoot = getDataRoot();
  await mkdir(dataRoot, { recursive: true });
  await appendFile(getEventsPath(), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
  });
}

async function getLatestAudioSegment(): Promise<AudioSegmentRecord | null> {
  const [latestSegment] = reconstructSegments(await readLocalEvents(getEventsPath()), 1);
  if (!latestSegment) {
    return null;
  }

  return {
    sessionId: latestSegment.sessionId,
    segmentId: latestSegment.segmentId,
    audioRef: latestSegment.audioRef,
  };
}

async function getRecentSegments(limit = 20): Promise<RecentSegment[]> {
  return reconstructSegments(await readLocalEvents(getEventsPath()), limit);
}

async function runSttBenchmarkForSegment(source: AudioSegmentRecord): Promise<SttBenchmarkResponse> {
  const audioPath = resolveDataRef(source.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found: ${source.audioRef}`);
  }

  const baseConfig = getSttConfig();
  const results: SttBenchmarkResult[] = [];

  for (const model of sttBenchmarkModels) {
    const config = {
      ...baseConfig,
      model,
    };
    const transcriptionStartedAt = Date.now();
    const sttResult = await transcribeWithPython(audioPath, config);
    const transcriptionDurationMs = Date.now() - transcriptionStartedAt;
    const result: SttBenchmarkResult = {
      sessionId: source.sessionId,
      segmentId: source.segmentId,
      audioRef: source.audioRef,
      sttEngine: sttResult.sttEngine,
      sttModel: sttResult.sttModel,
      sttLanguage: sttResult.sttLanguage,
      transcript: sttResult.transcript,
      audioDurationSeconds: sttResult.audioDurationSeconds,
      transcriptionDurationMs,
    };

    await appendEvent({
      event_type: "stt_benchmark_result",
      session_id: result.sessionId,
      segment_id: result.segmentId,
      created_at: new Date().toISOString(),
      audio_ref: result.audioRef,
      stt_engine: result.sttEngine,
      stt_model: result.sttModel,
      stt_language: result.sttLanguage,
      transcript: result.transcript,
      audio_duration_seconds: result.audioDurationSeconds,
      transcription_duration_ms: result.transcriptionDurationMs,
    });

    results.push(result);
  }

  return {
    source,
    results,
  };
}

function transcribeWithPython(audioPath: string, config: SttConfig = getSttConfig()): Promise<EngineTranscriptionResult> {
  return new Promise((resolve, reject) => {
    const python = getPythonInvocation();
    const child = spawn(python.command, [...python.argsPrefix, enginePath, audioPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        PYTHONIOENCODING: "utf-8",
        DICTEX_STT_MODEL: config.model,
        DICTEX_STT_LANGUAGE: config.language,
        DICTEX_STT_DEVICE: config.device,
        DICTEX_STT_COMPUTE_TYPE: config.computeType,
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

function pasteClipboardIntoActiveApp(): Promise<boolean> {
  if (process.platform !== "win32") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
      ],
      {
        windowsHide: true,
      },
    );

    child.on("error", () => {
      resolve(false);
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

ipcMain.handle(
  "dictation:transcribe",
  async (
    _event,
    audioBytes: Uint8Array,
    mimeType: string,
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> => {
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
    const pastedToActiveApp =
      options.autoPaste === true && sttResult.transcript.trim().length > 0
        ? await pasteClipboardIntoActiveApp()
        : false;

    return {
      transcript: sttResult.transcript,
      copiedToClipboard: true,
      pastedToActiveApp,
      sessionId,
      segmentId,
      sttEngine: sttResult.sttEngine,
      sttModel: sttResult.sttModel,
      sttLanguage: sttResult.sttLanguage,
      audioDurationSeconds: sttResult.audioDurationSeconds,
      transcriptionDurationMs,
    };
  },
);

ipcMain.handle("benchmark:run-latest-stt", async (): Promise<SttBenchmarkResponse> => {
  const latestAudioSegment = await getLatestAudioSegment();
  if (!latestAudioSegment) {
    throw new Error("No stored audio segment found");
  }

  return runSttBenchmarkForSegment(latestAudioSegment);
});

ipcMain.handle("history:get-recent-segments", async (_event, limit?: number): Promise<RecentSegment[]> => {
  return getRecentSegments(typeof limit === "number" ? limit : 20);
});

ipcMain.handle("audio:get-segment", async (_event, source: AudioSegmentRecord): Promise<AudioSegmentPlayback> => {
  if (
    !source ||
    typeof source.sessionId !== "string" ||
    typeof source.segmentId !== "string" ||
    typeof source.audioRef !== "string"
  ) {
    throw new Error("Invalid audio segment");
  }

  const audioPath = resolveDataRef(source.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found: ${source.audioRef}`);
  }

  return {
    audioBytes: await readFile(audioPath),
    mimeType: getAudioMimeType(source.audioRef),
  };
});

ipcMain.handle("clipboard:write-text", (_event, text: string): boolean => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("diagnostics:open-data-folder", async (): Promise<boolean> => {
  const dataRoot = getDataRoot();
  await mkdir(dataRoot, { recursive: true });
  const error = await shell.openPath(dataRoot);
  return error.length === 0;
});

ipcMain.handle("diagnostics:open-events-log", async (): Promise<boolean> => {
  const dataRoot = getDataRoot();
  await mkdir(dataRoot, { recursive: true });
  const eventsPath = path.join(dataRoot, "events.jsonl");
  if (!existsSync(eventsPath)) {
    await writeFile(eventsPath, "", { encoding: "utf8" });
  }
  const error = await shell.openPath(eventsPath);
  return error.length === 0;
});

ipcMain.handle("diagnostics:get-stt-config", (): SttConfig => getSttConfig());

app.whenReady().then(() => {
  createWindow();
  registerGlobalHotkey();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      sendHotkeyStatus();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
