import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLatestAudioSegment as getLatestAudioSegmentFromEvents,
  getLatestSttCorrection,
  isCorrectionKind,
  readLocalEvents,
  reconstructRecentSegments,
  type CorrectionKind,
  type ReconstructedSegment,
  type SttBenchmarkSetSplit,
} from "./localEvents.js";

type TranscriptionResult = {
  transcript: string;
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

type BenchmarkStage =
  | "stt"
  | "normalization"
  | "segment_classification"
  | "math_transform"
  | "correction_suggestion";

type BenchmarkCandidate = {
  stage: BenchmarkStage;
  provider: string;
  model: string;
  variant?: string;
};

type SttBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  candidate: BenchmarkCandidate;
  stage: BenchmarkStage;
  provider: string;
  model: string;
  variant: string | null;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  transcript: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
  score: SttBenchmarkScore | null;
};

type SttBenchmarkResponse = {
  source: AudioSegmentRecord;
  results: SttBenchmarkResult[];
};

type SttBenchmarkScore = {
  stage: "stt";
  metric: "cer";
  value: number;
  referenceTranscript: string;
  correctionCreatedAt: string | null;
};

type SttCorrectionRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  rawTranscript: string;
  correctedTranscript: string;
  correctionKind: CorrectionKind;
  correctionMethod?: "keyboard";
};

type SttCorrectionResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  correctionKind: CorrectionKind;
  correctionMethod: "keyboard";
};

type SttBenchmarkSetMembershipRequest = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  split: SttBenchmarkSetSplit;
};

type SttBenchmarkSetMembershipResponse = {
  createdAt: string;
  sessionId: string;
  segmentId: string;
  split: SttBenchmarkSetSplit;
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
const sttBenchmarkCandidateModels = ["tiny", "base", "small"];

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

function getSttBenchmarkCandidates(config: SttConfig): BenchmarkCandidate[] {
  return sttBenchmarkCandidateModels.map((model) => ({
    stage: "stt",
    provider: config.engine,
    model,
    variant: `${config.device}-${config.computeType}-${config.language}`,
  }));
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

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}

async function appendEvent(event: Record<string, JsonValue>): Promise<void> {
  const dataRoot = getDataRoot();
  await mkdir(dataRoot, { recursive: true });
  await appendFile(getEventsPath(), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
  });
}

async function getLatestAudioSegment(): Promise<AudioSegmentRecord | null> {
  return getLatestAudioSegmentFromEvents(await readLocalEvents(getEventsPath()));
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

function calculateCharacterErrorRate(candidateTranscript: string, referenceTranscript: string): number {
  const candidate = normalizeForScoring(candidateTranscript);
  const reference = normalizeForScoring(referenceTranscript);

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate, reference) / reference.length;
}

function normalizeForScoring(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function calculateEditDistance(left: string, right: string): number {
  const previousRow = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const currentRow = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    currentRow[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      currentRow[rightIndex] = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previousRow[rightIndex] = currentRow[rightIndex];
    }
  }

  return previousRow[right.length];
}

async function runSttBenchmarkForAudioSegment(audioSegment: AudioSegmentRecord): Promise<SttBenchmarkResponse> {
  const audioPath = resolveDataRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found: ${audioSegment.audioRef}`);
  }

  const baseConfig = getSttConfig();
  const results: SttBenchmarkResult[] = [];
  const correction = getLatestSttCorrection(await readLocalEvents(getEventsPath()), audioSegment.sessionId, audioSegment.segmentId);

  for (const candidate of getSttBenchmarkCandidates(baseConfig)) {
    const config = {
      ...baseConfig,
      model: candidate.model,
    };
    const transcriptionStartedAt = Date.now();
    const sttResult = await transcribeWithPython(audioPath, config);
    const transcriptionDurationMs = Date.now() - transcriptionStartedAt;
    const result: SttBenchmarkResult = {
      sessionId: audioSegment.sessionId,
      segmentId: audioSegment.segmentId,
      audioRef: audioSegment.audioRef,
      candidate,
      stage: candidate.stage,
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant ?? null,
      sttEngine: sttResult.sttEngine,
      sttModel: sttResult.sttModel,
      sttLanguage: sttResult.sttLanguage,
      transcript: sttResult.transcript,
      audioDurationSeconds: sttResult.audioDurationSeconds,
      transcriptionDurationMs,
      score: correction
        ? {
            stage: "stt",
            metric: "cer",
            value: calculateCharacterErrorRate(sttResult.transcript, correction.correctedTranscript),
            referenceTranscript: correction.correctedTranscript,
            correctionCreatedAt: correction.correctionCreatedAt,
          }
        : null,
    };

    await appendEvent({
      event_type: "stt_benchmark_result",
      session_id: result.sessionId,
      segment_id: result.segmentId,
      created_at: new Date().toISOString(),
      audio_ref: result.audioRef,
      stage: result.stage,
      provider: result.provider,
      model: result.model,
      variant: result.variant,
      candidate: {
        stage: result.stage,
        provider: result.provider,
        model: result.model,
        variant: result.variant,
      },
      stt_engine: result.sttEngine,
      stt_model: result.sttModel,
      stt_language: result.sttLanguage,
      transcript: result.transcript,
      audio_duration_seconds: result.audioDurationSeconds,
      transcription_duration_ms: result.transcriptionDurationMs,
      score_metric: result.score?.metric ?? null,
      score_value: result.score?.value ?? null,
      score_reference_type: result.score ? "stt_correction" : null,
      score_reference_transcript: result.score?.referenceTranscript ?? null,
      score_reference_created_at: result.score?.correctionCreatedAt ?? null,
    });

    results.push(result);
  }

  return {
    source: audioSegment,
    results,
  };
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
      audioRef,
      sttEngine: sttResult.sttEngine,
      sttModel: sttResult.sttModel,
      sttLanguage: sttResult.sttLanguage,
      audioDurationSeconds: sttResult.audioDurationSeconds,
      transcriptionDurationMs,
    };
  },
);

ipcMain.handle("history:get-recent-segments", async (_event, limit?: number): Promise<ReconstructedSegment[]> => {
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
  return reconstructRecentSegments(await readLocalEvents(getEventsPath()), safeLimit);
});

ipcMain.handle("audio:get-segment", async (_event, audioSegment: AudioSegmentRecord): Promise<AudioSegmentPlayback> => {
  if (
    !audioSegment ||
    typeof audioSegment.sessionId !== "string" ||
    typeof audioSegment.segmentId !== "string" ||
    typeof audioSegment.audioRef !== "string"
  ) {
    throw new Error("Invalid audio segment");
  }

  const audioPath = resolveDataRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found: ${audioSegment.audioRef}`);
  }

  return {
    audioBytes: new Uint8Array(await readFile(audioPath)),
    mimeType: getAudioMimeType(audioSegment.audioRef),
  };
});

