import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
  calculateCharacterErrorRate,
  summarizeSttBenchmarkResultsByCandidate,
  buildSttDatasetExport,
  transcribeWithPython,
  ProviderUnavailableError,
  getSttBenchmarkModels,
  type AudioSegmentRecord,
  type LocalEvent,
  type ReconstructedSegment,
  type SttBenchmarkSetSplit,
  type SttBenchmarkCandidateSummaryResponse,
  type SttDatasetExport,
  type SttDatasetRecord,
  type SttConfig,
  type EngineTranscriptionResult,
  type BenchmarkCandidate,
  type SttBenchmarkResult,
  type SttBenchmarkResponse,
  type SttCorrectionRequest,
  type SttCorrectionResponse,
  type SttBenchmarkSetMembershipRequest,
  type SttBenchmarkSetMembershipResponse,
  type SttCandidateSelectionRequest,
  type SttCandidateSelectionResponse,
  type SttBenchmarkSetRunRequest,
  type SttBenchmarkSetSegmentOutcome,
  type SttBenchmarkSetRunResponse,
  type SttBenchmarkSetProgress,
  type SttDatasetExportFileSummary,
  type SttDatasetExportSplitSummary,
  type SttDatasetExportSummary,
} from "@dictex/shared";
import { readLabSettings, writeLabSettings } from "./settings.js";
import {
  planDatasetBuilderSave,
  type DatasetBuilderSaveRequest,
  type DatasetBuilderSaveResponse,
} from "./datasetBuilder.js";

/**
 * DicTeX Lab main process (pivot Phase 2, issue #76). No microphone, no
 * hotkey, no clipboard/paste, no normalizer: the Lab only benchmarks,
 * corrects, splits, selects candidates, and exports datasets, reading
 * DicTeX's data folder READ-ONLY and keeping its OWN store for everything it
 * writes. See pivot_dictex_lab_split.md and AGENTS.md "Current Direction".
 *
 * Read-only contract: every `readFile`/`existsSync` against the source data
 * folder is a read; every `writeFile`/`appendFile`/`mkdir` in this file
 * targets a path under `getOwnDataRoot()`, never `getSourceDataRoot()`.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type AudioSegmentPlayback = {
  audioBytes: Uint8Array;
  mimeType: string;
};

type DataFolderStatus = {
  path: string;
  isDefault: boolean;
};

type SourceFolderCheck = {
  exists: boolean;
  eventsFound: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built main output lives at `<repoRoot>/apps/lab/out/main`, so four levels up
// (main -> out -> lab -> apps -> repoRoot) is the monorepo root — the same
// depth as apps/dictex, since both apps live one level under apps/.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const enginePath = path.join(repoRoot, "packages", "engine", "transcribe.py");

// faster-whisper is the benchmark provider shared with dictation; Vosk is the
// second, benchmark-only provider (see docs/product-decisions.md). Provider
// names match the Python sidecar registry and the candidate identity.
const fasterWhisperProvider = "faster-whisper";
const voskProvider = "vosk";
const defaultVoskBenchmarkModels = ["vosk-model-small-fr-0.22"];

let mainWindow: BrowserWindow | null = null;
// Configured DicTeX data folder (SOURCE root, read-only). Null = use default.
let sourceDataFolderOverride: string | null = null;

/** Default DicTeX data folder per docs/development.md / AGENTS.md
 * (`%APPDATA%/dictex-app/data`), computed directly rather than assumed from
 * this app's own name so the default is explicit and does not depend on the
 * sibling app's own userData convention. */
function getDefaultSourceDataRoot(): string {
  return path.join(app.getPath("appData"), "dictex-app", "data");
}

function getSourceDataRoot(): string {
  return sourceDataFolderOverride ?? getDefaultSourceDataRoot();
}

function getSourceEventsPath(): string {
  return path.join(getSourceDataRoot(), "events.jsonl");
}

