import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLatestSttCandidateSelection,
  getLatestSttCorrection,
  getSttPromptVariantDefinitions,
  isCorrectionKind,
  readLocalEvents,
  reconstructRecentSegments,
  buildSttBenchmarkRunDetail,
  buildSttBenchmarkRunSnapshot,
  getBenchmarkRunProjection,
  getBenchmarkRunProjections,
  summarizeLegacySttBenchmarkResultsByCandidate,
  buildSttBenchmarkRunExport,
  buildNormalizerBenchmarkRunExport,
  buildSttDatasetExport,
  createTranscriptNormalizer,
  normalizeTranscript,
  restoreCommandWords,
  transcribeWithPython,
  ProviderUnavailableError,
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
  type SttBenchmarkSetSplitRequest,
  type SttBenchmarkSetPreview,
  type SttBenchmarkSetSegmentOutcome,
  type SttBenchmarkSetRunResponse,
  type SttBenchmarkSetProgress,
  type SttBenchmarkRunDetail,
  type BenchmarkMathTransformRunProjection,
  type BenchmarkRunListEntry,
  type SttBenchmarkRunExportSummary,
  type NormalizerBenchmarkRunExportSummary,
  type SttDatasetExportFileSummary,
  type SttDatasetExportSplitSummary,
  type SttDatasetExportSummary,
} from "@dictex/shared";
import { writeSttBenchmarkRunExport } from "./benchmarkRunExportWriter.js";
import { writeNormalizerBenchmarkRunExport } from "./normalizerBenchmarkRunExportWriter.js";
import { requireNonEmptySttBenchmarkSnapshot, requireSttBenchmarkOutput } from "./benchmarkExecution.js";
import {
  buildNormalizerBenchmarkSetPreview,
  runNormalizerBenchmark,
  type NormalizerBenchmarkRunRequest,
  type NormalizerBenchmarkRunResponse,
  type NormalizerBenchmarkSetPreview,
} from "./normalizerBenchmark.js";
import {
  scoreSttBenchmarkTranscript,
  type SttBenchmarkReference,
} from "./benchmarkScoring.js";
import { readLabSettings, writeLabSettings } from "./settings.js";
import {
  planDatasetBuilderSave,
  type DatasetBuilderSaveRequest,
  type DatasetBuilderSaveResponse,
} from "./datasetBuilder.js";
import {
  buildSttBenchmarkCandidateCatalog,
  buildSttConfigForCandidate,
  getSttBenchmarkRuntimes,
  toCandidateOption,
  validateRequestedCandidates,
  type SttBenchmarkCandidateConfig,
  type SttBenchmarkCandidateOption,
} from "./candidateCatalog.js";
import {
  collectExistingPromptVariantNames,
  listPromptVariants,
  validateNewPromptVariant,
  type SttPromptVariantCreateRequest,
  type SttPromptVariantListEntry,
} from "./promptVariants.js";

/**
 * DicTeX Lab main process (pivot Phase 2, issue #76). No microphone, hotkey or
 * clipboard/paste. It never normalizes dictation for insertion, but it replays
 * the shared deterministic pipeline for dataset export and the tracked
 * normalizer benchmark. The Lab benchmarks, corrects, splits, selects
 * candidates, and exports datasets, reading
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

// The SOURCE (DicTeX) normalizer config, resolved exactly as apps/dictex lays it
// out under its data root (`<data>/normalizer/{dictionary,rules}.json`). Read
// READ-ONLY when export or the normalizer benchmark replays the pipeline to
// build a `math_transform` artifact (issues #100/#140); the Lab never writes
// into DicTeX's folder. A
// missing file degrades gracefully inside the normalizer (empty dictionary /
// built-in DEFAULT_RULES), so no existence check is needed here.
function getSourceNormalizerDir(): string {
  return path.join(getSourceDataRoot(), "normalizer");
}

function getSourceDictionaryPath(): string {
  return path.join(getSourceNormalizerDir(), "dictionary.json");
}

function getSourceRulesPath(): string {
  return path.join(getSourceNormalizerDir(), "rules.json");
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
 * `stt_benchmark_set_membership` / benchmark run + result /
 * `stt_candidate_selection` / prompt-definition events, source first. Every
 * shared derivation in
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

/** Stable, unique id for one tracked benchmark run (issue #122): a timestamp
 * for human-readable ordering plus a random suffix so two runs started in the
 * same millisecond never collide. */
function mintBenchmarkRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  const suffix = Math.random().toString(36).slice(2, 10);
  return `run_${stamp}_${suffix}`;
}

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}

/**
 * Runs the given STT benchmark candidates over one DicTeX-recorded segment of a
 * tracked run. Reads the audio from the SOURCE data root (read-only); appends
 * each result to the Lab's OWN event log (never DicTeX's).
 *
 * Since issue #138 a benchmark result only ever exists inside a run: there is no
 * ad-hoc, run-less replay path left, so the run id, the launched candidates and
 * the run's frozen reference are all required — a result can no longer be
 * appended without the snapshot that explains it.
 */
async function runSttBenchmarkForAudioSegment(
  audioSegment: AudioSegmentRecord,
  loadedEvents: LocalEvent[],
  candidates: SttBenchmarkCandidateConfig[],
  runId: string,
  frozenReference: SttBenchmarkReference,
): Promise<SttBenchmarkResponse> {
  const audioPath = resolveSourceAudioRef(audioSegment.audioRef);
  if (!existsSync(audioPath)) {
    throw new Error(`Audio segment file not found in the DicTeX data folder: ${audioSegment.audioRef}`);
  }

  const results: SttBenchmarkResult[] = [];
  const diagnostics: string[] = [];

  for (const candidate of candidates) {
    // Build the sidecar config from the candidate's OWN structured runtime
    // (issue #131): never from a global runtime, and never by re-parsing the
    // `variant` string. Each transcribeWithPython call gets exactly this
    // candidate's device, compute type, language and prompt.
    const config: SttConfig = buildSttConfigForCandidate(candidate);
    const identity: BenchmarkCandidate = {
      stage: candidate.stage,
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant,
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
      candidate: identity,
      stage: identity.stage,
      provider: identity.provider,
      model: identity.model,
      variant: identity.variant ?? null,
      sttEngine: sttResult.sttEngine,
      sttModel: sttResult.sttModel,
      sttLanguage: sttResult.sttLanguage,
      transcript: sttResult.transcript,
      audioDurationSeconds: sttResult.audioDurationSeconds,
      transcriptionDurationMs,
      score: scoreSttBenchmarkTranscript(
        sttResult.transcript,
        loadedEvents,
        audioSegment.sessionId,
        audioSegment.segmentId,
        frozenReference,
      ),
    };

    // Appended to the Lab's OWN event log — never DicTeX's events.jsonl.
    // `run_id` binds the result to its tracked run (issue #122); every result
    // written since #138 carries one.
    await appendOwnEvent({
      event_type: "stt_benchmark_result",
      session_id: result.sessionId,
      segment_id: result.segmentId,
      created_at: new Date().toISOString(),
      run_id: runId,
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

  requireSttBenchmarkOutput(results, diagnostics);
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
    // Pipeline fingerprint that built the math_transform INPUTS (issue #100): a
    // dataset must be traceable to the rules/dictionary version that produced it,
    // since a rule change rewrites every input. null = that config file was
    // absent (empty dictionary / built-in DEFAULT_RULES).
    normalizer_version: {
      dictionary_hash: datasetExport.normalizerVersion.dictionaryHash,
      rules_hash: datasetExport.normalizerVersion.rulesHash,
    },
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

/**
 * What a run over this split would freeze (issue #138), so the Experiments view
 * can announce the split, the evaluable member count and the scorable count
 * BEFORE launching. Built from `buildSttBenchmarkRunSnapshot`, the very function
 * the launch calls, so the announced protocol and the executed run cannot drift
 * apart. Read-only: no event is written.
 */
ipcMain.handle(
  "benchmark-set:preview",
  async (_event, request: SttBenchmarkSetSplitRequest): Promise<SttBenchmarkSetPreview> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const snapshot = buildSttBenchmarkRunSnapshot(await readAllEvents(), request.split);
    return {
      split: request.split,
      evaluableSegments: snapshot.length,
      scorableSegments: snapshot.filter((member) => member.referenceTranscript !== null).length,
    };
  },
);

ipcMain.handle(
  "benchmark-set:preview-normalizer",
  async (_event, request: SttBenchmarkSetSplitRequest): Promise<NormalizerBenchmarkSetPreview> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid normalizer benchmark split");
    }

    const [events, normalizer] = await Promise.all([
      readAllEvents(),
      createTranscriptNormalizer({
        dictionaryPath: getSourceDictionaryPath(),
        rulesPath: getSourceRulesPath(),
      }),
    ]);
    return buildNormalizerBenchmarkSetPreview(events, request.split, normalizer);
  },
);

ipcMain.handle(
  "benchmark:run-set-stt",
  async (_event, request: SttBenchmarkSetRunRequest): Promise<SttBenchmarkSetRunResponse> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const split = request.split;
    // Read the combined event set once so every segment scores against the
    // same correction snapshot and appended benchmark results cannot shift
    // later lookups within this run.
    const events = await readAllEvents();

    // The candidates actually launched: the identities the Experiments view
    // announced, always revalidated against this process's own catalog — never
    // an implicit "whole catalog" fallback, so a run can only ever execute what
    // its protocol announced (issue #138). They feed the run manifest, so the
    // run records exactly which candidates it ran.
    const catalog = buildSttBenchmarkCandidateCatalog(getSttBenchmarkRuntimes(), getSttPromptVariantDefinitions(events));
    const runCandidates = validateRequestedCandidates(request.candidates, catalog);

    // Freeze the acoustic input snapshot at run start (issue #122): only
    // real-audio segments, with the reference and correction timestamp used by
    // this run. A later re-correction or membership change cannot alter it.
    const snapshot = buildSttBenchmarkRunSnapshot(events, split);
    // The renderer preview is advisory. This authoritative guard runs before a
    // run id or event exists, so a stale click can never append an empty run.
    requireNonEmptySttBenchmarkSnapshot(snapshot);
    const total = snapshot.length;
    const runId = mintBenchmarkRunId();
    const startedAt = new Date().toISOString();
    const runPromptDefinitions = Array.from(
      new Map(
        runCandidates
          .filter(
            (
              candidate,
            ): candidate is SttBenchmarkCandidateConfig & { promptVariant: string; displayPromptText: string } =>
              typeof candidate.promptVariant === "string" && typeof candidate.displayPromptText === "string",
          )
          .map((candidate) => [
            candidate.promptVariant,
            {
              id: candidate.promptVariant,
              display_name: candidate.promptDisplayName ?? candidate.promptVariant,
              prompt_text: candidate.displayPromptText,
            },
          ]),
      ).values(),
    );

    await appendOwnEvent({
      event_type: "stt_benchmark_run_started",
      run_id: runId,
      created_at: startedAt,
      stage: "stt",
      // An STT run is always acoustic: a math_transform record without audio is
      // never part of the snapshot (buildSttBenchmarkRunSnapshot excludes it).
      dataset_kind: "acoustic",
      split,
      candidates: runCandidates.map((candidate) => ({
        stage: candidate.stage,
        provider: candidate.provider,
        model: candidate.model,
        variant: candidate.variant ?? null,
        prompt_variant: candidate.promptVariant ?? null,
      })),
      prompt_definitions: runPromptDefinitions,
      snapshot: snapshot.map((member) => ({
        session_id: member.sessionId,
        segment_id: member.segmentId,
        audio_ref: member.audioRef,
        reference_transcript: member.referenceTranscript,
        correction_created_at: member.correctionCreatedAt,
      })),
    });

    let queued = total;
    let running = 0;
    let done = 0;
    let failed = 0;
    const outcomes: SttBenchmarkSetSegmentOutcome[] = [];
    const failures: { session_id: string; segment_id: string; error: string }[] = [];

    sendBatchBenchmarkProgress({ split, total, queued, running, done, failed, current: null, lastOutcome: null });

    for (const member of snapshot) {
      queued -= 1;
      running = 1;
      sendBatchBenchmarkProgress({
        split,
        total,
        queued,
        running,
        done,
        failed,
        current: { sessionId: member.sessionId, segmentId: member.segmentId },
        lastOutcome: null,
      });

      try {
        const response = await runSttBenchmarkForAudioSegment(
          { sessionId: member.sessionId, segmentId: member.segmentId, audioRef: member.audioRef },
          events,
          runCandidates,
          runId,
          {
            referenceTranscript: member.referenceTranscript,
            correctionCreatedAt: member.correctionCreatedAt,
          },
        );
        running = 0;
        done += 1;
        outcomes.push({
          sessionId: member.sessionId,
          segmentId: member.segmentId,
          audioRef: member.audioRef,
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
            sessionId: member.sessionId,
            segmentId: member.segmentId,
            status: "done",
            error: null,
            resultCount: response.results.length,
          },
        });
      } catch (error) {
        running = 0;
        failed += 1;
        const message = error instanceof Error ? error.message : "Benchmark failed";
        failures.push({ session_id: member.sessionId, segment_id: member.segmentId, error: message });
        outcomes.push({
          sessionId: member.sessionId,
          segmentId: member.segmentId,
          audioRef: member.audioRef,
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
            sessionId: member.sessionId,
            segmentId: member.segmentId,
            status: "failed",
            error: message,
            resultCount: 0,
          },
        });
      }
    }

    // Terminal run event (issue #122): done/failed counts plus the observed
    // failures, so a failed segment is distinguishable from one that was never
    // executed (in the snapshot but absent from both results and failures).
    await appendOwnEvent({
      event_type: "stt_benchmark_run_finished",
      run_id: runId,
      created_at: new Date().toISOString(),
      done,
      failed,
      failures,
    });

    return { split, runId, total, done, failed, outcomes };
  },
);