ipcMain.handle("corrections:save-stt", async (_event, correction: SttCorrectionRequest): Promise<SttCorrectionResponse> => {
  if (!correction.sessionId || !correction.segmentId) {
    throw new Error("Missing correction segment identity");
  }

  if (typeof correction.rawTranscript !== "string" || typeof correction.correctedTranscript !== "string") {
    throw new Error("Correction transcripts must be strings");
  }

  if (!isCorrectionKind(correction.correctionKind)) {
    throw new Error("Correction kind must be acoustic, math_transform, normalization, or rephrasing");
  }

  const createdAt = new Date().toISOString();
  const correctionMethod: "keyboard" = "keyboard";
  const correctionKind = correction.correctionKind;

  await appendEvent({
    event_type: "stt_correction",
    created_at: createdAt,
    session_id: correction.sessionId,
    segment_id: correction.segmentId,
    audio_ref: correction.audioRef,
    raw_transcript: correction.rawTranscript,
    corrected_transcript: correction.correctedTranscript,
    correction_method: correctionMethod,
    correction_kind: correctionKind,
  });

  return {
    createdAt,
    sessionId: correction.sessionId,
    segmentId: correction.segmentId,
    correctionKind,
    correctionMethod,
  };
});

ipcMain.handle(
  "benchmark-set:mark-stt",
  async (_event, membership: SttBenchmarkSetMembershipRequest): Promise<SttBenchmarkSetMembershipResponse> => {
    if (!membership || typeof membership.sessionId !== "string" || typeof membership.segmentId !== "string") {
      throw new Error("Missing benchmark set segment identity");
    }

    if (membership.audioRef !== null && typeof membership.audioRef !== "string") {
      throw new Error("Invalid benchmark set audio reference");
    }

    if (!isSttBenchmarkSetSplit(membership.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const latestCorrection = getLatestSttCorrection(
      await readLocalEvents(getEventsPath()),
      membership.sessionId,
      membership.segmentId,
    );
    if (!latestCorrection) {
      throw new Error("Correct the transcript before adding it to an STT benchmark set");
    }

    const createdAt = new Date().toISOString();

    await appendEvent({
      event_type: "stt_benchmark_set_membership",
      created_at: createdAt,
      session_id: membership.sessionId,
      segment_id: membership.segmentId,
      audio_ref: membership.audioRef,
      split: membership.split,
      reason: "manual",
    });

    return {
      createdAt,
      sessionId: membership.sessionId,
      segmentId: membership.segmentId,
      split: membership.split,
    };
  },
);

ipcMain.handle("benchmark:run-latest-stt", async (): Promise<SttBenchmarkResponse> => {
  const latestAudioSegment = await getLatestAudioSegment();
  if (!latestAudioSegment) {
    throw new Error("No stored audio segment found");
  }

  return runSttBenchmarkForAudioSegment(latestAudioSegment);
});

ipcMain.handle("benchmark:run-segment-stt", async (_event, audioSegment: AudioSegmentRecord): Promise<SttBenchmarkResponse> => {
  if (
    !audioSegment ||
    typeof audioSegment.sessionId !== "string" ||
    typeof audioSegment.segmentId !== "string" ||
    typeof audioSegment.audioRef !== "string"
  ) {
    throw new Error("Invalid benchmark segment");
  }

  return runSttBenchmarkForAudioSegment(audioSegment);
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