/**
 * Resolves a portable `audio_ref` against the SOURCE (DicTeX) data root, for
 * READS only (existsSync / readFile / handing the path to the STT engine).
 * Never used for a write. Guards against path traversal outside the source
 * root, same guard shape as apps/dictex's `resolveDataRef`.
 */
function resolveSourceAudioRef(portableRef: string): string {
  if (portableRef.length === 0) {
    // NO_AUDIO_REF (see ./datasetBuilder.ts): a dataset-builder text-only
    // entry with no real audio file. Reject before resolving, so this never
    // silently resolves to the data root directory itself.
    throw new Error("This entry has no audio file (a Lab dataset-builder text-only entry)");
  }

  const dataRoot = path.resolve(getSourceDataRoot());
  const targetPath = path.resolve(dataRoot, portableRef);
  const relative = path.relative(dataRoot, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Data reference points outside data directory: ${portableRef}`);
  }

  return targetPath;
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

// The Lab's OWN store: corrections, splits, benchmark results, candidate
// selections, exports, settings. Entirely separate from DicTeX's data root —
// this app's own Electron userData (a distinct package name from
// apps/dictex, so a distinct default OS path).
function getOwnDataRoot(): string {
  return path.join(app.getPath("userData"), "data");
}

function getOwnEventsPath(): string {
  return path.join(getOwnDataRoot(), "events.jsonl");
}

function getOwnExportsRoot(): string {
  return path.join(getOwnDataRoot(), "exports");
}

function getOwnSettingsPath(): string {
  return path.join(getOwnDataRoot(), "settings.json");
}

async function loadPersistedSettings(): Promise<void> {
  const { settings, diagnostics } = await readLabSettings(getOwnSettingsPath());
  sourceDataFolderOverride = settings.dictexDataFolder;
  for (const diagnostic of diagnostics) {
    console.warn(`[settings] ${diagnostic}`);
  }
}

/**
 * Reads DicTeX's `audio_segment` / `stt_result` / `normalization_result`
 * events (read-only) concatenated with the Lab's OWN `stt_correction` /
 * `stt_benchmark_set_membership` / `stt_benchmark_result` /
 * `stt_candidate_selection` events, source first. Every shared derivation in
 * `@dictex/shared` keys off array order for latest-event-wins, and a Lab
 * action on a segment always logically happens after DicTeX recorded it, so
 * this concatenation reconstructs correct combined state without either app
 * knowing about the other's storage.
 */
async function readAllEvents(): Promise<LocalEvent[]> {
  const [sourceEvents, ownEvents] = await Promise.all([
    readLocalEvents(getSourceEventsPath()),
    readLocalEvents(getOwnEventsPath()),
  ]);
  return [...sourceEvents, ...ownEvents];
}

async function appendOwnEvent(event: Record<string, JsonValue>): Promise<void> {
  const ownDataRoot = getOwnDataRoot();
  await mkdir(ownDataRoot, { recursive: true });
  await appendFile(getOwnEventsPath(), `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}

function getBaseSttConfig(): SttConfig {
  return {
    engine: fasterWhisperProvider,
    // Overwritten per-candidate below; only device/language/computeType from
    // this base config end up in the built variant string.
    model: process.env.DICTEX_STT_MODEL || "base",
    language: process.env.DICTEX_STT_LANGUAGE || "fr",
    device: process.env.DICTEX_STT_DEVICE || "cpu",
    computeType: process.env.DICTEX_STT_COMPUTE_TYPE || "int8",
  };
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

/**
 * Runs every STT benchmark candidate over one DicTeX-recorded segment. Reads
 * the audio from the SOURCE data root (read-only); appends each result to the
 * Lab's OWN event log (never DicTeX's) — matches apps/dictex's
 * `runSttBenchmarkForAudioSegment`, adapted for the two-root split.
 */
async function runSttBenchmarkForAudioSegment(
  audioSegment: AudioSegmentRecord,
  events?: LocalEvent[],
  modelFilter?: string[],
): Promise<SttBenchmarkResponse> {
  const audioPath = resolveSourceAudioRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found in the DicTeX data folder: ${audioSegment.audioRef}`);
  }

  const baseConfig = getBaseSttConfig();
  const results: SttBenchmarkResult[] = [];
  const diagnostics: string[] = [];
  const loadedEvents = events ?? (await readAllEvents());
  const correction = getLatestSttCorrection(loadedEvents, audioSegment.sessionId, audioSegment.segmentId);
  const candidates = modelFilter
    ? getSttBenchmarkCandidates(baseConfig).filter((candidate) => modelFilter.includes(candidate.model))
    : getSttBenchmarkCandidates(baseConfig);

  for (const candidate of candidates) {
    const config: SttConfig = {
      ...baseConfig,
      engine: candidate.provider,
      model: candidate.model,
    };
    const transcriptionStartedAt = Date.now();
    let sttResult: EngineTranscriptionResult;
    try {
      sttResult = await transcribeWithPython(enginePath, repoRoot, audioPath, config);
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

    // Appended to the Lab's OWN event log — never DicTeX's events.jsonl.
    await appendOwnEvent({
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

  return { source: audioSegment, results, diagnostics };
}

function datasetSplitFileName(split: SttBenchmarkSetSplit, correctionKind: string): string {
  return `${split}.${correctionKind}.jsonl`;
}

/**
 * Serializes one export record to the JSONL line shape (snake_case), matching
 * apps/dictex's `serializeDatasetRecord` exactly (same field set/order) so
 * exports stay test_frozen-compatible. `audio_path` resolves against the
 * SOURCE (DicTeX) data root, since that is where the audio actually lives;
 * resolution is a read, never a write.
 */
function serializeDatasetRecord(record: SttDatasetRecord): Record<string, JsonValue> {
  // A dataset-builder text-only entry (see ./datasetBuilder.ts) carries
  // NO_AUDIO_REF ("") as its audioRef. Map it back to a genuine `null` here
  // rather than resolving/leaking the sentinel into the exported JSONL, so a
  // math_transform-only, no-audio record never claims an audio file exists.
  const hasAudio = record.audioRef.length > 0;
  let audioPath: string | null = null;
  if (hasAudio) {
    try {
      audioPath = resolveSourceAudioRef(record.audioRef);
    } catch {
      audioPath = null;
    }
  }

  return {
    split: record.split,
    session_id: record.sessionId,
    segment_id: record.segmentId,
    audio_ref: hasAudio ? record.audioRef : null,
    audio_path: audioPath,
    language: record.language,
    correction_kind: record.correctionKind,
    raw_transcript: record.rawTranscript,
    corrected_transcript: record.correctedTranscript,
    original_stt_output: record.originalSttOutput,
    stt_engine: record.sttEngine,
    stt_model: record.sttModel,
    correction_method: record.correctionMethod,
    correction_created_at: record.correctionCreatedAt,
    selected_candidate: record.selectedCandidate,
    selection_reason: record.selectionReason,
  };
}

/**
 * Writes the corrected STT dataset export under the Lab's OWN exports root
 * (never DicTeX's folder). Same manifest + per-split/per-kind JSONL file
 * layout as apps/dictex's export, plus a `source_data_folder` manifest field
 * documenting where the audio was read from.
 */
async function writeSttDatasetExport(datasetExport: SttDatasetExport): Promise<SttDatasetExportSummary> {
  const baseSummary: Omit<SttDatasetExportSummary, "exportDir" | "splits"> = {
    createdAt: datasetExport.createdAt,
    totalRecords: datasetExport.totalRecords,
    skippedUntypedCorrections: datasetExport.skippedUntypedCorrections,
    selectedCandidate: datasetExport.selectedCandidate,
    selectionReason: datasetExport.selectionReason,
  };

  if (datasetExport.totalRecords === 0) {
    return { ...baseSummary, exportDir: null, splits: [] };
  }

  const folderStamp = datasetExport.createdAt.replace(/[:.]/g, "-");
  const exportDir = path.join(getOwnExportsRoot(), `stt-dataset-${folderStamp}`);
  await mkdir(exportDir, { recursive: true });

  const splitSummaries: SttDatasetExportSplitSummary[] = [];

  for (const splitGroup of datasetExport.splits) {
    const files: SttDatasetExportFileSummary[] = [];

    for (const kindGroup of splitGroup.kinds) {
      const fileName = datasetSplitFileName(splitGroup.split, kindGroup.correctionKind);
      const contents = kindGroup.records
        .map((record) => `${JSON.stringify(serializeDatasetRecord(record))}\n`)
        .join("");
      await writeFile(path.join(exportDir, fileName), contents, { encoding: "utf8" });
      files.push({ correctionKind: kindGroup.correctionKind, file: fileName, recordCount: kindGroup.records.length });
    }

    splitSummaries.push({
      split: splitGroup.split,
      segmentCount: splitGroup.segmentCount,
      correctedSegmentCount: splitGroup.correctedSegmentCount,
      recordCount: splitGroup.recordCount,
      files,
    });
  }

  const manifest: Record<string, JsonValue> = {
    app: "DicTeX Lab",
    dataset: "stt_corrected",
    created_at: datasetExport.createdAt,
    source_data_folder: getSourceDataRoot(),
    selected_candidate: datasetExport.selectedCandidate,
    selection_reason: datasetExport.selectionReason,
    total_records: datasetExport.totalRecords,
    skipped_untyped_corrections: datasetExport.skippedUntypedCorrections,
    splits: splitSummaries.map((splitSummary) => ({
      split: splitSummary.split,
      segment_count: splitSummary.segmentCount,
      corrected_segment_count: splitSummary.correctedSegmentCount,
      record_count: splitSummary.recordCount,
      files: splitSummary.files.map((file) => ({
        correction_kind: file.correctionKind,
        file: file.file,
        record_count: file.recordCount,
      })),
    })),
  };

  await writeFile(path.join(exportDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
  });

  return { ...baseSummary, exportDir, splits: splitSummaries };
}

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: "DicTeX Lab",
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function sendBatchBenchmarkProgress(progress: SttBenchmarkSetProgress): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("benchmark:set-progress", progress);
}

// ---- settings: configurable DicTeX data folder (source, read-only) ----

ipcMain.handle("settings:get-data-folder", async (): Promise<DataFolderStatus> => {
  return { path: getSourceDataRoot(), isDefault: sourceDataFolderOverride === null };
});

ipcMain.handle("settings:set-data-folder", async (_event, folder: unknown): Promise<DataFolderStatus> => {
  if (typeof folder !== "string" || folder.trim().length === 0) {
    throw new Error("Data folder must be a non-empty string");
  }

  const nextFolder = path.resolve(folder.trim());
  sourceDataFolderOverride = nextFolder;
  await writeLabSettings(getOwnSettingsPath(), { dictexDataFolder: nextFolder });

  return { path: getSourceDataRoot(), isDefault: false };
});

ipcMain.handle("settings:reset-data-folder", async (): Promise<DataFolderStatus> => {
  sourceDataFolderOverride = null;
  await writeLabSettings(getOwnSettingsPath(), { dictexDataFolder: null });

  return { path: getSourceDataRoot(), isDefault: true };
});

ipcMain.handle("settings:pick-data-folder", async (): Promise<DataFolderStatus | null> => {
  if (!mainWindow) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose the DicTeX data folder",
    defaultPath: getSourceDataRoot(),
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const nextFolder = result.filePaths[0];
  sourceDataFolderOverride = nextFolder;
  await writeLabSettings(getOwnSettingsPath(), { dictexDataFolder: nextFolder });

  return { path: getSourceDataRoot(), isDefault: false };
});

ipcMain.handle("source:check-data-folder", async (): Promise<SourceFolderCheck> => {
  const root = getSourceDataRoot();
  return { exists: existsSync(root), eventsFound: existsSync(getSourceEventsPath()) };
});

// ---- segments: read-only source events + own correction/split state ----

ipcMain.handle("segments:list", async (_event, limit?: number): Promise<ReconstructedSegment[]> => {
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
  return reconstructRecentSegments(await readAllEvents(), safeLimit);
});

ipcMain.handle("segments:get-audio", async (_event, audioSegment: AudioSegmentRecord): Promise<AudioSegmentPlayback> => {
  if (
    !audioSegment ||
    typeof audioSegment.sessionId !== "string" ||
    typeof audioSegment.segmentId !== "string" ||
    typeof audioSegment.audioRef !== "string"
  ) {
    throw new Error("Invalid audio segment");
  }

  const audioPath = resolveSourceAudioRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found in the DicTeX data folder: ${audioSegment.audioRef}`);
  }

  return {
    audioBytes: new Uint8Array(await readFile(audioPath)),
    mimeType: getAudioMimeType(audioSegment.audioRef),
  };
});