ipcMain.handle(
  "benchmark:run-set-normalizer",
  async (_event, request: NormalizerBenchmarkRunRequest): Promise<NormalizerBenchmarkRunResponse> => {
    const candidate = request?.candidate;
    if (
      !request ||
      !isSttBenchmarkSetSplit(request.split) ||
      !candidate ||
      candidate.stage !== "math_transform" ||
      candidate.provider !== "dictex" ||
      candidate.model !== "deterministic-pipeline" ||
      typeof candidate.variant !== "string"
    ) {
      throw new Error("Invalid normalizer benchmark protocol");
    }

    const [events, normalizer] = await Promise.all([
      readAllEvents(),
      createTranscriptNormalizer({
        dictionaryPath: getSourceDictionaryPath(),
        rulesPath: getSourceRulesPath(),
      }),
    ]);
    return runNormalizerBenchmark({
      events,
      split: request.split,
      requestedCandidate: candidate,
      normalizer,
      runId: mintBenchmarkRunId(),
      appendEvent: (event) => appendOwnEvent(event as unknown as Record<string, JsonValue>),
      onProgress: sendBatchBenchmarkProgress,
    });
  },
);

/**
 * Everything the Results view shows about ONE run (issue #138): its status, its
 * frozen snapshot, the candidates it launched, their outputs, its failures and
 * its per-candidate summary — derived only from that run's own events, so
 * reopening an old run can never render it against another run's snapshot.
 */
