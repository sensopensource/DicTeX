import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RULES_CONFIG_VERSION,
  PERSONAL_RULES_OVERLAY_FILENAME,
  PERSONAL_RULES_OVERLAY_VERSION,
  normalizeTranscript,
  readLocalEvents,
  reconstructRecentSegments,
  type ReconstructedSegment,
  type SttConfig,
} from "@dictex/shared";
import { readAppSettings, writeAppSettings } from "./settings.js";
import { runDictationTranscription, type JsonValue, type TranscriptionResult } from "./dictationFlow.js";
import { createSttWorkerClient, type ResolvedWorkerConfig } from "./sttWorkerClient.js";
import { SttWorkerManager, type SttWorkerStatus } from "./sttWorkerManager.js";
import { OverlayPresenter, sanitizeHomeOverlayState } from "./overlayPresenter.js";
import { createOverlayWindow, sendOverlayView, setInteractive } from "./overlayWindow.js";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built main output lives at `<repoRoot>/apps/dictex/out/main`, so four levels
// up from `__dirname` (main -> out -> dictex -> apps -> repoRoot) is the real
// monorepo root. The Python engine now lives under `packages/engine`, and the
// dictation venv stays at the repo root (`<repoRoot>/.venv`), so this must
// resolve to the true repo root or both the engine and the venv lookup break.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
// The persistent worker (#114) replaces the per-dictation one-shot for DicTeX.
// The Lab keeps using `transcribe.py` via `transcribeWithPython` (out of scope).
const workerPath = path.join(repoRoot, "packages", "engine", "worker.py");
const sessionId = `session_${new Date().toISOString().replace(/\D/g, "")}`;
const globalHotkey = "Super+Alt+Space";
// The minimum models always offered in the UI selector. `large-v3-turbo` is the
// current dictation model on GPU (see docs/development.md "GPU (CUDA) STT").
const defaultSttModels = ["tiny", "base", "small", "large-v3-turbo"];

let mainWindow: BrowserWindow | null = null;
// The floating HUD (#166). Always optional: every use is guarded, so a HUD that
// failed to open can never interrupt a dictation.
let overlayWindow: BrowserWindow | null = null;
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

/** The worker generation the current settings ask for (dictation uses no prompt
 * variant — that is #94, out of scope). */
function getWorkerConfig(): ResolvedWorkerConfig {
  const config = getSttConfig();
  return {
    provider: config.engine,
    model: config.model,
    language: config.language,
    device: config.device,
    computeType: config.computeType,
  };
}

