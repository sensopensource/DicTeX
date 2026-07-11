import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RULES,
  normalizeTranscript,
  readLocalEvents,
  reconstructRecentSegments,
  transcribeWithPython,
  type ReconstructedSegment,
  type SttConfig,
} from "@dictex/shared";
import { prepareNormalization } from "./normalizationPolicy.js";
import { readAppSettings, writeAppSettings } from "./settings.js";

type TranscriptionResult = {
  /** Raw STT output. Kept as the correction base; `stt_result.stt_output` mirrors it. */
  transcript: string;
  /** Inserted text — normalized when enabled, raw otherwise. */
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

type AudioSegmentRecord = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
};

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

type OpenLabResult = {
  ok: boolean;
  error?: string;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built main output lives at `<repoRoot>/apps/dictex/out/main`, so four levels
// up from `__dirname` (main -> out -> dictex -> apps -> repoRoot) is the real
// monorepo root. The Python engine now lives under `packages/engine`, and the
// dictation venv stays at the repo root (`<repoRoot>/.venv`), so this must
// resolve to the true repo root or both the engine and the venv lookup break.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const enginePath = path.join(repoRoot, "packages", "engine", "transcribe.py");
const sessionId = `session_${new Date().toISOString().replace(/\D/g, "")}`;
const globalHotkey = "Super+Alt+Space";
// The minimum models always offered in the UI selector. `large-v3-turbo` is the
// current dictation model on GPU (see docs/development.md "GPU (CUDA) STT").
const defaultSttModels = ["tiny", "base", "small", "large-v3-turbo"];

let mainWindow: BrowserWindow | null = null;
let globalHotkeyRegistered = false;
let segmentCounter = 0;
// STT model chosen from the UI and persisted in settings.json. Null means "no UI
// choice", so the env var / default applies. Loaded at startup before the window.
let activeSttModelOverride: string | null = null;
// The normalizer is enabled by default for settings written before #105. The UI
// persists an explicit boolean and changes apply to subsequent dictations.
let activeNormalizerEnabled = true;

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
 * Models offered in the UI selector: the minimum core set, plus any extras from
 * DICTEX_STT_BENCHMARK_MODELS (optional power-user list), plus the active model
 * so it is always selectable. Benchmark itself lives in DicTeX Lab (#76/#77).
 */
function getAvailableSttModels(): string[] {
  const models: string[] = [];
  const add = (model: string): void => {
    if (model && !models.includes(model)) {
      models.push(model);
    }
  };

  defaultSttModels.forEach(add);

  const envValue = process.env.DICTEX_STT_BENCHMARK_MODELS;
  if (envValue) {
    envValue
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
      .forEach(add);
  }

  add(getSttModel());
  return models;
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
 * Load persisted settings at startup and apply the saved STT model and
 * normalizer state. Malformed settings degrade to defaults with a quiet console
 * diagnostic; they never block startup or dictation.
 */
async function loadPersistedSettings(): Promise<void> {
  const { settings, diagnostics } = await readAppSettings(getSettingsPath());
  activeSttModelOverride = settings.sttModel;
  activeNormalizerEnabled = settings.normalizerEnabled;
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
      'Ordered regex rules applied after the personal dictionary. "pattern" is a Unicode-aware JS regex source (matched with forced "g"/"u" flags plus any "flags" given here); "replacement" may reference capture groups via $1, $2, ... or $<name>, $<name>... for named groups, and a literal "$" is written as "$$" (needed to emit the "$…$" inline-math delimiters DicTeX Lab expects). A pattern that does not match leaves the text untouched.',
    rules: DEFAULT_RULES,
  },
  null,
  2,
)}\n`;

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

/**
 * Launch DicTeX Lab as a separate process. DicTeX never imports Lab code —
 * process spawn only (pivot Phase 3). Prefer a built Lab entry; fall back to
 * `npm run dev:lab` from the monorepo root. Failures return a message, never throw.
 *
 * A build is only usable if BOTH `out/main` and `out/renderer` exist. A partial
 * build (e.g. interrupted `electron-vite build`) can leave `out/main/index.js`
 * present without `out/renderer/index.html`; launching that main process opens
 * a window with nothing to load, i.e. a blank/frozen window. Require the
 * renderer too, and fall back to the dev path (or the "build the Lab first"
 * error) rather than ever launching a rendererless window.
 */
function openLabApp(): OpenLabResult {
  const labAppDir = path.join(repoRoot, "apps", "lab");
  const labMain = path.join(labAppDir, "out", "main", "index.js");
  const labRendererHtml = path.join(labAppDir, "out", "renderer", "index.html");
  const npmHelper =
    process.platform === "win32"
      ? path.join(repoRoot, "scripts", "npm.cmd")
      : path.join(repoRoot, "scripts", "npm.sh");

  if (existsSync(labMain) && existsSync(labRendererHtml)) {
    try {
      const child = spawn(process.execPath, [labMain], {
        cwd: labAppDir,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          // Ensure Electron treats this as an app entry, not a Node script.
          ELECTRON_RUN_AS_NODE: undefined,
          // Built Lab loads its own renderer from disk; do not inherit DicTeX's
          // electron-vite dev server URL.
          ELECTRON_RENDERER_URL: undefined,
        },
      });
      child.unref();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not launch built DicTeX Lab",
      };
    }
  }

  if (!existsSync(npmHelper)) {
    return {
      ok: false,
      error:
        "DicTeX Lab is not built and the monorepo npm helper was not found. From the repo root run: scripts\\npm.cmd run build (or scripts\\npm.cmd run dev:lab).",
    };
  }

  try {
    const child = spawn(npmHelper, ["run", "dev:lab"], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        // Keep Node TLS helper if the machine needs it; do not force DicTeX's
        // renderer URL onto the Lab dev server.
        ELECTRON_RENDERER_URL: undefined,
      },
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not start DicTeX Lab. Build or start it first: scripts\\npm.cmd run build / dev:lab.",
    };
  }
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
    // Freeze the setting for this run. UI changes are disabled while recording
    // or transcribing, and this also makes direct IPC calls deterministic.
    const normalizerEnabledForRun = activeNormalizerEnabled;
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
    const sttResult = await transcribeWithPython(enginePath, repoRoot, audioPath, getSttConfig());
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

    // The raw stt_result above stays untouched. The policy either runs the full
    // pipeline or keeps the STT output byte-identical, then returns the explicit
    // normalization_result payload for this segment.
    const preparedNormalization = await prepareNormalization(
      sttResult.transcript,
      normalizerEnabledForRun,
      () =>
        normalizeTranscript(sttResult.transcript, {
          dictionaryPath: getDictionaryPath(),
          rulesPath: getRulesPath(),
        }),
    );

    await appendEvent({
      event_type: "normalization_result",
      session_id: sessionId,
      segment_id: segmentId,
      created_at: new Date().toISOString(),
      audio_ref: audioRef,
      input_transcript: preparedNormalization.inputTranscript,
      output_transcript: preparedNormalization.outputTranscript,
      ...preparedNormalization.eventState,
      layers: preparedNormalization.layers,
      diagnostics: preparedNormalization.normalizationDiagnostics,
    });

    const { insertedTranscript, normalizationApplied, normalizationDiagnostics } = preparedNormalization;

    clipboard.writeText(insertedTranscript);
    const pastedToActiveApp =
      options.autoPaste === true && insertedTranscript.trim().length > 0
        ? await pasteClipboardIntoActiveApp()
        : false;

    return {
      transcript: sttResult.transcript,
      normalizedTranscript: insertedTranscript,
      normalizationApplied,
      normalizationDiagnostics,
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

ipcMain.handle("app:open-lab", (): OpenLabResult => openLabApp());

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

ipcMain.handle("diagnostics:get-stt-models", (): string[] => getAvailableSttModels());

ipcMain.handle("settings:get-normalizer-enabled", (): boolean => activeNormalizerEnabled);

ipcMain.handle("settings:set-stt-model", async (_event, model: unknown): Promise<SttConfig> => {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("STT model must be a non-empty string");
  }

  const nextModel = model.trim();
  activeSttModelOverride = nextModel;
  // Persist so the choice survives a restart. Applies only to subsequent
  // dictations; any in-flight transcription already captured its own config.
  await writeAppSettings(getSettingsPath(), {
    sttModel: nextModel,
    normalizerEnabled: activeNormalizerEnabled,
  });

  return getSttConfig();
});

ipcMain.handle("settings:set-normalizer-enabled", async (_event, enabled: unknown): Promise<boolean> => {
  if (typeof enabled !== "boolean") {
    throw new Error("Normalizer enabled state must be a boolean");
  }

  const previousValue = activeNormalizerEnabled;
  activeNormalizerEnabled = enabled;
  try {
    await writeAppSettings(getSettingsPath(), {
      sttModel: activeSttModelOverride,
      normalizerEnabled: activeNormalizerEnabled,
    });
  } catch (error) {
    activeNormalizerEnabled = previousValue;
    throw error;
  }

  return activeNormalizerEnabled;
});

app.whenReady().then(async () => {
  // Apply persisted settings before the window loads its controls.
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