ipcMain.handle(
  "benchmark-run:detail",
  async (
    _event,
    request: { runId?: unknown },
  ): Promise<SttBenchmarkRunDetail | BenchmarkMathTransformRunProjection | null> => {
    if (!request || typeof request.runId !== "string" || request.runId.length === 0) {
      throw new Error("A run id is required");
    }

    const events = await readAllEvents();
    const projection = getBenchmarkRunProjection(events, request.runId);
    return projection?.stage === "math_transform"
      ? projection
      : buildSttBenchmarkRunDetail(events, request.runId);
  },
);

ipcMain.handle(
  "benchmark-set:list-runs",
  async (_event, request: SttBenchmarkSetSplitRequest): Promise<BenchmarkRunListEntry[]> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const events = await readAllEvents();
    return getBenchmarkRunProjections(events, request.split).flatMap((run) =>
      run.runId === null
        ? []
        : [
            {
              runId: run.runId,
              createdAt: run.createdAt,
              stage: run.stage,
              datasetKind: run.datasetKind,
              split: run.split,
              snapshotSize: run.members.length,
              candidateCount: run.candidates.length,
              done: run.terminal?.done ?? null,
              failed: run.terminal?.failed ?? null,
              finished: run.terminal !== null,
            },
          ],
    );
  },
);

ipcMain.handle(
  "benchmark-run:export-llm",
  async (
    _event,
    request: { runId?: unknown },
  ): Promise<SttBenchmarkRunExportSummary | NormalizerBenchmarkRunExportSummary> => {
    if (!request || typeof request.runId !== "string" || request.runId.length === 0) {
      throw new Error("A run id is required");
    }

    const events = await readAllEvents();
    const projection = getBenchmarkRunProjection(events, request.runId);
    if (projection?.stage === "math_transform") {
      const runExport = buildNormalizerBenchmarkRunExport(events, request.runId, new Date().toISOString());
      return writeNormalizerBenchmarkRunExport(getOwnExportsRoot(), runExport);
    }
    const promptDefinitions = listPromptVariants(events)
      .filter((definition) => definition.source === "external" || !definition.shadowedByExternal)
      .map((definition) => ({
        id: definition.name,
        displayName: definition.displayName,
        promptText: definition.promptText,
      }));
    const runExport = buildSttBenchmarkRunExport(events, request.runId, {
      exportedAt: new Date().toISOString(),
      promptDefinitions,
      resolveAudioPath: (audioRef) => resolveSourceAudioRef(audioRef),
    });
    return writeSttBenchmarkRunExport(getOwnExportsRoot(), runExport);
  },
);