// ---- corrections (own store) ----

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

  await appendOwnEvent({
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

// ---- benchmark set membership (own store) ----

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

    const latestCorrection = getLatestSttCorrection(await readAllEvents(), membership.sessionId, membership.segmentId);
    if (!latestCorrection) {
      throw new Error("Correct the transcript before adding it to an STT benchmark set");
    }

    const createdAt = new Date().toISOString();

    await appendOwnEvent({
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

// ---- benchmark runs ----

ipcMain.handle("benchmark:run-latest-stt", async (): Promise<SttBenchmarkResponse> => {
  const events = await readAllEvents();
  const latestAudioSegment = getLatestAudioSegmentFromEvents(events);
  if (!latestAudioSegment) {
    throw new Error("No stored audio segment found in the DicTeX data folder");
  }

  return runSttBenchmarkForAudioSegment(latestAudioSegment, events);
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
    // Read the combined event set once so every segment scores against the
    // same correction snapshot and appended benchmark results cannot shift
    // later lookups within this run.
    const events = await readAllEvents();
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

    const events = await readAllEvents();
    return summarizeSttBenchmarkResultsByCandidate(events, request.split);
  },
);

// ---- candidate selection (own store) ----

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

    await appendOwnEvent({
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
  const events = await readAllEvents();
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

// ---- dataset builder (own store; manual two-layer entries, issue #78) ----

ipcMain.handle(
  "dataset-builder:save-entry",
  async (_event, request: DatasetBuilderSaveRequest): Promise<DatasetBuilderSaveResponse> => {
    if (!request || (request.source?.mode !== "paste" && request.source?.mode !== "segment")) {
      throw new Error("Invalid dataset builder source");
    }
    if (!isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    // planDatasetBuilderSave validates the transcripts/source further and
    // decides which layer(s) to write (see ./datasetBuilder.ts docblock for
    // the two-layer separability rule).
    const plan = planDatasetBuilderSave(request);
    const baseConfig = getBaseSttConfig();

    // Synthetic own-store stt_result: only for a "paste" source with a raw
    // transcript, so getSegmentSttInfo can attribute it to the chosen
    // reference model. A "segment" source already has a real stt_result
    // event in DicTeX's (read-only) source data folder.
    if (plan.writeSyntheticSttResult) {
      await appendOwnEvent({
        event_type: "stt_result",
        session_id: plan.sessionId,
        segment_id: plan.segmentId,
        created_at: new Date().toISOString(),
        audio_ref: plan.audioRef,
        stt_engine: fasterWhisperProvider,
        stt_model: typeof request.referenceModel === "string" && request.referenceModel.length > 0
          ? request.referenceModel
          : baseConfig.model,
        stt_language: baseConfig.language,
        stt_output: plan.rawTranscript,
        corrected_transcript: null,
      });
    }

    if (plan.saveAcoustic) {
      await appendOwnEvent({
        event_type: "stt_correction",
        created_at: new Date().toISOString(),
        session_id: plan.sessionId,
        segment_id: plan.segmentId,
        audio_ref: plan.audioRef,
        raw_transcript: plan.rawTranscript,
        corrected_transcript: plan.literalTranscript,
        correction_method: "keyboard",
        correction_kind: "acoustic",
      });
    }

    if (plan.saveMathTransform) {
      await appendOwnEvent({
        event_type: "stt_correction",
        created_at: new Date().toISOString(),
        session_id: plan.sessionId,
        segment_id: plan.segmentId,
        audio_ref: plan.audioRef,
        raw_transcript: plan.literalTranscript,
        corrected_transcript: plan.notationTranscript,
        correction_method: "keyboard",
        correction_kind: "math_transform",
      });
    }

    // Benchmark-set membership is what makes buildSttDatasetExport (reused
    // unmodified from @dictex/shared) pick this entry up for the chosen
    // split; see getSttBenchmarkSetSegments's string-typed audioRef
    // requirement, satisfied here by NO_AUDIO_REF for a no-audio entry.
    await appendOwnEvent({
      event_type: "stt_benchmark_set_membership",
      created_at: new Date().toISOString(),
      session_id: plan.sessionId,
      segment_id: plan.segmentId,
      audio_ref: plan.audioRef,
      split: request.split,
      reason: "dataset_builder",
    });

    return {
      sessionId: plan.sessionId,
      segmentId: plan.segmentId,
      audioRef: plan.realAudioRef,
      savedAcoustic: plan.saveAcoustic,
      savedMathTransform: plan.saveMathTransform,
      split: request.split,
    };
  },
);

// ---- dataset export (own store) ----

ipcMain.handle("dataset:export-stt", async (): Promise<SttDatasetExportSummary> => {
  const events = await readAllEvents();
  const datasetExport = buildSttDatasetExport(events, new Date().toISOString());
  return writeSttDatasetExport(datasetExport);
});

ipcMain.handle("dataset:open-export-folder", async (_event, exportDir?: unknown): Promise<boolean> => {
  const exportsRoot = getOwnExportsRoot();
  await mkdir(exportsRoot, { recursive: true });

  let targetDir = exportsRoot;
  if (typeof exportDir === "string" && exportDir.length > 0) {
    // Only open folders inside the Lab's own exports root; never an arbitrary
    // caller path.
    const resolved = path.resolve(exportDir);
    const relative = path.relative(path.resolve(exportsRoot), resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(resolved)) {
      targetDir = resolved;
    }
  }

  const error = await shell.openPath(targetDir);
  return error.length === 0;
});

// ---- diagnostics ----

ipcMain.handle("diagnostics:open-lab-data-folder", async (): Promise<boolean> => {
  const ownDataRoot = getOwnDataRoot();
  await mkdir(ownDataRoot, { recursive: true });
  const error = await shell.openPath(ownDataRoot);
  return error.length === 0;
});

ipcMain.handle("diagnostics:open-source-data-folder", async (): Promise<boolean> => {
  // Read-only convenience: opens the folder in the OS file explorer (a read),
  // never creates or writes into it.
  const sourceRoot = getSourceDataRoot();
  if (!existsSync(sourceRoot)) {
    return false;
  }
  const error = await shell.openPath(sourceRoot);
  return error.length === 0;
});

ipcMain.handle("diagnostics:open-lab-events-log", async (): Promise<boolean> => {
  const ownDataRoot = getOwnDataRoot();
  await mkdir(ownDataRoot, { recursive: true });
  const eventsPath = getOwnEventsPath();
  if (!existsSync(eventsPath)) {
    await writeFile(eventsPath, "", { encoding: "utf8" });
  }
  const error = await shell.openPath(eventsPath);
  return error.length === 0;
});

ipcMain.handle("diagnostics:get-stt-benchmark-models", (): string[] => getSttBenchmarkModels());

app.whenReady().then(async () => {
  await loadPersistedSettings();
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