// Merges the HUD's two state owners and drives what it shows. Home publishes the
// dictation status it owns; the worker state and the normalizer setting are fed
// in below from the main process, which already owns them.
const overlayPresenter = new OverlayPresenter({
  emit: (view) => sendOverlayView(overlayWindow, view),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

// One persistent worker for dictation, kept warm across dictations. Changing the
// STT model lazily restarts it on the next dictation (stop old, start new) so a
// single model stays resident.
const sttWorkerManager = new SttWorkerManager({
  createClient: (config) =>
    createSttWorkerClient(config, {
      repoRoot,
      workerPath,
      log: (message) => console.warn(message),
    }),
  log: (message) => console.warn(message),
  shutdownTimeoutMs: 4000,
  onStatusChange: (status) => {
    sendSttWorkerStatus(status);
    // The HUD reads the same lifecycle Home does; it is not a second source.
    overlayPresenter.setWorkerState(status.state);
  },
  onGenerationReady: async (generation) => {
    await appendEvent({
      event_type: "stt_engine_ready",
      created_at: new Date().toISOString(),
      worker_generation: generation.workerGeneration,
      stt_engine: generation.sttEngine,
      stt_model: generation.sttModel,
      stt_device: generation.sttDevice,
      stt_compute_type: generation.sttComputeType,
      worker_startup_ms: generation.workerStartupMs,
      model_load_ms: generation.modelLoadMs,
    });
  },
});

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
      // Dictation happens while this window is occluded by the notebook, which
      // is exactly when Chromium throttles a hidden page's timers to ~1 Hz. That
      // would stall the HUD's live level (#166) precisely when it is the only
      // thing the user can see. The window stays a small utility surface, so the
      // cost of not throttling it is negligible.
      backgroundThrottling: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    sendHotkeyStatus();
    sendSttWorkerStatus(sttWorkerManager.getStatus());
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // The HUD is not an application of its own: with Home gone there is no
    // dictation left to reflect, and an overlay still open would keep
    // `window-all-closed` from ever firing, leaving DicTeX running invisibly.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  });

  return mainWindow;
}

/**
 * Open the floating HUD (#166). Additive and best-effort: it is created after the
 * main window, it only ever draws states that already exist, and a failure is
 * logged and swallowed — DicTeX must keep dictating with no overlay at all.
 */
function createOverlay(): void {
  try {
    overlayWindow = createOverlayWindow({
      preloadPath: path.join(__dirname, "../preload/overlay.mjs"),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererFile: path.join(__dirname, "../renderer/overlay.html"),
      // A freshly loaded window has no history, so send it the current view.
      onReady: () => overlayPresenter.resend(),
    });

    overlayWindow.on("closed", () => {
      overlayWindow = null;
    });
  } catch (error) {
    overlayWindow = null;
    console.warn(`[overlay] could not open the HUD: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function sendSttWorkerStatus(status: SttWorkerStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("stt-worker:status", status);
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
  overlayPresenter.setNormalizerEnabled(activeNormalizerEnabled);
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

function getRulesOverlayPath(): string {
  return path.join(getNormalizerDir(), PERSONAL_RULES_OVERLAY_FILENAME);
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

const emptyRulesOverlayTemplate = `${JSON.stringify(
  {
    version: PERSONAL_RULES_OVERLAY_VERSION,
    bundled_rules_version: DEFAULT_RULES_CONFIG_VERSION,
    _comment:
      "Personal overlay over the versioned bundled rules. Disable or replace a bundled rule by its stable id; personal rules run afterwards in numeric order.",
    disabled_rule_ids: [],
    replacements: [],
    personal_rules: [],
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
    // Freeze the settings for this run. UI changes are disabled while recording
    // or transcribing, and this also makes direct IPC calls deterministic: the
    // model captured here is the worker generation this dictation transcribes on.
    const normalizerEnabledForRun = activeNormalizerEnabled;
    const workerConfig = getWorkerConfig();
    const dataRoot = getDataRoot();

    return runDictationTranscription(
      {
        now: () => Date.now(),
        isoNow: () => new Date().toISOString(),
        storeAudio: async (segment, mime, bytes) => {
          const audioDir = path.join(dataRoot, "audio", sessionId);
          await mkdir(audioDir, { recursive: true });
          const audioPath = path.join(audioDir, `${segment}.${getAudioExtension(mime)}`);
          await writeFile(audioPath, Buffer.from(bytes));
          return { audioPath, audioRef: toPortableRef(dataRoot, audioPath) };
        },
        appendEvent,
        // The manager owns the persistent worker, sequential queueing, the
        // config-change restart, and the bounded crash restart+replay. The
        // Normalizer setting never restarts it: only the model/device/compute
        // type does. On a second failure this rejects, and the flow leaves the
        // audio and its audio_segment on disk for manual retry.
        transcribe: (audioPath) =>
          sttWorkerManager.transcribe(workerConfig, {
            audioPath,
            language: workerConfig.language,
            promptVariant: workerConfig.promptVariant,
          }),
        normalize: (rawTranscript) =>
          normalizeTranscript(rawTranscript, {
            dictionaryPath: getDictionaryPath(),
            rulesPath: getRulesPath(),
            rulesOverlayPath: getRulesOverlayPath(),
          }),
        writeClipboard: (text) => clipboard.writeText(text),
        pasteActiveApp: pasteClipboardIntoActiveApp,
      },
      {
        sessionId,
        segmentId,
        createdAt,
        mimeType,
        audioBytes,
        normalizerEnabled: normalizerEnabledForRun,
        autoPaste: options.autoPaste === true,
      },
    );
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

// Home publishes the overlay states it owns (#166). `on`, not `handle`: nothing
// is returned and Home never awaits the HUD. A payload that cannot be trusted is
// dropped rather than allowed to throw in the main process.
ipcMain.on("overlay:publish", (_event, state: unknown) => {
  const sanitized = sanitizeHomeOverlayState(state);
  if (sanitized) {
    overlayPresenter.updateFromHome(sanitized);
  }
});

// The HUD asks for click-through to be lifted while the pointer is genuinely
// over its one interactive control, and restored as soon as it leaves.
ipcMain.on("overlay:set-interactive", (_event, interactive: unknown) => {
  if (overlayWindow && typeof interactive === "boolean") {
    setInteractive(overlayWindow, interactive);
  }
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
  const overlayPath = getRulesOverlayPath();
  if (!existsSync(overlayPath) && existsSync(getRulesPath())) {
    // A legacy monolithic file must be reviewed in the Lab before an overlay
    // activates. Opening settings never performs that migration implicitly.
    const error = await shell.openPath(normalizerDir);
    return error.length === 0;
  }
  if (!existsSync(overlayPath)) {
    await writeFile(overlayPath, emptyRulesOverlayTemplate, { encoding: "utf8" });
  }
  const error = await shell.openPath(overlayPath);
  return error.length === 0;
});

ipcMain.handle("diagnostics:get-stt-config", (): SttConfig => getSttConfig());

ipcMain.handle("diagnostics:get-stt-models", (): string[] => getAvailableSttModels());

ipcMain.handle("diagnostics:get-stt-worker-status", (): SttWorkerStatus => sttWorkerManager.getStatus());

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

  overlayPresenter.setNormalizerEnabled(activeNormalizerEnabled);
  return activeNormalizerEnabled;
});

app.whenReady().then(async () => {
  // Apply persisted settings before the window loads its controls.
  await loadPersistedSettings();
  createWindow();
  createOverlay();
  registerGlobalHotkey();
  // Open the window normally, then warm the worker asynchronously so the first
  // dictation does not pay the model load. A dictation that finishes before the
  // worker is ready simply waits for it (no lost audio, no one-shot fallback).
  sttWorkerManager.prewarm(getWorkerConfig());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createOverlay();
      sendHotkeyStatus();
    }
  });
});

// Ask the worker to stop, then force-kill it after a bounded delay, before the
// app exits — so a model is never left resident. `preventDefault` lets the
// bounded async shutdown finish; the guard makes the re-quit a no-op.
let workerDisposeStarted = false;
app.on("before-quit", (event) => {
  if (workerDisposeStarted) {
    return;
  }
  workerDisposeStarted = true;
  event.preventDefault();
  overlayPresenter.dispose();
  void sttWorkerManager.dispose().finally(() => {
    app.quit();
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
