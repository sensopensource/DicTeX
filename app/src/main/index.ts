import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLatestAudioSegment as getLatestAudioSegmentFromEvents,
  getLatestSttCandidateSelection,
  getLatestSttCorrection,
  getSttBenchmarkSetSegments,
  isCorrectionKind,
  readLocalEvents,
  reconstructRecentSegments,
  type BenchmarkCandidateIdentity,
  type CorrectionKind,
  type LocalEvent,
  type ReconstructedSegment,
  type SttBenchmarkSetSplit,
} from "./localEvents.js";
import { calculateCharacterErrorRate } from "./sttScoring.js";
import { summarizeSttBenchmarkResultsByCandidate, type SttBenchmarkCandidateSummaryResponse } from "./benchmarkSummary.js";
import { readAppSettings, writeAppSettings } from "./settings.js";
import { normalizeTranscript, DEFAULT_RULES, type NormalizationResult } from "./normalizer.js";

type TranscriptionResult = {
  /** Raw STT output. Kept as the correction base; `stt_result.stt_output` mirrors it. */
  transcript: string;
  /** Normalized text — this is what was copied to the clipboard / pasted. */
  normalizedTranscript: string;
  /** True when normalization changed the text (normalized differs from raw). */
  normalizationApplied: boolean;
  /** Quiet diagnostics from the normalizer (e.g. malformed dictionary). */
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
  /** Quiet notes for candidates skipped at runtime (e.g. an optional provider
   * whose deps/model files are absent). Empty when every candidate ran. */
  diagnostics: string[];
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

type SttCandidateSelectionRequest = {
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

type SttCandidateSelectionResponse = {
  createdAt: string;
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string;
};

type SttBenchmarkSetRunRequest = {
  split: SttBenchmarkSetSplit;
  models?: string[];
};

type SttBenchmarkSetSegmentOutcome = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  status: "done" | "failed";
  error: string | null;
  results: SttBenchmarkResult[];
};

type SttBenchmarkSetRunResponse = {
  split: SttBenchmarkSetSplit;
  total: number;
  done: number;
  failed: number;
  outcomes: SttBenchmarkSetSegmentOutcome[];
};

type SttBenchmarkSetProgress = {
  split: SttBenchmarkSetSplit;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  current: { sessionId: string; segmentId: string } | null;
  lastOutcome: {
    sessionId: string;
    segmentId: string;
    status: "done" | "failed";
    error: string | null;
    resultCount: number;
  } | null;
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

/**
 * Thrown when a benchmark provider's dependencies or local model files are
 * absent. The sidecar reports this as an `{"available": false}` result; the
 * benchmark loop catches it to skip the candidate with a quiet diagnostic
 * instead of failing the segment. Never raised on the faster-whisper dictation
 * path, whose dependency is required.
 */
class ProviderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProviderUnavailableError";
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const enginePath = path.join(repoRoot, "engine", "transcribe.py");
const sessionId = `session_${new Date().toISOString().replace(/\D/g, "")}`;
const globalHotkey = "Super+Alt+Space";
const defaultSttBenchmarkModels = ["tiny", "base", "small"];
// The minimum models always offered in the UI selector. `large-v3-turbo` is the
// current dictation model on GPU (see docs/development.md "GPU (CUDA) STT").
const defaultSttModels = ["tiny", "base", "small", "large-v3-turbo"];
// faster-whisper is the dictation engine and default benchmark provider; Vosk is
// the second, benchmark-only provider (see docs/product-decisions.md). Provider
// names match the Python sidecar registry and the candidate identity.
const fasterWhisperProvider = "faster-whisper";
const voskProvider = "vosk";
// Vosk benchmark candidate model(s). A candidate is always registered so the
// provider appears in the benchmark universe; it is skipped at runtime with a
// quiet diagnostic when vosk or its model files are absent.
const defaultVoskBenchmarkModels = ["vosk-model-small-fr-0.22"];

let mainWindow: BrowserWindow | null = null;
let globalHotkeyRegistered = false;
let segmentCounter = 0;
// STT model chosen from the UI and persisted in settings.json. Null means "no UI
// choice", so the env var / default applies. Loaded at startup before the window.
let activeSttModelOverride: string | null = null;

function getSttModel(): string {
  // Precedence: saved UI choice > DICTEX_STT_MODEL env var > built-in default.
  return activeSttModelOverride || process.env.DICTEX_STT_MODEL || "base";
}

function getSttConfig(): SttConfig {
  return {
    engine: "faster-whisper",
    model: getSttModel(),
    language: process.env.DICTEX_STT_LANGUAGE || "fr",
    device: process.env.DICTEX_STT_DEVICE || "cpu",
    computeType: process.env.DICTEX_STT_COMPUTE_TYPE || "int8",
  };
}

/**
 * Models offered in the UI selector: the minimum core set, plus the benchmark
 * candidate universe (from DICTEX_STT_BENCHMARK_MODELS when set) so dictation and
 * benchmark stay consistent, plus the active model so it is always selectable.
 */
function getAvailableSttModels(): string[] {
  const models: string[] = [];
  const add = (model: string): void => {
    if (model && !models.includes(model)) {
      models.push(model);
    }
  };

  defaultSttModels.forEach(add);
  getSttBenchmarkModels().forEach(add);
  add(getSttModel());

  return models;
}

function getSttBenchmarkModels(): string[] {
  const envValue = process.env.DICTEX_STT_BENCHMARK_MODELS;
  if (!envValue) {
    return defaultSttBenchmarkModels;
  }

  const parsed = envValue
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  const unique = Array.from(new Set(parsed));

  return unique.length > 0 ? unique : defaultSttBenchmarkModels;
}

function getVoskBenchmarkModels(): string[] {
  const envValue = process.env.DICTEX_VOSK_BENCHMARK_MODELS;
  if (envValue === undefined) {
    return defaultVoskBenchmarkModels;
  }

  const parsed = envValue
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  // An explicitly empty value disables Vosk candidates entirely; a set value
  // replaces the default list.
  return Array.from(new Set(parsed));
}

function getSttBenchmarkCandidates(config: SttConfig): BenchmarkCandidate[] {
  const fasterWhisper: BenchmarkCandidate[] = getSttBenchmarkModels().map((model) => ({
    stage: "stt",
    provider: fasterWhisperProvider,
    model,
    variant: `${config.device}-${config.computeType}-${config.language}`,
  }));

  // Vosk is CPU-only and has no compute-type dimension, so its variant only
  // carries the device and language to keep the candidate identity meaningful.
  const vosk: BenchmarkCandidate[] = getVoskBenchmarkModels().map((model) => ({
    stage: "stt",
    provider: voskProvider,
    model,
    variant: `cpu-${config.language}`,
  }));

  return [...fasterWhisper, ...vosk];
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

function sendBatchBenchmarkProgress(progress: SttBenchmarkSetProgress): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("benchmark:set-progress", progress);
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

function getNormalizerDir(): string {
  return path.join(getDataRoot(), "normalizer");
}

function getSettingsPath(): string {
  return path.join(getDataRoot(), "settings.json");
}

/**
 * Load persisted settings at startup and apply the saved STT model, if any.
 * Malformed settings degrade to defaults with a quiet console diagnostic; they
 * never block startup or dictation.
 */
async function loadPersistedSettings(): Promise<void> {
  const { settings, diagnostics } = await readAppSettings(getSettingsPath());
  activeSttModelOverride = settings.sttModel;
  for (const diagnostic of diagnostics) {
    console.warn(`[settings] ${diagnostic}`);
  }
}

function getDictionaryPath(): string {
  return path.join(getNormalizerDir(), "dictionary.json");
}

function getRulesPath(): string {
  return path.join(getNormalizerDir(), "rules.json");
}

// Seeded on first open. Empty `entries` keeps dictation byte-identical (empty by
// default); the ignored `_comment`/`_example` keys document the format in place.
const emptyDictionaryTemplate = `${JSON.stringify(
  {
    version: 1,
    _comment: "Literal, case-sensitive substring replacements applied in order. Add entries below.",
    _example: { from: "dic tex", to: "DicTeX" },
    entries: [],
  },
  null,
  2,
)}\n`;

// Seeded on first open with the shipped default rule set (unlike the empty
// dictionary template) so regex normalization is useful out of the box. Rules
// apply in file order; the ignored `_comment` key documents the format in place.
const defaultRulesTemplate = `${JSON.stringify(
  {
    version: 1,
    _comment:
      'Ordered regex rules applied after the personal dictionary. "pattern" is a Unicode-aware JS regex source (matched with forced "g"/"u" flags plus any "flags" given here); "replacement" may reference capture groups via $1, $2, .... A pattern that does not match leaves the text untouched.',
    rules: DEFAULT_RULES,
  },
  null,
  2,
)}\n`;

// Layer 1 of the normalization pipeline records each layer's output on the event
// so a wrong insertion can be attributed to a specific layer (see AGENTS.md).
function toNormalizationLayerRecords(normalization: NormalizationResult): JsonValue {
  return normalization.layers.map((layer) => ({
    layer: layer.layer,
    input: layer.input,
    output: layer.output,
    applied: layer.applied,
    diagnostics: layer.diagnostics,
  }));
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
        DICTEX_STT_PROVIDER: config.engine,
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
          available?: unknown;
          reason?: unknown;
          transcript?: unknown;
          stt_engine?: unknown;
          stt_model?: unknown;
          stt_language?: unknown;
          stt_duration?: unknown;
        };
        if (parsed.available === false) {
          // Optional provider with absent deps/model files. Signal the caller to
          // skip this candidate quietly rather than treating it as a failure.
          reject(
            new ProviderUnavailableError(
              typeof parsed.reason === "string" ? parsed.reason : "provider unavailable",
            ),
          );
          return;
        }
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

async function runSttBenchmarkForAudioSegment(
  audioSegment: AudioSegmentRecord,
  events?: LocalEvent[],
  modelFilter?: string[],
): Promise<SttBenchmarkResponse> {
  const audioPath = resolveDataRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found: ${audioSegment.audioRef}`);
  }

  const baseConfig = getSttConfig();
  const results: SttBenchmarkResult[] = [];
  const diagnostics: string[] = [];
  const loadedEvents = events ?? (await readLocalEvents(getEventsPath()));
  const correction = getLatestSttCorrection(loadedEvents, audioSegment.sessionId, audioSegment.segmentId);
  const candidates = modelFilter
    ? getSttBenchmarkCandidates(baseConfig).filter((candidate) => modelFilter.includes(candidate.model))
    : getSttBenchmarkCandidates(baseConfig);

  for (const candidate of candidates) {
    const config = {
      ...baseConfig,
      engine: candidate.provider,
      model: candidate.model,
    };
    const transcriptionStartedAt = Date.now();
    let sttResult: EngineTranscriptionResult;
    try {
      sttResult = await transcribeWithPython(audioPath, config);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        // Optional provider not installed / model files missing: skip it
        // quietly. No event is appended, so this candidate simply does not
        // appear in the results — never blocking faster-whisper candidates.
        const note = `${candidate.provider}/${candidate.model} unavailable: ${error.reason}`;
        console.warn(`[benchmark] ${note}`);
        diagnostics.push(note);
        continue;
      }
      throw error;
    }
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
    diagnostics,
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

    // Normalize the raw transcript before insertion. The raw stt_result above is
    // left untouched; the normalized output and every layer's output are recorded
    // in a separate append-only normalization_result event.
    const normalization = await normalizeTranscript(sttResult.transcript, {
      dictionaryPath: getDictionaryPath(),
      rulesPath: getRulesPath(),
    });

    await appendEvent({
      event_type: "normalization_result",
      session_id: sessionId,
      segment_id: segmentId,
      created_at: new Date().toISOString(),
      audio_ref: audioRef,
      input_transcript: normalization.input,
      output_transcript: normalization.output,
      passthrough: normalization.passthrough,
      layers: toNormalizationLayerRecords(normalization),
      diagnostics: normalization.diagnostics,
    });

    const insertedTranscript = normalization.output;
    clipboard.writeText(insertedTranscript);
    const pastedToActiveApp =
      options.autoPaste === true && insertedTranscript.trim().length > 0
        ? await pasteClipboardIntoActiveApp()
        : false;

    return {
      transcript: sttResult.transcript,
      normalizedTranscript: insertedTranscript,
      normalizationApplied: !normalization.passthrough,
      normalizationDiagnostics: normalization.diagnostics,
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

ipcMain.handle(
  "benchmark:run-set-stt",
  async (_event, request: SttBenchmarkSetRunRequest): Promise<SttBenchmarkSetRunResponse> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    let modelFilter: string[] | undefined;
    if (request.models !== undefined) {
      const availableModels = getSttBenchmarkModels();
      if (
        !Array.isArray(request.models) ||
        request.models.length < 1 ||
        request.models.length > 3 ||
        request.models.some((model) => typeof model !== "string" || !availableModels.includes(model))
      ) {
        throw new Error("Select 1 to 3 known STT benchmark candidates");
      }
      modelFilter = request.models;
    }

    const split = request.split;
    // Read the event log once so every segment scores against the same correction
    // snapshot and appended benchmark results cannot shift later lookups.
    const events = await readLocalEvents(getEventsPath());
    const segments = getSttBenchmarkSetSegments(events, split);
    const total = segments.length;

    let queued = total;
    let running = 0;
    let done = 0;
    let failed = 0;
    const outcomes: SttBenchmarkSetSegmentOutcome[] = [];

    sendBatchBenchmarkProgress({ split, total, queued, running, done, failed, current: null, lastOutcome: null });

    for (const segment of segments) {
      queued -= 1;
      running = 1;
      sendBatchBenchmarkProgress({
        split,
        total,
        queued,
        running,
        done,
        failed,
        current: { sessionId: segment.sessionId, segmentId: segment.segmentId },
        lastOutcome: null,
      });

      try {
        const response = await runSttBenchmarkForAudioSegment(
          { sessionId: segment.sessionId, segmentId: segment.segmentId, audioRef: segment.audioRef },
          events,
          modelFilter,
        );
        running = 0;
        done += 1;
        outcomes.push({
          sessionId: segment.sessionId,
          segmentId: segment.segmentId,
          audioRef: segment.audioRef,
          status: "done",
          error: null,
          results: response.results,
        });
        sendBatchBenchmarkProgress({
          split,
          total,
          queued,
          running,
          done,
          failed,
          current: null,
          lastOutcome: {
            sessionId: segment.sessionId,
            segmentId: segment.segmentId,
            status: "done",
            error: null,
            resultCount: response.results.length,
          },
        });
      } catch (error) {
        running = 0;
        failed += 1;
        const message = error instanceof Error ? error.message : "Benchmark failed";
        outcomes.push({
          sessionId: segment.sessionId,
          segmentId: segment.segmentId,
          audioRef: segment.audioRef,
          status: "failed",
          error: message,
          results: [],
        });
        sendBatchBenchmarkProgress({
          split,
          total,
          queued,
          running,
          done,
          failed,
          current: null,
          lastOutcome: {
            sessionId: segment.sessionId,
            segmentId: segment.segmentId,
            status: "failed",
            error: message,
            resultCount: 0,
          },
        });
      }
    }

    return { split, total, done, failed, outcomes };
  },
);

ipcMain.handle(
  "benchmark-set:summarize-stt",
  async (_event, request: SttBenchmarkSetRunRequest): Promise<SttBenchmarkCandidateSummaryResponse> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const events = await readLocalEvents(getEventsPath());
    return summarizeSttBenchmarkResultsByCandidate(events, request.split);
  },
);

ipcMain.handle(
  "candidate-selection:save-stt",
  async (_event, request: SttCandidateSelectionRequest): Promise<SttCandidateSelectionResponse> => {
    const candidate = request?.candidate;
    if (
      !candidate ||
      typeof candidate.stage !== "string" ||
      typeof candidate.provider !== "string" ||
      typeof candidate.model !== "string" ||
      (candidate.variant !== null && typeof candidate.variant !== "undefined" && typeof candidate.variant !== "string")
    ) {
      throw new Error("Invalid STT candidate identity");
    }

    if (typeof request.selectionReason !== "string" || request.selectionReason.trim() === "") {
      throw new Error("Selection reason is required");
    }

    const createdAt = new Date().toISOString();
    const selectionReason = request.selectionReason.trim();
    const variant = candidate.variant ?? null;

    await appendEvent({
      event_type: "stt_candidate_selection",
      created_at: createdAt,
      stage: candidate.stage,
      provider: candidate.provider,
      model: candidate.model,
      variant,
      selection_reason: selectionReason,
    });

    return {
      createdAt,
      candidate: { stage: candidate.stage, provider: candidate.provider, model: candidate.model, variant },
      selectionReason,
    };
  },
);

ipcMain.handle("candidate-selection:get-latest-stt", async (): Promise<SttCandidateSelectionResponse | null> => {
  const events = await readLocalEvents(getEventsPath());
  const selection = getLatestSttCandidateSelection(events);
  if (!selection) {
    return null;
  }

  return {
    createdAt: selection.createdAt ?? "",
    candidate: selection.candidate,
    selectionReason: selection.selectionReason ?? "",
  };
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

ipcMain.handle("diagnostics:open-dictionary", async (): Promise<boolean> => {
  const normalizerDir = getNormalizerDir();
  await mkdir(normalizerDir, { recursive: true });
  const dictionaryPath = getDictionaryPath();
  if (!existsSync(dictionaryPath)) {
    // Seed a self-documenting starter file so the user can edit rather than guess
    // the format. The example entry is inert unless the user says "dic tex".
    await writeFile(dictionaryPath, emptyDictionaryTemplate, { encoding: "utf8" });
  }
  const error = await shell.openPath(dictionaryPath);
  return error.length === 0;
});

ipcMain.handle("diagnostics:open-rules", async (): Promise<boolean> => {
  const normalizerDir = getNormalizerDir();
  await mkdir(normalizerDir, { recursive: true });
  const rulesPath = getRulesPath();
  if (!existsSync(rulesPath)) {
    // Seed with the shipped default rule set, not an empty file, so the layer
    // is useful out of the box and the user can see/edit the starter rules.
    await writeFile(rulesPath, defaultRulesTemplate, { encoding: "utf8" });
  }
  const error = await shell.openPath(rulesPath);
  return error.length === 0;
});

ipcMain.handle("diagnostics:get-stt-config", (): SttConfig => getSttConfig());

ipcMain.handle("diagnostics:get-stt-benchmark-models", (): string[] => getSttBenchmarkModels());

ipcMain.handle("diagnostics:get-stt-models", (): string[] => getAvailableSttModels());

ipcMain.handle("settings:set-stt-model", async (_event, model: unknown): Promise<SttConfig> => {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("STT model must be a non-empty string");
  }

  const nextModel = model.trim();
  activeSttModelOverride = nextModel;
  // Persist so the choice survives a restart. Applies only to subsequent
  // dictations; any in-flight transcription already captured its own config.
  await writeAppSettings(getSettingsPath(), { sttModel: nextModel });

  return getSttConfig();
});

app.whenReady().then(async () => {
  // Apply the persisted STT model before the window loads its config.
  await loadPersistedSettings();
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