ipcMain.handle(
  "benchmark-set:summarize-legacy-stt",
  async (_event, request: SttBenchmarkSetSplitRequest): Promise<SttBenchmarkCandidateSummaryResponse> => {
    if (!request || !isSttBenchmarkSetSplit(request.split)) {
      throw new Error("Invalid STT benchmark set split");
    }

    const events = await readAllEvents();
    return summarizeLegacySttBenchmarkResultsByCandidate(events, request.split);
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

// ---- dataset builder Layer 2 prefill (issue #101) ----

/**
 * Prefills Layer 2 from the SOURCE folder's normalizer, run over the given
 * Layer 1 text — the same full pipeline (dictionary -> command extraction ->
 * regex) `apps/dictex` serves at inference and the export replays (#100), so
 * the prefill reflects precisely what the regex layer sees in production
 * rather than a second, possibly-diverging codepath.
 *
 * Command extraction is a real pipeline layer, so its output MAY contain a
 * sentinel; `restoreCommandWords` (the sentinel -> canonical WORDS direction,
 * as opposed to `expandCommands`'s sentinel -> EFFECT direction) turns it
 * back into spelled-out command words before this ever reaches the renderer,
 * so the builder never displays — and can therefore never save — a sentinel
 * or a literal command effect (storage rule, design doc §4). Renderer-side
 * this is asserted by construction: nothing downstream of this handler can
 * introduce a sentinel back in.
 *
 * Read-only against the SOURCE (DicTeX) data folder, same as the export; this
 * never writes anywhere.
 */
ipcMain.handle("dataset-builder:prefill-layer2", async (_event, literalTranscript: unknown): Promise<string> => {
  if (typeof literalTranscript !== "string") {
    throw new Error("Layer 1 (literal transcript) must be a string");
  }

  const trimmed = literalTranscript.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const result = await normalizeTranscript(trimmed, {
    dictionaryPath: getSourceDictionaryPath(),
    rulesPath: getSourceRulesPath(),
  });

  return restoreCommandWords(result.output);
});

// ---- dataset export (own store) ----

ipcMain.handle("dataset:export-stt", async (): Promise<SttDatasetExportSummary> => {
  const events = await readAllEvents();
  // Replay the SOURCE folder's normalizer over each math_transform Layer 1 to
  // build the layer-3 training input (issue #100); read-only, never written to.
  const datasetExport = await buildSttDatasetExport(events, new Date().toISOString(), {
    dictionaryPath: getSourceDictionaryPath(),
    rulesPath: getSourceRulesPath(),
  });
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

ipcMain.handle("diagnostics:get-stt-benchmark-candidates", async (): Promise<SttBenchmarkCandidateOption[]> => {
  const events = await readAllEvents();
  return buildSttBenchmarkCandidateCatalog(getSttBenchmarkRuntimes(), getSttPromptVariantDefinitions(events)).map(
    toCandidateOption,
  );
});

// ---- STT prompt variants (own store; issue #121) ----

ipcMain.handle("prompt-variants:list", async (): Promise<SttPromptVariantListEntry[]> => {
  const events = await readAllEvents();
  return listPromptVariants(events);
});

ipcMain.handle(
  "prompt-variants:create",
  async (_event, request: SttPromptVariantCreateRequest): Promise<SttPromptVariantListEntry> => {
    const events = await readAllEvents();
    const existingNames = collectExistingPromptVariantNames(events);
    const { name, displayName, promptText } = validateNewPromptVariant(request, existingNames);

    const createdAt = new Date().toISOString();
    await appendOwnEvent({
      event_type: "stt_prompt_variant_defined",
      created_at: createdAt,
      variant_name: name,
      display_name: displayName,
      prompt_text: promptText,
    });

    return { name, displayName, promptText, source: "local", createdAt, shadowedByExternal: false };
  },
);

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
