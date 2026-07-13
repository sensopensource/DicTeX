import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";
import type {
  AudioSegmentRecord,
  BenchmarkCandidateIdentity,
  CorrectionKind,
  ReconstructedSegment,
  SttBenchmarkCandidateSummary,
  SttBenchmarkCandidateSummaryResponse,
  SttBenchmarkRunDetail,
  SttBenchmarkRunListEntry,
  SttBenchmarkRunExportSummary,
  SttBenchmarkSetMembershipRequest,
  SttBenchmarkSetMembershipResponse,
  SttBenchmarkSetPreview,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSplit,
  SttCandidateSelectionRequest,
  SttCandidateSelectionResponse,
  SttCorrectionRequest,
  SttCorrectionResponse,
  SttDatasetExportSummary,
} from "@dictex/shared";
import {
  formatAudioDuration,
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  formatCorrectionKind,
  formatDatasetCorrectionKind,
  formatLatency,
  formatRatePercent,
  formatScore,
  formatTimestamp,
  formatBenchmarkSetSplit,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import {
  analyzeBatchErrors,
  ERROR_CATEGORY_LABELS,
  formatBenchmarkCandidate,
  formatBenchmarkCandidateKey,
  toSttBenchmarkRunOutcomes,
  type CandidateErrorAnalysis,
  type SttErrorCategory,
} from "@dictex/shared/errorAnalysis";
import { diffWords, type DiffSegment } from "@dictex/shared/textDiff";
import { planCorpusCorrection, type CorpusCorrectionLayer } from "./corpusCorrection.js";
import {
  EXPERIMENT_STAGES,
  getExperimentStage,
  MAX_EXPERIMENT_CANDIDATES,
  planExperimentLaunch,
  planLaunchNavigation,
  type ExperimentLaunchPlan,
  type ExperimentStage,
  type ExperimentStageId,
} from "./experimentProtocol.js";
import {
  applyLegacySummary,
  applyResultsError,
  applyRunDetail,
  emptyResultsState,
  LEGACY_RUN_KEY,
  startResultsSelection,
  type ResultsState,
} from "./resultsSelection.js";
import type {
  DatasetBuilderSaveRequest,
  DatasetBuilderSaveResponse,
  DatasetBuilderSource,
} from "../../main/datasetBuilder.js";
import type { SttBenchmarkCandidateOption } from "../../main/candidateCatalog.js";
import type { SttPromptVariantCreateRequest, SttPromptVariantListEntry } from "../../main/promptVariants.js";

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

type LabApi = {
  getDataFolder: () => Promise<DataFolderStatus>;
  setDataFolder: (folder: string) => Promise<DataFolderStatus>;
  resetDataFolder: () => Promise<DataFolderStatus>;
  pickDataFolder: () => Promise<DataFolderStatus | null>;
  checkDataFolder: () => Promise<SourceFolderCheck>;
  getSegments: (limit?: number) => Promise<ReconstructedSegment[]>;
  getSegmentAudio: (audioSegment: AudioSegmentRecord) => Promise<AudioSegmentPlayback>;
  saveSttCorrection: (correction: SttCorrectionRequest) => Promise<SttCorrectionResponse>;
  markSttBenchmarkSetMembership: (
    membership: SttBenchmarkSetMembershipRequest,
  ) => Promise<SttBenchmarkSetMembershipResponse>;
  previewSttBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkSetPreview>;
  runSetSttBenchmark: (
    split: SttBenchmarkSetSplit,
    candidates: BenchmarkCandidateIdentity[],
  ) => Promise<SttBenchmarkSetRunResponse>;
  getSttBenchmarkRunDetail: (runId: string) => Promise<SttBenchmarkRunDetail | null>;
  listSttBenchmarkRuns: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkRunListEntry[]>;
  exportSttBenchmarkRun: (runId: string) => Promise<SttBenchmarkRunExportSummary>;
  summarizeLegacySttBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkCandidateSummaryResponse>;
  selectSttCandidate: (request: SttCandidateSelectionRequest) => Promise<SttCandidateSelectionResponse>;
  getLatestSttCandidateSelection: () => Promise<SttCandidateSelectionResponse | null>;
  saveDatasetBuilderEntry: (request: DatasetBuilderSaveRequest) => Promise<DatasetBuilderSaveResponse>;
  prefillDatasetBuilderLayer2: (literalTranscript: string) => Promise<string>;
  exportSttDataset: () => Promise<SttDatasetExportSummary>;
  openExportFolder: (exportDir?: string) => Promise<boolean>;
  getSttBenchmarkCandidates: () => Promise<SttBenchmarkCandidateOption[]>;
  listSttPromptVariants: () => Promise<SttPromptVariantListEntry[]>;
  createSttPromptVariant: (request: SttPromptVariantCreateRequest) => Promise<SttPromptVariantListEntry>;
  openLabDataFolder: () => Promise<boolean>;
  openSourceDataFolder: () => Promise<boolean>;
  openLabEventsLog: () => Promise<boolean>;
  onBatchBenchmarkProgress: (callback: (progress: SttBenchmarkSetProgress) => void) => () => void;
};

declare global {
  interface Window {
    dictexLab: LabApi;
  }
}

type View = "corpus" | "experiments" | "results";

function formatRunOption(run: SttBenchmarkRunListEntry): string {
  const when = run.createdAt ? formatTimestamp(run.createdAt) : run.runId;
  const status = run.finished ? `${run.done ?? 0} done / ${run.failed ?? 0} failed` : "unfinished";
  return `${when} · ${run.snapshotSize} seg · ${status}`;
}

/**
 * The correction kind travels WITH the raw transcript it was derived from (see
 * planCorpusCorrection): both are frozen when the human clicks Edit Layer 1 or
 * Edit Layer 2, and nothing between opening and saving can change one without
 * the other.
 */
type HistoryCorrectionTarget = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  rawTranscript: string;
  correctionKind: CorrectionKind;
};

function LabNavigation({
  activeView,
  onNavigate,
}: {
  activeView: View;
  onNavigate: (view: View) => void;
}): React.ReactElement {
  const items: { view: View; label: string }[] = [
    { view: "corpus", label: "Corpus" },
    { view: "experiments", label: "Experiments" },
    { view: "results", label: "Results" },
  ];

  return (
    <nav className="panel nav-panel" aria-label="Lab sections">
      {items.map((item) => (
        <button
          aria-current={activeView === item.view ? "page" : undefined}
          className="nav-button"
          disabled={activeView === item.view}
          key={item.view}
          onClick={() => onNavigate(item.view)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function App(): React.ReactElement {
  const [view, setView] = useState<View>("corpus");
  const [notice, setNotice] = useState("");

  // Configurable DicTeX data folder (source, read-only).
  const [dataFolder, setDataFolder] = useState<DataFolderStatus | null>(null);
  const [sourceCheck, setSourceCheck] = useState<SourceFolderCheck | null>(null);
  const [dataFolderDraft, setDataFolderDraft] = useState("");
  const [isSavingDataFolder, setIsSavingDataFolder] = useState(false);

  // Segments (read-only source + own correction/split state).
  const [segments, setSegments] = useState<ReconstructedSegment[]>([]);
  const [segmentsError, setSegmentsError] = useState("");
  const [isLoadingSegments, setIsLoadingSegments] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [loadingAudioSegmentKey, setLoadingAudioSegmentKey] = useState("");
  const [playingAudioSegmentKey, setPlayingAudioSegmentKey] = useState("");
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [benchmarkSetTargetKey, setBenchmarkSetTargetKey] = useState<string | null>(null);
  const [historyCorrectionTarget, setHistoryCorrectionTarget] = useState<HistoryCorrectionTarget | null>(null);
  const [historyCorrectionDraft, setHistoryCorrectionDraft] = useState("");

  // Experiments: the protocol to launch. Never a past result (issue #138).
  const [candidateCatalog, setCandidateCatalog] = useState<SttBenchmarkCandidateOption[]>([]);
  const [experimentStageId, setExperimentStageId] = useState<ExperimentStageId>("stt");
  const [experimentSplit, setExperimentSplit] = useState<SttBenchmarkSetSplit>("validation");
  // What a run over the experiment's split would freeze right now: read from the
  // same snapshot builder the launch uses, so the announced member count is the
  // one that will actually run.
  const [setPreview, setSetPreview] = useState<SttBenchmarkSetPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  // STT prompt variant creation (issue #121): a valid new variant becomes a new
  // faster-whisper benchmark candidate. The candidate selector (issue #126)
  // surfaces this as a secondary "New prompt" action beside the prompt choice,
  // rather than a permanent list panel, so existing variants are discovered by
  // opening the prompt selector (the catalog already carries them).
  const [newPromptVariantName, setNewPromptVariantName] = useState("");
  const [newPromptVariantDisplayName, setNewPromptVariantDisplayName] = useState("");
  const [newPromptVariantText, setNewPromptVariantText] = useState("");
  const [isCreatingPromptVariant, setIsCreatingPromptVariant] = useState(false);
  const [createPromptVariantError, setCreatePromptVariantError] = useState("");
  const [selectedCandidates, setSelectedCandidates] = useState<BenchmarkCandidateIdentity[]>([]);
  const [launchProgress, setLaunchProgress] = useState<SttBenchmarkSetProgress | null>(null);
  const [launchError, setLaunchError] = useState("");
  const [isRunningExperiment, setIsRunningExperiment] = useState(false);

  // Results: one immutable run at a time (issue #138). The split here is a
  // browse filter over the run list — it never drives a launch, so changing it
  // cannot change what a pending experiment would run.
  const [resultsSplit, setResultsSplit] = useState<SttBenchmarkSetSplit>("validation");
  const [runList, setRunList] = useState<SttBenchmarkRunListEntry[]>([]);
  const [results, setResults] = useState<ResultsState>(emptyResultsState);
  const [runExportSummary, setRunExportSummary] = useState<SttBenchmarkRunExportSummary | null>(null);
  const [runExportError, setRunExportError] = useState("");
  const [isExportingRun, setIsExportingRun] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<SttCandidateSelectionResponse | null>(null);
  const [selectionReasonDraft, setSelectionReasonDraft] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [isSelectingCandidateKey, setIsSelectingCandidateKey] = useState("");

  // Dataset builder (manual two-layer entries, #78). No microphone: either
  // paste a transcription or pick a DicTeX-recorded segment.
  const [builderMode, setBuilderMode] = useState<"paste" | "segment">("paste");
  const [builderSegmentKey, setBuilderSegmentKey] = useState("");
  const [builderRawTranscript, setBuilderRawTranscript] = useState("");
  const [builderLiteral, setBuilderLiteral] = useState("");
  const [builderNotation, setBuilderNotation] = useState("");
  const [builderSplit, setBuilderSplit] = useState<SttBenchmarkSetSplit>("train_candidate_pool");
  const [isSavingBuilderEntry, setIsSavingBuilderEntry] = useState(false);
  const [builderNotice, setBuilderNotice] = useState("");
  const [builderError, setBuilderError] = useState("");

  // Layer 2 prefill from the pipeline (issue #101): fires whenever Layer 1
  // has content, so picking a segment or typing Layer 1 shows the
  // dictionary+regex output (command words spelled out) as a starting point.
  // `lastPrefillRef` tracks the most recent prefill so a fresh one only
  // overwrites Layer 2 when the field still holds an EARLIER auto-prefill (or
  // is empty) — never when the human has typed something else into it. The
  // prefill is always a starting point; what gets saved is whatever is left
  // in the field.
  const [builderNotationPrefill, setBuilderNotationPrefill] = useState("");
  const [isPrefillingLayer2, setIsPrefillingLayer2] = useState(false);
  const [builderPrefillError, setBuilderPrefillError] = useState("");
  const lastPrefillRef = useRef("");

  // Dataset export.
  const [datasetExportSummary, setDatasetExportSummary] = useState<SttDatasetExportSummary | null>(null);
  const [datasetExportError, setDatasetExportError] = useState("");
  const [isExportingDataset, setIsExportingDataset] = useState(false);

  // The error analysis of the SELECTED run, derived from that run's own logged
  // outputs — not from the in-memory outcomes of the last launch, which would
  // show the newest run's errors under an older run's header.
  const errorAnalysis = useMemo(
    () => (results.detail ? analyzeBatchErrors(toSttBenchmarkRunOutcomes(results.detail)) : []),
    [results.detail],
  );
  const experimentStage = getExperimentStage(experimentStageId);
  // Never render or launch from a count fetched for a previous split. The
  // handler below clears it eagerly; this check also protects the small window
  // before React has run the next effect's cleanup.
  const experimentPreview = setPreview?.split === experimentSplit ? setPreview : null;
  const launchPlan = planExperimentLaunch({
    stage: experimentStage,
    split: experimentSplit,
    preview: experimentPreview,
    candidates: selectedCandidates,
    isRunning: isRunningExperiment,
  });
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef("");

  useEffect(() => {
    const removeBatchProgressListener = window.dictexLab.onBatchBenchmarkProgress(setLaunchProgress);
    void refreshDataFolder();
    void window.dictexLab
      .getSttBenchmarkCandidates()
      .then((catalog) => {
        setCandidateCatalog(catalog);
        setSelectedCandidates(catalog.slice(0, 3).map((option) => option.candidate));
      })
      .catch(() => {
        // Non-fatal; the batch selector just shows no candidates.
      });
    void window.dictexLab.getLatestSttCandidateSelection().then(setCurrentSelection).catch(() => {
      // Non-fatal; the panel shows none selected.
    });
    void loadSegments();

    return () => {
      removeBatchProgressListener();
      stopAudioPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracked runs are per-split (issue #122): the Results split filter reloads
  // its own run list. It never touches the current selection here — the launch
  // path sets the split and selects its new run in one go, and a human split
  // change clears the selection in the handler itself.
  useEffect(() => {
    let cancelled = false;
    window.dictexLab
      .listSttBenchmarkRuns(resultsSplit)
      .then((runs) => {
        if (!cancelled) {
          setRunList(runs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRunList([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resultsSplit]);

  // The evaluable member count a launch would freeze. Refreshed when the
  // experiment's split changes and whenever the view comes back to Experiments,
  // since qualifying a Layer 1 or assigning a split happens over in Corpus.
  useEffect(() => {
    if (view !== "experiments") {
      return;
    }

    setSetPreview(null);
    setPreviewError("");
    let cancelled = false;
    window.dictexLab
      .previewSttBenchmarkSet(experimentSplit)
      .then((preview) => {
        if (!cancelled) {
          setSetPreview(preview);
          setPreviewError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSetPreview(null);
          setPreviewError(error instanceof Error ? error.message : "Could not read the corpus for this split");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, experimentSplit]);

  function selectExperimentSplit(split: SttBenchmarkSetSplit): void {
    if (split === experimentSplit) {
      return;
    }

    // The next preview is asynchronous, so remove the old split's count in
    // the same event that changes the selection.
    setExperimentSplit(split);
    setSetPreview(null);
    setPreviewError("");
  }

  // Layer 2 prefill (#101): debounced so it fires once Layer 1 settles rather
  // than on every keystroke. Reads the SOURCE folder's dictionary/rules
  // through the main process (the renderer cannot touch node:fs); the result
  // has already been through the full pipeline and back through
  // restoreCommandWords in the main process, so it is guaranteed sentinel-
  // and newline-free by construction before it ever reaches this component.
  useEffect(() => {
    const trimmed = builderLiteral.trim();
    if (trimmed.length === 0) {
      lastPrefillRef.current = "";
      setBuilderNotationPrefill("");
      setBuilderPrefillError("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setIsPrefillingLayer2(true);
      void window.dictexLab
        .prefillDatasetBuilderLayer2(trimmed)
        .then((prefill) => {
          if (cancelled) {
            return;
          }
          const previousPrefill = lastPrefillRef.current;
          lastPrefillRef.current = prefill;
          setBuilderNotationPrefill(prefill);
          setBuilderPrefillError("");
          // Only overwrite Layer 2 if it is still empty or still holds the
          // PREVIOUS auto-prefill untouched; a human edit is never clobbered.
          setBuilderNotation((current) => (current.length === 0 || current === previousPrefill ? prefill : current));
        })
        .catch((prefillError) => {
          if (cancelled) {
            return;
          }
          setBuilderPrefillError(
            prefillError instanceof Error ? prefillError.message : "Could not prefill Layer 2 from the pipeline",
          );
        })
        .finally(() => {
          if (!cancelled) {
            setIsPrefillingLayer2(false);
          }
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [builderLiteral]);

  async function refreshDataFolder(): Promise<void> {
    try {
      const [status, check] = await Promise.all([
        window.dictexLab.getDataFolder(),
        window.dictexLab.checkDataFolder(),
      ]);
      setDataFolder(status);
      setSourceCheck(check);
    } catch {
      // Non-fatal.
    }
  }

  async function loadSegments(): Promise<void> {
    setSegmentsError("");
    setIsLoadingSegments(true);
    try {
      setSegments(await window.dictexLab.getSegments(50));
      await refreshDataFolder();
    } catch (error) {
      setSegmentsError(error instanceof Error ? error.message : "Could not load segments");
    } finally {
      setIsLoadingSegments(false);
    }
  }

  async function pickDataFolder(): Promise<void> {
    setIsSavingDataFolder(true);
    try {
      const status = await window.dictexLab.pickDataFolder();
      if (status) {
        setDataFolder(status);
        setNotice(`DicTeX data folder set to ${status.path}`);
        await loadSegments();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not set data folder");
    } finally {
      setIsSavingDataFolder(false);
    }
  }

  async function applyDataFolderDraft(): Promise<void> {
    if (dataFolderDraft.trim() === "") {
      return;
    }
    setIsSavingDataFolder(true);
    try {
      const status = await window.dictexLab.setDataFolder(dataFolderDraft.trim());
      setDataFolder(status);
      setDataFolderDraft("");
      setNotice(`DicTeX data folder set to ${status.path}`);
      await loadSegments();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not set data folder");
    } finally {
      setIsSavingDataFolder(false);
    }
  }

  async function resetDataFolder(): Promise<void> {
    setIsSavingDataFolder(true);
    try {
      const status = await window.dictexLab.resetDataFolder();
      setDataFolder(status);
      setNotice(`DicTeX data folder reset to default (${status.path})`);
      await loadSegments();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not reset data folder");
    } finally {
      setIsSavingDataFolder(false);
    }
  }

  function stopAudioPlayback(): void {
    audioPlayerRef.current?.pause();
    audioPlayerRef.current = null;
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = "";
    }
    setPlayingAudioSegmentKey("");
    setLoadingAudioSegmentKey("");
  }

  async function playSegmentAudio(segment: ReconstructedSegment): Promise<void> {
    const segmentKey = getSegmentKey(segment);
    if (playingAudioSegmentKey === segmentKey) {
      stopAudioPlayback();
      return;
    }

    stopAudioPlayback();
    setAudioError("");
    setLoadingAudioSegmentKey(segmentKey);

    try {
      const playback = await window.dictexLab.getSegmentAudio({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      const audioBytes = new Uint8Array(playback.audioBytes);
      const audioBuffer = audioBytes.buffer.slice(
        audioBytes.byteOffset,
        audioBytes.byteOffset + audioBytes.byteLength,
      ) as ArrayBuffer;
      const audioUrl = URL.createObjectURL(new Blob([audioBuffer], { type: playback.mimeType }));
      const player = new Audio(audioUrl);

      audioPlayerRef.current = player;
      audioObjectUrlRef.current = audioUrl;
      player.onended = stopAudioPlayback;
      player.onerror = () => {
        setAudioError(`Could not play ${segment.sessionId} / ${segment.segmentId}`);
        stopAudioPlayback();
      };

      await player.play();
      setPlayingAudioSegmentKey(segmentKey);
    } catch (playError) {
      setAudioError(playError instanceof Error ? playError.message : "Could not play audio segment");
      stopAudioPlayback();
    } finally {
      setLoadingAudioSegmentKey("");
    }
  }

  function startSegmentCorrection(segment: ReconstructedSegment, layer: CorpusCorrectionLayer): void {
    const plan = planCorpusCorrection(segment, layer);
    if (plan === null) {
      setCorrectionNotice("Save Layer 1 before adding Layer 2");
      return;
    }

    setHistoryCorrectionTarget({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      rawTranscript: plan.rawTranscript,
      correctionKind: plan.correctionKind,
    });
    setHistoryCorrectionDraft(plan.draft);
    setCorrectionNotice("");
    setNotice(`Correction target ${segment.sessionId} / ${segment.segmentId}`);
  }

  function cancelSegmentCorrection(): void {
    setHistoryCorrectionTarget(null);
    setHistoryCorrectionDraft("");
  }

  async function saveSegmentCorrection(): Promise<void> {
    if (!historyCorrectionTarget) {
      return;
    }

    setCorrectionNotice("");
    setIsSavingCorrection(true);
    try {
      const saved = await window.dictexLab.saveSttCorrection({
        sessionId: historyCorrectionTarget.sessionId,
        segmentId: historyCorrectionTarget.segmentId,
        audioRef: historyCorrectionTarget.audioRef,
        rawTranscript: historyCorrectionTarget.rawTranscript,
        correctedTranscript: historyCorrectionDraft,
        correctionKind: historyCorrectionTarget.correctionKind,
        correctionMethod: "keyboard",
      });
      setCorrectionNotice(
        `Saved ${formatCorrectionKind(saved.correctionKind)} correction for ${saved.sessionId} / ${saved.segmentId}`,
      );
      cancelSegmentCorrection();
      void loadSegments();
    } catch (saveError) {
      setCorrectionNotice(saveError instanceof Error ? saveError.message : "Could not save correction");
    } finally {
      setIsSavingCorrection(false);
    }
  }

  async function markSttBenchmarkSetMembership(segment: ReconstructedSegment, split: SttBenchmarkSetSplit): Promise<void> {
    if (!segment.correctedTranscript) {
      setSegmentsError("Correct the transcript before adding it to an STT benchmark set");
      return;
    }

    const segmentKey = getSegmentKey(segment);
    setSegmentsError("");
    setBenchmarkSetTargetKey(segmentKey);
    try {
      const marked = await window.dictexLab.markSttBenchmarkSetMembership({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
        split,
      });
      setNotice(`Marked ${marked.sessionId} / ${marked.segmentId} as ${formatBenchmarkSetSplit(marked.split)}`);
      void loadSegments();
    } catch (markError) {
      setSegmentsError(markError instanceof Error ? markError.message : "Could not mark benchmark set membership");
    } finally {
      setBenchmarkSetTargetKey(null);
    }
  }

  async function refreshRunList(split: SttBenchmarkSetSplit): Promise<void> {
    try {
      setRunList(await window.dictexLab.listSttBenchmarkRuns(split));
    } catch {
      setRunList([]);
    }
  }

  /**
   * Selects one result: a tracked run (its own snapshot, outputs, failures and
   * summary) or the legacy bucket of pre-#122 results. The state machine in
   * ./resultsSelection.ts drops the previous run's data before the new data
   * lands and discards a response that no longer answers the current selection,
   * so a run can never be rendered against another run's snapshot.
   */
  async function selectResult(key: string): Promise<void> {
    setResults(startResultsSelection(key));
    setRunExportSummary(null);
    setRunExportError("");

    try {
      if (key === LEGACY_RUN_KEY) {
        const legacy = await window.dictexLab.summarizeLegacySttBenchmarkSet(resultsSplit);
        setResults((current) => applyLegacySummary(current, key, legacy));
        return;
      }

      const detail = await window.dictexLab.getSttBenchmarkRunDetail(key);
      setResults((current) => applyRunDetail(current, key, detail));
    } catch (detailError) {
      const message = detailError instanceof Error ? detailError.message : "Could not read this run";
      setResults((current) => applyResultsError(current, key, message));
    }
  }

  function selectResultsSplit(split: SttBenchmarkSetSplit): void {
    setResultsSplit(split);
    // A run belongs to one split, so browsing another split cannot keep showing
    // the previous run's numbers.
    setResults(emptyResultsState());
    setRunExportSummary(null);
    setRunExportError("");
  }

  /**
   * Launches the announced protocol, then follows the run it created: the new
   * run becomes the selected result and the Lab moves to Results. The launch
   * form keeps no trace of it — a result lives with its run, never in the form
   * that started it.
   */
  async function launchExperiment(): Promise<void> {
    if (!launchPlan.canLaunch) {
      return;
    }

    const split = experimentSplit;
    setLaunchError("");
    setLaunchProgress(null);
    setIsRunningExperiment(true);

    let response: SttBenchmarkSetRunResponse | null = null;
    try {
      response = await window.dictexLab.runSetSttBenchmark(split, selectedCandidates);
    } catch (runError) {
      setLaunchError(runError instanceof Error ? runError.message : "The experiment failed to run");
    } finally {
      setIsRunningExperiment(false);
    }

    const navigation = planLaunchNavigation(response?.runId ?? null);
    if (navigation.view !== "results") {
      return;
    }

    setResultsSplit(split);
    await refreshRunList(split);
    await selectResult(navigation.selectedRunKey);
    setLaunchProgress(null);
    setView("results");
  }

  async function exportSelectedRun(): Promise<void> {
    const runId = results.detail?.runId;
    if (!runId) {
      return;
    }

    setRunExportError("");
    setIsExportingRun(true);
    try {
      setRunExportSummary(await window.dictexLab.exportSttBenchmarkRun(runId));
    } catch (exportError) {
      setRunExportSummary(null);
      setRunExportError(exportError instanceof Error ? exportError.message : "Benchmark run export failed");
    } finally {
      setIsExportingRun(false);
    }
  }

  async function openRunExportFolder(): Promise<void> {
    if (!runExportSummary) {
      return;
    }
    try {
      await window.dictexLab.openExportFolder(runExportSummary.exportDir);
    } catch {
      // Non-fatal convenience.
    }
  }

  async function selectCandidate(candidate: BenchmarkCandidateIdentity): Promise<void> {
    if (selectionReasonDraft.trim() === "") {
      setSelectionError("Enter a selection reason before marking a candidate selected");
      return;
    }

    const candidateKey = formatCandidateIdentityKey(candidate);
    setSelectionError("");
    setIsSelectingCandidateKey(candidateKey);
    try {
      const selection = await window.dictexLab.selectSttCandidate({
        candidate,
        selectionReason: selectionReasonDraft.trim(),
      });
      setCurrentSelection(selection);
      setSelectionReasonDraft("");
    } catch (selectionSaveError) {
      setSelectionError(
        selectionSaveError instanceof Error ? selectionSaveError.message : "Could not save candidate selection",
      );
    } finally {
      setIsSelectingCandidateKey("");
    }
  }

  async function refreshCandidateCatalog(): Promise<void> {
    try {
      const catalog = await window.dictexLab.getSttBenchmarkCandidates();
      setCandidateCatalog(catalog);
    } catch {
      // Non-fatal; the batch selector keeps its previous catalog.
    }
  }

  // Creating a variant (issue #121) immediately refreshes the candidate catalog,
  // since a newly-defined variant becomes a new faster-whisper benchmark
  // candidate for every configured model — the prompt selector (issue #126)
  // then offers it right away. Returns whether creation succeeded so the caller
  // can collapse its inline form only on success (a rejected id keeps its
  // values and error visible, immutability rules unchanged).
  async function createPromptVariant(): Promise<boolean> {
    setCreatePromptVariantError("");
    setIsCreatingPromptVariant(true);
    try {
      await window.dictexLab.createSttPromptVariant({
        name: newPromptVariantName.trim(),
        displayName: newPromptVariantDisplayName.trim(),
        promptText: newPromptVariantText.trim(),
      });
      setNewPromptVariantName("");
      setNewPromptVariantDisplayName("");
      setNewPromptVariantText("");
      await refreshCandidateCatalog();
      return true;
    } catch (createError) {
      setCreatePromptVariantError(
        createError instanceof Error ? createError.message : "Could not create the STT prompt variant",
      );
      return false;
    } finally {
      setIsCreatingPromptVariant(false);
    }
  }

  async function saveDatasetBuilderEntry(): Promise<void> {
    setBuilderError("");
    setBuilderNotice("");

    const literal = builderLiteral.trim();
    if (literal.length === 0) {
      setBuilderError("Layer 1 (literal transcript) is required");
      return;
    }

    let source: DatasetBuilderSource;
    let rawTranscript: string;

    if (builderMode === "segment") {
      const segment = segments.find((candidate) => getSegmentKey(candidate) === builderSegmentKey);
      if (!segment) {
        setBuilderError("Pick a DicTeX segment first");
        return;
      }
      source = { mode: "segment", sessionId: segment.sessionId, segmentId: segment.segmentId, audioRef: segment.audioRef };
      rawTranscript = segment.transcript;
    } else {
      source = { mode: "paste" };
      rawTranscript = builderRawTranscript.trim();
    }

    const notation = builderNotation.trim();
    // Mirror planDatasetBuilderSave's own "nothing to save" rule exactly (see
    // apps/lab/src/main/datasetBuilder.ts): a "paste" source has no audio and
    // can NEVER save an acoustic pair, no matter how much raw text it has —
    // only Layer 2 (math_transform) can save it. Checking this here (with the
    // same wording the main process would throw) surfaces the real rule
    // before a round trip, instead of a generic message that could imply a
    // pasted raw transcript alone is enough.
    const willSaveAcoustic = rawTranscript.length > 0 && builderMode === "segment";
    const willSaveMathTransform = notation.length > 0;
    if (!willSaveAcoustic && !willSaveMathTransform) {
      setBuilderError(
        builderMode === "segment"
          ? "Nothing to save: the picked segment has no raw transcript for the acoustic layer, and Layer 2 (notation) is empty."
          : "Nothing to save: a pasted (no-audio) entry needs Layer 2 (notation) to build a math_transform pair. Pick a recorded segment if you want an acoustic (audio -> literal) pair.",
      );
      return;
    }

    setIsSavingBuilderEntry(true);
    try {
      const response = await window.dictexLab.saveDatasetBuilderEntry({
        source,
        rawTranscript,
        literalTranscript: literal,
        notationTranscript: notation,
        split: builderSplit,
      });
      const savedLayers = [
        response.savedAcoustic ? formatDatasetCorrectionKind("acoustic") : null,
        response.savedMathTransform ? formatDatasetCorrectionKind("math_transform") : null,
      ].filter((layer): layer is string => layer !== null);
      setBuilderNotice(
        `Saved ${savedLayers.join(" + ")} -> ${formatBenchmarkSetSplit(response.split)} (${response.sessionId} / ${response.segmentId})`,
      );
      setBuilderNotation("");
      lastPrefillRef.current = "";
      setBuilderNotationPrefill("");
      setBuilderPrefillError("");
      if (builderMode === "paste") {
        setBuilderRawTranscript("");
        setBuilderLiteral("");
      }
      void loadSegments();
    } catch (saveError) {
      setBuilderError(saveError instanceof Error ? saveError.message : "Could not save dataset entry");
    } finally {
      setIsSavingBuilderEntry(false);
    }
  }

  async function exportSttDataset(): Promise<void> {
    setIsExportingDataset(true);
    setDatasetExportError("");
    try {
      setDatasetExportSummary(await window.dictexLab.exportSttDataset());
    } catch (exportError) {
      setDatasetExportError(exportError instanceof Error ? exportError.message : "Dataset export failed");
    } finally {
      setIsExportingDataset(false);
    }
  }

  async function openExportFolder(): Promise<void> {
    try {
      await window.dictexLab.openExportFolder(datasetExportSummary?.exportDir ?? undefined);
    } catch {
      // Non-fatal convenience.
    }
  }

  if (view === "experiments") {
    return (
      <main className="app-shell">
        <ExperimentsView
          candidateCatalog={candidateCatalog}
          stageId={experimentStageId}
          setStageId={setExperimentStageId}
          stage={experimentStage}
          split={experimentSplit}
          setSplit={selectExperimentSplit}
          preview={experimentPreview}
          previewError={previewError}
          selectedCandidates={selectedCandidates}
          setSelectedCandidates={setSelectedCandidates}
          launchPlan={launchPlan}
          isRunning={isRunningExperiment}
          launchProgress={launchProgress}
          launchError={launchError}
          launchExperiment={() => void launchExperiment()}
          newPromptVariantName={newPromptVariantName}
          setNewPromptVariantName={setNewPromptVariantName}
          newPromptVariantDisplayName={newPromptVariantDisplayName}
          setNewPromptVariantDisplayName={setNewPromptVariantDisplayName}
          newPromptVariantText={newPromptVariantText}
          setNewPromptVariantText={setNewPromptVariantText}
          isCreatingPromptVariant={isCreatingPromptVariant}
          createPromptVariantError={createPromptVariantError}
          createPromptVariant={createPromptVariant}
          onNavigate={setView}
        />
      </main>
    );
  }

  if (view === "results") {
    return (
      <main className="app-shell">
        <ResultsView
          split={resultsSplit}
          setSplit={selectResultsSplit}
          runList={runList}
          results={results}
          selectResult={(key) => void selectResult(key)}
          errorAnalysis={errorAnalysis}
          runExportSummary={runExportSummary}
          runExportError={runExportError}
          isExportingRun={isExportingRun}
          exportSelectedRun={() => void exportSelectedRun()}
          openRunExportFolder={() => void openRunExportFolder()}
          currentSelection={currentSelection}
          selectionReasonDraft={selectionReasonDraft}
          setSelectionReasonDraft={(value) => {
            setSelectionReasonDraft(value);
            setSelectionError("");
          }}
          selectionError={selectionError}
          isSelectingCandidateKey={isSelectingCandidateKey}
          selectCandidate={(candidate) => void selectCandidate(candidate)}
          onNavigate={setView}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <SegmentsView
        dataFolder={dataFolder}
        sourceCheck={sourceCheck}
        dataFolderDraft={dataFolderDraft}
        setDataFolderDraft={setDataFolderDraft}
        isSavingDataFolder={isSavingDataFolder}
        pickDataFolder={() => void pickDataFolder()}
        applyDataFolderDraft={() => void applyDataFolderDraft()}
        resetDataFolder={() => void resetDataFolder()}
        segments={segments}
        segmentsError={segmentsError}
        isLoadingSegments={isLoadingSegments}
        loadSegments={() => void loadSegments()}
        audioError={audioError}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        playSegmentAudio={(segment) => void playSegmentAudio(segment)}
        benchmarkSetTargetKey={benchmarkSetTargetKey}
        markSttBenchmarkSetMembership={(segment, split) => void markSttBenchmarkSetMembership(segment, split)}
        startSegmentCorrection={startSegmentCorrection}
        isSavingCorrection={isSavingCorrection}
        historyCorrectionTarget={historyCorrectionTarget}
        historyCorrectionDraft={historyCorrectionDraft}
        setHistoryCorrectionDraft={(value) => {
          setHistoryCorrectionDraft(value);
          setCorrectionNotice("");
        }}
        saveSegmentCorrection={() => void saveSegmentCorrection()}
        cancelSegmentCorrection={cancelSegmentCorrection}
        correctionNotice={correctionNotice}
        notice={notice}
        openLabDataFolder={() => void window.dictexLab.openLabDataFolder()}
        openSourceDataFolder={() => void window.dictexLab.openSourceDataFolder()}
        openLabEventsLog={() => void window.dictexLab.openLabEventsLog()}
        onNavigate={setView}
      />
      <DatasetView
        embedded
        segments={segments}
        loadSegments={() => void loadSegments()}
        isLoadingSegments={isLoadingSegments}
        playSegmentAudio={(segment) => void playSegmentAudio(segment)}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        audioError={audioError}
        builderMode={builderMode}
        setBuilderMode={setBuilderMode}
        builderSegmentKey={builderSegmentKey}
        setBuilderSegmentKey={setBuilderSegmentKey}
        builderRawTranscript={builderRawTranscript}
        setBuilderRawTranscript={setBuilderRawTranscript}
        builderLiteral={builderLiteral}
        setBuilderLiteral={setBuilderLiteral}
        builderNotation={builderNotation}
        setBuilderNotation={setBuilderNotation}
        builderNotationPrefill={builderNotationPrefill}
        isPrefillingLayer2={isPrefillingLayer2}
        builderPrefillError={builderPrefillError}
        builderSplit={builderSplit}
        setBuilderSplit={setBuilderSplit}
        isSavingBuilderEntry={isSavingBuilderEntry}
        builderNotice={builderNotice}
        builderError={builderError}
        saveDatasetBuilderEntry={() => void saveDatasetBuilderEntry()}
        exportSttDataset={() => void exportSttDataset()}
        openExportFolder={() => void openExportFolder()}
        isExportingDataset={isExportingDataset}
        datasetExportSummary={datasetExportSummary}
        datasetExportError={datasetExportError}
      />
    </main>
  );
}

type SegmentsViewProps = {
  dataFolder: DataFolderStatus | null;
  sourceCheck: SourceFolderCheck | null;
  dataFolderDraft: string;
  setDataFolderDraft: (value: string) => void;
  isSavingDataFolder: boolean;
  pickDataFolder: () => void;
  applyDataFolderDraft: () => void;
  resetDataFolder: () => void;
  segments: ReconstructedSegment[];
  segmentsError: string;
  isLoadingSegments: boolean;
  loadSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playSegmentAudio: (segment: ReconstructedSegment) => void;
  benchmarkSetTargetKey: string | null;
  markSttBenchmarkSetMembership: (segment: ReconstructedSegment, split: SttBenchmarkSetSplit) => void;
  startSegmentCorrection: (segment: ReconstructedSegment, layer: CorpusCorrectionLayer) => void;
  isSavingCorrection: boolean;
  historyCorrectionTarget: HistoryCorrectionTarget | null;
  historyCorrectionDraft: string;
  setHistoryCorrectionDraft: (value: string) => void;
  saveSegmentCorrection: () => void;
  cancelSegmentCorrection: () => void;
  correctionNotice: string;
  notice: string;
  openLabDataFolder: () => void;
  openSourceDataFolder: () => void;
  openLabEventsLog: () => void;
  onNavigate: (view: View) => void;
};

function SegmentsView({
  dataFolder,
  sourceCheck,
  dataFolderDraft,
  setDataFolderDraft,
  isSavingDataFolder,
  pickDataFolder,
  applyDataFolderDraft,
  resetDataFolder,
  segments,
  segmentsError,
  isLoadingSegments,
  loadSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playSegmentAudio,
  benchmarkSetTargetKey,
  markSttBenchmarkSetMembership,
  startSegmentCorrection,
  isSavingCorrection,
  historyCorrectionTarget,
  historyCorrectionDraft,
  setHistoryCorrectionDraft,
  saveSegmentCorrection,
  cancelSegmentCorrection,
  correctionNotice,
  notice,
  openLabDataFolder,
  openSourceDataFolder,
  openLabEventsLog,
  onNavigate,
}: SegmentsViewProps): React.ReactElement {
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  const selectedSegment =
    segments.find((segment) => getSegmentKey(segment) === selectedSegmentKey) ?? segments[0] ?? null;
  const acousticCorrection = selectedSegment?.correctionsByKind.find(
    (correction) => correction.correctionKind === "acoustic",
  );
  const mathTransformCorrection = selectedSegment?.correctionsByKind.find(
    (correction) => correction.correctionKind === "math_transform",
  );
  const qualificationState =
    acousticCorrection && mathTransformCorrection
      ? "Layers 1 and 2 qualified"
      : acousticCorrection
        ? "Layer 1 only"
        : "No human layers";

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Corpus</h1>
        </div>
        <div className={`status-pill ${sourceCheck?.eventsFound ? "status-copied" : "status-error"}`}>
          {sourceCheck === null ? "checking" : sourceCheck.eventsFound ? "data folder ok" : "no events found"}
        </div>
      </header>

      <LabNavigation activeView="corpus" onNavigate={onNavigate} />

      <section className="panel controls-panel">
        <h2>DicTeX data folder (read-only source)</h2>
        <p className="benchmark-models" title={dataFolder?.path ?? undefined}>
          {dataFolder ? dataFolder.path : "loading…"}
          {dataFolder?.isDefault ? " (default)" : ""}
        </p>
        {sourceCheck && !sourceCheck.exists && (
          <p className="error">The configured folder does not exist. Pick DicTeX's data folder.</p>
        )}
        {sourceCheck && sourceCheck.exists && !sourceCheck.eventsFound && (
          <p className="notice">Folder found, but no events.jsonl yet. Record a dictation in DicTeX first.</p>
        )}
        <div className="actions">
          <button className="secondary-button" disabled={isSavingDataFolder} onClick={pickDataFolder}>
            Choose folder…
          </button>
          <input
            aria-label="DicTeX data folder path"
            className="reason-input"
            placeholder="…or paste an absolute path"
            value={dataFolderDraft}
            onChange={(event) => setDataFolderDraft(event.target.value)}
          />
          <button
            className="secondary-button"
            disabled={isSavingDataFolder || dataFolderDraft.trim() === ""}
            onClick={applyDataFolderDraft}
          >
            Apply
          </button>
          <button
            className="secondary-button"
            disabled={isSavingDataFolder || dataFolder?.isDefault === true}
            onClick={resetDataFolder}
          >
            Reset to default
          </button>
          <button className="secondary-button" onClick={openSourceDataFolder}>
            Open source folder
          </button>
        </div>
        {notice && <p className="notice">{notice}</p>}
      </section>

      <section className="panel corpus-master-detail" aria-busy={isLoadingSegments}>
        <div className="corpus-segment-list">
        <div className="panel-header">
          <div>
            <h2>DicTeX segments</h2>
            <p>{segments.length > 0 ? `${segments.length} segments` : "Read from the DicTeX data folder"}</p>
          </div>
          <button className="secondary-button" disabled={isLoadingSegments} onClick={loadSegments}>
            {isLoadingSegments ? "Loading" : "Refresh"}
          </button>
        </div>

        {segmentsError && <pre className="error">{segmentsError}</pre>}
        {audioError && <pre className="error">{audioError}</pre>}

        {segments.length === 0 && !segmentsError ? (
          <p className="empty-state">
            No stored dictation segments found in the DicTeX data folder. Record a dictation in DicTeX, then click
            Refresh above.
          </p>
        ) : (
          <div className="history-list">
            {segments.map((segment) => (
              <article
                className={`history-item corpus-segment-item ${getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment) ? "corpus-segment-item-selected" : ""}`}
                key={getSegmentKey(segment)}
              >
                <div className="history-heading">
                  <span title={segment.createdAt ?? undefined}>{formatTimestamp(segment.createdAt)}</span>
                  <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
                    {segment.sessionId} / {segment.segmentId}
                  </strong>
                  <em className={segment.correctedTranscript ? "correction-state correction-state-done" : "correction-state"}>
                    {segment.correctedTranscript ? "corrected" : "raw"}
                  </em>
                </div>

                {segment.correctedTranscript ? (
                  <div className="history-transcripts">
                    <p className="history-transcript history-transcript-corrected">{segment.correctedTranscript}</p>
                    <p className="history-raw-transcript">Raw: {segment.transcript || "-"}</p>
                  </div>
                ) : (
                  <p className="history-transcript">{segment.transcript || "-"}</p>
                )}

                <div className="history-footer">
                  <div className="history-meta">
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds)}</span>
                    <span>{formatLatency(segment.transcriptionDurationMs)}</span>
                    {segment.correctionKind && (
                      <span className="correction-kind-state" title={`Correction kind: ${formatCorrectionKind(segment.correctionKind)}`}>
                        {formatCorrectionKind(segment.correctionKind)}
                      </span>
                    )}
                    {segment.benchmarkSetSplit && (
                      <span className="benchmark-set-state" title={segment.benchmarkSetCreatedAt ?? undefined}>
                        {formatBenchmarkSetSplit(segment.benchmarkSetSplit)}
                      </span>
                    )}
                  </div>
                  <div className="history-actions">
                    <button
                      className="secondary-button"
                      aria-pressed={getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment)}
                      onClick={() => setSelectedSegmentKey(getSegmentKey(segment))}
                    >
                      {getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment) ? "Selected" : "Select"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        </div>

        <aside className="corpus-detail" aria-live="polite">
          {selectedSegment === null ? (
            <p className="empty-state">Select a DicTeX segment to inspect and qualify it.</p>
          ) : (
            <>
              <div className="panel-header">
                <div>
                  <h2>Selected segment</h2>
                  <p title={`${selectedSegment.sessionId} / ${selectedSegment.segmentId}`}>
                    {selectedSegment.sessionId} / {selectedSegment.segmentId}
                  </p>
                </div>
                <em className={`qualification-state ${acousticCorrection ? "qualification-state-partial" : ""} ${acousticCorrection && mathTransformCorrection ? "qualification-state-complete" : ""}`}>
                  {qualificationState}
                </em>
              </div>

              <dl className="corpus-provenance">
                <div><dt>Recorded</dt><dd>{formatTimestamp(selectedSegment.createdAt)}</dd></div>
                <div><dt>STT</dt><dd>{selectedSegment.sttEngine} / {selectedSegment.sttModel} · {selectedSegment.sttLanguage}</dd></div>
                <div><dt>Audio</dt><dd>{formatAudioDuration(selectedSegment.audioDurationSeconds)}</dd></div>
                <div><dt>Split</dt><dd>{selectedSegment.benchmarkSetSplit ? `${formatBenchmarkSetSplit(selectedSegment.benchmarkSetSplit)}${selectedSegment.benchmarkSetCreatedAt ? ` · ${formatTimestamp(selectedSegment.benchmarkSetCreatedAt)}` : ""}` : "Not assigned"}</dd></div>
              </dl>

              <section className="corpus-layer">
                <h3>Raw STT</h3>
                <p>{selectedSegment.transcript || "-"}</p>
              </section>
              <section className="corpus-layer">
                <h3>Layer 1 — acoustic</h3>
                <p>{acousticCorrection?.correctedTranscript ?? "Not qualified yet"}</p>
              </section>
              <section className="corpus-layer">
                <h3>Layer 2 — math transform</h3>
                <p>{mathTransformCorrection?.correctedTranscript ?? "Not qualified yet"}</p>
              </section>

              <div className="actions">
                <button
                  className="secondary-button"
                  disabled={!selectedSegment.audioRef || loadingAudioSegmentKey === getSegmentKey(selectedSegment)}
                  onClick={() => playSegmentAudio(selectedSegment)}
                >
                  {loadingAudioSegmentKey === getSegmentKey(selectedSegment)
                    ? "Loading"
                    : playingAudioSegmentKey === getSegmentKey(selectedSegment)
                      ? "Stop"
                      : "Play audio"}
                </button>
                <select
                  aria-label={`Benchmark set split for selected ${selectedSegment.sessionId} / ${selectedSegment.segmentId}`}
                  className="secondary-select"
                  disabled={!selectedSegment.correctedTranscript || benchmarkSetTargetKey === getSegmentKey(selectedSegment)}
                  value={selectedSegment.benchmarkSetSplit ?? ""}
                  onChange={(event) => {
                    const split = event.currentTarget.value;
                    if (isSttBenchmarkSetSplit(split)) {
                      markSttBenchmarkSetMembership(selectedSegment, split);
                    }
                  }}
                >
                  <option value="">Set split</option>
                  <option value="train_candidate_pool">Train pool</option>
                  <option value="validation">Validation</option>
                  <option value="test_frozen">Test frozen</option>
                </select>
                <button className="secondary-button" disabled={isSavingCorrection} onClick={() => startSegmentCorrection(selectedSegment, "layer1")}>
                  Edit Layer 1
                </button>
                <button
                  className="secondary-button"
                  disabled={isSavingCorrection || !acousticCorrection}
                  title={acousticCorrection ? undefined : "Save Layer 1 before adding Layer 2"}
                  onClick={() => startSegmentCorrection(selectedSegment, "layer2")}
                >
                  Edit Layer 2
                </button>
              </div>

              {historyCorrectionTarget && getSegmentKey(historyCorrectionTarget) === getSegmentKey(selectedSegment) && (
                <div className="corpus-correction-editor">
                  <p className="transcript-label">
                    {historyCorrectionTarget.correctionKind === "acoustic" ? "Layer 1" : "Layer 2"} —{" "}
                    {formatCorrectionKind(historyCorrectionTarget.correctionKind)}
                  </p>
                  <p className="corpus-correction-input" title={historyCorrectionTarget.rawTranscript}>
                    From: {historyCorrectionTarget.rawTranscript || "-"}
                  </p>
                  <textarea
                    value={historyCorrectionDraft}
                    onChange={(event) => setHistoryCorrectionDraft(event.target.value)}
                    aria-label={`Corrected transcript (${formatCorrectionKind(historyCorrectionTarget.correctionKind)})`}
                  />
                  <div className="actions">
                    <button
                      className="secondary-button"
                      disabled={isSavingCorrection || historyCorrectionDraft.length === 0}
                      onClick={saveSegmentCorrection}
                    >
                      {isSavingCorrection ? "Saving" : "Save correction"}
                    </button>
                    <button className="secondary-button" disabled={isSavingCorrection} onClick={cancelSegmentCorrection}>Cancel</button>
                  </div>
                  {correctionNotice && <p className="notice">{correctionNotice}</p>}
                </div>
              )}
            </>
          )}
        </aside>
      </section>

      <section className="panel transcript-panel">
        <div className="actions">
          <button className="secondary-button" onClick={openLabDataFolder}>
            Open Lab data folder
          </button>
          <button className="secondary-button" onClick={openLabEventsLog}>
            Open Lab events log
          </button>
        </div>
        <p className="empty-state">
          The Lab reads DicTeX's folder read-only and writes corrections, splits, benchmark results, selections, and
          exports only into its own store.
        </p>
      </section>
    </>
  );
}

/**
 * A chosen model in the progressive candidate selector (issue #126): a
 * provider + model pair, compared by value so no fragile separator-joined
 * string key is needed.
 */
type ModelChoice = { providerLabel: string; modelLabel: string };

function sameModel(a: ModelChoice, b: ModelChoice): boolean {
  return a.providerLabel === b.providerLabel && a.modelLabel === b.modelLabel;
}

function optionMatchesModel(option: SttBenchmarkCandidateOption, model: ModelChoice): boolean {
  return sameModel({ providerLabel: option.providerLabel, modelLabel: option.modelLabel }, model);
}

/**
 * Distinct models across the catalog, grouped by provider, order preserved —
 * feeds the progressive selector's model list (issue #126). The renderer never
 * hardcodes a candidate list, it only groups whatever `getSttBenchmarkCandidates`
 * returns.
 */
function groupModelsByProvider(
  catalog: SttBenchmarkCandidateOption[],
): { providerLabel: string; models: ModelChoice[] }[] {
  const byProvider = new Map<string, ModelChoice[]>();
  for (const option of catalog) {
    const models = byProvider.get(option.providerLabel) ?? [];
    if (!models.some((model) => model.modelLabel === option.modelLabel)) {
      models.push({ providerLabel: option.providerLabel, modelLabel: option.modelLabel });
    }
    byProvider.set(option.providerLabel, models);
  }
  return Array.from(byProvider.entries()).map(([providerLabel, models]) => ({ providerLabel, models }));
}

/** Distinct runtime labels among a chosen model's options, order preserved. */
function runtimeLabelsFor(options: SttBenchmarkCandidateOption[]): string[] {
  const seen: string[] = [];
  for (const option of options) {
    if (!seen.includes(option.runtimeLabel)) {
      seen.push(option.runtimeLabel);
    }
  }
  return seen;
}

/** The 1-3 rule of #126, kept in one place with the launch gate that enforces it. */
const MAX_CANDIDATES = MAX_EXPERIMENT_CANDIDATES;

type CandidateSelectorProps = {
  catalog: SttBenchmarkCandidateOption[];
  selectedCandidates: BenchmarkCandidateIdentity[];
  setSelectedCandidates: React.Dispatch<React.SetStateAction<BenchmarkCandidateIdentity[]>>;
  disabled: boolean;
  newPromptVariantName: string;
  setNewPromptVariantName: (value: string) => void;
  newPromptVariantDisplayName: string;
  setNewPromptVariantDisplayName: (value: string) => void;
  newPromptVariantText: string;
  setNewPromptVariantText: (value: string) => void;
  isCreatingPromptVariant: boolean;
  createPromptVariantError: string;
  createPromptVariant: () => Promise<boolean>;
};

/**
 * Progressive STT candidate selector (issue #126). Replaces the flat checkbox
 * grid: a compact list of the 1-3 selected candidates (each shown by model,
 * runtime and prompt, with Replace/Remove), plus an "add or replace" flow that
 * picks a model first (bounded, scrollable list), then runtime and prompt as
 * separate controls that each collapse once chosen, and shows the selected
 * prompt text read-only. It only ever offers fully-executable identities from
 * the real catalog — it never synthesizes an absent model/runtime/prompt
 * combination. A provider with no `initial_prompt` (Vosk) hides the prompt
 * choice instead of inventing a baseline. Creating a variant is a secondary
 * "New prompt" action beside the prompt choice, not a permanent panel.
 */
function CandidateSelector({
  catalog,
  selectedCandidates,
  setSelectedCandidates,
  disabled,
  newPromptVariantName,
  setNewPromptVariantName,
  newPromptVariantDisplayName,
  setNewPromptVariantDisplayName,
  newPromptVariantText,
  setNewPromptVariantText,
  isCreatingPromptVariant,
  createPromptVariantError,
  createPromptVariant,
}: CandidateSelectorProps): React.ReactElement {
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [draftModel, setDraftModel] = useState<ModelChoice | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<string | null>(null);
  const [draftCandidateKey, setDraftCandidateKey] = useState<string | null>(null);
  const [openControl, setOpenControl] = useState<"model" | "runtime" | "prompt" | null>(null);
  const [showNewPrompt, setShowNewPrompt] = useState(false);

  const optionByKey = useMemo(() => {
    const map = new Map<string, SttBenchmarkCandidateOption>();
    for (const option of catalog) {
      map.set(formatCandidateIdentityKey(option.candidate), option);
    }
    return map;
  }, [catalog]);
  const providers = useMemo(() => groupModelsByProvider(catalog), [catalog]);
  const modelOptions = useMemo(
    () => (draftModel ? catalog.filter((option) => optionMatchesModel(option, draftModel)) : []),
    [catalog, draftModel],
  );
  const runtimeOptions = useMemo(() => runtimeLabelsFor(modelOptions), [modelOptions]);
  const supportsPrompt = modelOptions.length > 0 && modelOptions[0].supportsPrompt;
  const promptOptions = useMemo(
    () => modelOptions.filter((option) => option.runtimeLabel === draftRuntime),
    [modelOptions, draftRuntime],
  );

  const selectedKeys = selectedCandidates.map((candidate) => formatCandidateIdentityKey(candidate));
  const draftOption = draftCandidateKey ? optionByKey.get(draftCandidateKey) ?? null : null;
  // A resolved draft already in the selection (other than the slot being
  // replaced) would be a duplicate identity — block confirming it.
  const draftIsDuplicate =
    draftCandidateKey !== null &&
    selectedKeys.some(
      (key, index) => key === draftCandidateKey && !(replaceIndex !== null && index === replaceIndex),
    );
  const atAddLimit = replaceIndex === null && selectedCandidates.length >= MAX_CANDIDATES;

  function resetDraft(): void {
    setDraftModel(null);
    setDraftRuntime(null);
    setDraftCandidateKey(null);
    setOpenControl(null);
    setShowNewPrompt(false);
  }

  function startPick(index: number | null): void {
    setReplaceIndex(index);
    resetDraft();
    setIsPicking(true);
    setOpenControl("model");
  }

  function cancelPick(): void {
    setIsPicking(false);
    setReplaceIndex(null);
    resetDraft();
  }

  function chooseModel(model: ModelChoice): void {
    const options = catalog.filter((option) => optionMatchesModel(option, model));
    const runtimes = runtimeLabelsFor(options);
    const soleRuntime = runtimes.length === 1 ? runtimes[0] : null;
    const providerSupportsPrompt = options.length > 0 && options[0].supportsPrompt;
    setDraftModel(model);
    setDraftRuntime(soleRuntime);
    setShowNewPrompt(false);
    // A provider with no prompt concept (Vosk) has a single baseline candidate
    // per runtime; resolve it directly so the pick is immediately confirmable.
    if (!providerSupportsPrompt && soleRuntime) {
      const baseline = options.find((option) => option.runtimeLabel === soleRuntime) ?? null;
      setDraftCandidateKey(baseline ? formatCandidateIdentityKey(baseline.candidate) : null);
    } else {
      setDraftCandidateKey(null);
    }
    setOpenControl(null);
  }

  function chooseRuntime(runtime: string): void {
    setDraftRuntime(runtime);
    setDraftCandidateKey(null);
    setOpenControl(null);
  }

  function choosePrompt(candidateKey: string): void {
    setDraftCandidateKey(candidateKey);
    setOpenControl(null);
  }

  function confirmDraft(): void {
    if (!draftOption || draftIsDuplicate || atAddLimit) {
      return;
    }
    const chosen = draftOption.candidate;
    setSelectedCandidates((current) => {
      if (replaceIndex !== null) {
        return current.map((candidate, index) => (index === replaceIndex ? chosen : candidate));
      }
      return [...current, chosen];
    });
    cancelPick();
  }

  function removeCandidate(index: number): void {
    setSelectedCandidates((current) => current.filter((_, i) => i !== index));
  }

  async function submitNewPrompt(): Promise<void> {
    const created = await createPromptVariant();
    if (created) {
      // The catalog now carries the new variant under the current model; reopen
      // the prompt list so it can be picked right away.
      setShowNewPrompt(false);
      setOpenControl("prompt");
    }
  }

  if (catalog.length === 0) {
    return <p className="empty-state">No STT benchmark candidates configured.</p>;
  }

  const canCreatePrompt =
    !isCreatingPromptVariant &&
    newPromptVariantName.trim().length > 0 &&
    newPromptVariantDisplayName.trim().length > 0 &&
    newPromptVariantText.trim().length > 0;

  return (
    <div className="candidate-selector">
      <ul className="candidate-chips" aria-label="Selected STT candidates (1-3)">
        {selectedCandidates.map((candidate, index) => {
          const option = optionByKey.get(formatCandidateIdentityKey(candidate));
          return (
            <li className="candidate-chip" key={`${formatCandidateIdentityKey(candidate)}-${index}`}>
              <div className="candidate-chip-labels">
                <strong>{option ? option.modelLabel : candidate.model}</strong>
                <span className="candidate-chip-meta">
                  {option ? option.runtimeLabel : candidate.variant ?? ""} · {option ? option.variantLabel : "?"}
                </span>
              </div>
              <div className="candidate-chip-actions">
                <button className="secondary-button" disabled={disabled} onClick={() => startPick(index)}>
                  Replace
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled || selectedCandidates.length <= 1}
                  title={selectedCandidates.length <= 1 ? "Keep at least one candidate" : undefined}
                  onClick={() => removeCandidate(index)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {!isPicking && (
        <div className="candidate-add">
          <button
            className="secondary-button"
            disabled={disabled || selectedCandidates.length >= MAX_CANDIDATES}
            onClick={() => startPick(null)}
          >
            Add a candidate
          </button>
          {selectedCandidates.length >= MAX_CANDIDATES && (
            <span className="candidate-hint">Maximum 3 — replace or remove one to add another.</span>
          )}
        </div>
      )}

      {isPicking && (
        <div className="candidate-picker">
          <div className="candidate-picker-header">
            <strong>{replaceIndex !== null ? `Replace candidate ${replaceIndex + 1}` : "Add a candidate"}</strong>
            <button className="secondary-button" disabled={disabled} onClick={cancelPick}>
              Cancel
            </button>
          </div>

          <div className="candidate-control">
            <button
              className="candidate-control-toggle"
              aria-expanded={openControl === "model"}
              disabled={disabled}
              onClick={() => setOpenControl(openControl === "model" ? null : "model")}
            >
              Model: {draftModel ? draftModel.modelLabel : "choose…"}
            </button>
            {openControl === "model" && (
              <div className="candidate-option-list" role="listbox" aria-label="Model">
                {providers.map((group) => (
                  <div className="candidate-option-group" key={group.providerLabel}>
                    <span className="candidate-option-group-label">{group.providerLabel}</span>
                    {group.models.map((model) => (
                      <button
                        key={`${model.providerLabel}/${model.modelLabel}`}
                        type="button"
                        role="option"
                        aria-selected={draftModel !== null && sameModel(draftModel, model)}
                        className="candidate-option"
                        onClick={() => chooseModel(model)}
                      >
                        {model.modelLabel}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {draftModel && (
            <div className="candidate-control-row">
              <div className="candidate-control">
                <button
                  className="candidate-control-toggle"
                  aria-expanded={openControl === "runtime"}
                  disabled={disabled || runtimeOptions.length <= 1}
                  onClick={() => setOpenControl(openControl === "runtime" ? null : "runtime")}
                >
                  Runtime: {draftRuntime ?? "choose…"}
                </button>
                {openControl === "runtime" && runtimeOptions.length > 1 && (
                  <div className="candidate-option-list" role="listbox" aria-label="Runtime variant">
                    {runtimeOptions.map((runtime) => (
                      <button
                        key={runtime}
                        type="button"
                        role="option"
                        aria-selected={draftRuntime === runtime}
                        className="candidate-option"
                        onClick={() => chooseRuntime(runtime)}
                      >
                        {runtime}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {supportsPrompt ? (
                <div className="candidate-control">
                  <div className="candidate-control-head">
                    <button
                      className="candidate-control-toggle"
                      aria-expanded={openControl === "prompt"}
                      disabled={disabled || !draftRuntime}
                      onClick={() => setOpenControl(openControl === "prompt" ? null : "prompt")}
                    >
                      Prompt: {draftOption ? draftOption.variantLabel : "choose…"}
                    </button>
                    <button
                      className="secondary-button candidate-new-prompt"
                      disabled={disabled}
                      aria-expanded={showNewPrompt}
                      onClick={() => setShowNewPrompt((value) => !value)}
                    >
                      New prompt
                    </button>
                  </div>
                  {openControl === "prompt" && draftRuntime && (
                    <div className="candidate-option-list" role="listbox" aria-label="Prompt">
                      {promptOptions.map((option) => {
                        const key = formatCandidateIdentityKey(option.candidate);
                        return (
                          <button
                            key={key}
                            type="button"
                            role="option"
                            aria-selected={draftCandidateKey === key}
                            className="candidate-option"
                            onClick={() => choosePrompt(key)}
                          >
                            {option.variantLabel}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="candidate-no-prompt">No prompt — this provider has no initial_prompt.</p>
              )}
            </div>
          )}

          {showNewPrompt && supportsPrompt && (
            <div className="prompt-variant-form">
              <input
                aria-label="New prompt variant id"
                placeholder="id (e.g. prompt-v3-fr-math)"
                value={newPromptVariantName}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantName(event.target.value)}
              />
              <input
                aria-label="New prompt variant display name"
                placeholder="Display name"
                value={newPromptVariantDisplayName}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantDisplayName(event.target.value)}
              />
              <textarea
                aria-label="New prompt variant text"
                placeholder="Prompt text (short, vocabulary/context-oriented)"
                value={newPromptVariantText}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantText(event.target.value)}
              />
              <div className="candidate-new-prompt-actions">
                <button className="secondary-button" disabled={!canCreatePrompt} onClick={() => void submitNewPrompt()}>
                  {isCreatingPromptVariant ? "Creating" : "Create prompt variant"}
                </button>
                <button
                  className="secondary-button"
                  disabled={isCreatingPromptVariant}
                  onClick={() => setShowNewPrompt(false)}
                >
                  Cancel
                </button>
              </div>
              {createPromptVariantError && <pre className="error">{createPromptVariantError}</pre>}
            </div>
          )}

          {draftModel && supportsPrompt && draftCandidateKey !== null && (
            draftOption && draftOption.promptText ? (
              <div className="candidate-prompt-preview">
                <span className="candidate-prompt-preview-label">Prompt text</span>
                <p className="candidate-prompt-preview-text">{draftOption.promptText}</p>
              </div>
            ) : (
              <p className="candidate-prompt-preview-empty">Baseline — no initial_prompt.</p>
            )
          )}

          <div className="candidate-picker-footer">
            <button
              className="secondary-button"
              disabled={disabled || !draftOption || draftIsDuplicate || atAddLimit}
              onClick={confirmDraft}
            >
              {replaceIndex !== null ? "Replace candidate" : "Add candidate"}
            </button>
            {draftIsDuplicate && <span className="candidate-hint">Already selected.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

type ExperimentsViewProps = {
  candidateCatalog: SttBenchmarkCandidateOption[];
  stageId: ExperimentStageId;
  setStageId: (stageId: ExperimentStageId) => void;
  stage: ExperimentStage;
  split: SttBenchmarkSetSplit;
  setSplit: (split: SttBenchmarkSetSplit) => void;
  preview: SttBenchmarkSetPreview | null;
  previewError: string;
  selectedCandidates: BenchmarkCandidateIdentity[];
  setSelectedCandidates: React.Dispatch<React.SetStateAction<BenchmarkCandidateIdentity[]>>;
  launchPlan: ExperimentLaunchPlan;
  isRunning: boolean;
  launchProgress: SttBenchmarkSetProgress | null;
  launchError: string;
  launchExperiment: () => void;
  newPromptVariantName: string;
  setNewPromptVariantName: (value: string) => void;
  newPromptVariantDisplayName: string;
  setNewPromptVariantDisplayName: (value: string) => void;
  newPromptVariantText: string;
  setNewPromptVariantText: (value: string) => void;
  isCreatingPromptVariant: boolean;
  createPromptVariantError: string;
  /** Resolves to whether creation succeeded, so the inline form collapses only then. */
  createPromptVariant: () => Promise<boolean>;
  onNavigate: (view: View) => void;
};

/**
 * The launch form (issue #138): stage, dataset, candidates, protocol, launch —
 * in that order, and nothing else. No summary, no past run, no historical
 * result: what an experiment produced belongs to its run, in Results. The
 * protocol states what will be consumed (`audio`), what it is scored against
 * (`Layer 1`), over which split and on how many members, BEFORE anything runs.
 */
function ExperimentsView({
  candidateCatalog,
  stageId,
  setStageId,
  stage,
  split,
  setSplit,
  preview,
  previewError,
  selectedCandidates,
  setSelectedCandidates,
  launchPlan,
  isRunning,
  launchProgress,
  launchError,
  launchExperiment,
  newPromptVariantName,
  setNewPromptVariantName,
  newPromptVariantDisplayName,
  setNewPromptVariantDisplayName,
  newPromptVariantText,
  setNewPromptVariantText,
  isCreatingPromptVariant,
  createPromptVariantError,
  createPromptVariant,
  onNavigate,
}: ExperimentsViewProps): React.ReactElement {
  const optionByKey = useMemo(() => {
    const map = new Map<string, SttBenchmarkCandidateOption>();
    for (const option of candidateCatalog) {
      map.set(formatCandidateIdentityKey(option.candidate), option);
    }
    return map;
  }, [candidateCatalog]);

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Experiments</h1>
        </div>
        <div className="status-pill">{stage.flow}</div>
      </header>

      <LabNavigation activeView="experiments" onNavigate={onNavigate} />

      <section className="panel experiment-panel" aria-busy={isRunning}>
        <div className="panel-header">
          <div>
            <h2>New experiment</h2>
            <p>Announce the protocol, then launch it. The run it creates opens in Results.</p>
          </div>
        </div>

        <ol className="experiment-flow">
          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">1</span>
              <h3>Stage</h3>
            </div>
            <div className="stage-choices">
              {EXPERIMENT_STAGES.map((option) => (
                <button
                  aria-pressed={option.id === stageId}
                  className={`stage-choice ${option.id === stageId ? "stage-choice-selected" : ""}`}
                  disabled={!option.available || isRunning}
                  key={option.id}
                  title={option.unavailableReason ?? undefined}
                  onClick={() => setStageId(option.id)}
                >
                  <strong>{option.label}</strong>
                  <span className="stage-choice-flow">{option.flow}</span>
                  {!option.available && <span className="stage-choice-unavailable">Not runnable yet</span>}
                </button>
              ))}
            </div>
            <p className="experiment-step-note">
              Only the STT stage runs today. The others are announced, never offered as a control that would do nothing.
            </p>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">2</span>
              <h3>Dataset</h3>
            </div>
            <div className="actions">
              <select
                aria-label="Split to evaluate"
                className="secondary-select"
                disabled={isRunning}
                value={split}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (isSttBenchmarkSetSplit(value)) {
                    setSplit(value);
                  }
                }}
              >
                <option value="validation">Validation</option>
                <option value="test_frozen">Test frozen</option>
              </select>
              <span className="experiment-step-note">
                {preview
                  ? `${preview.evaluableSegments} evaluable member${preview.evaluableSegments === 1 ? "" : "s"} · ${preview.scorableSegments} with a Layer 1 reference`
                  : "Reading the corpus…"}
              </span>
            </div>
            {previewError && <pre className="error">{previewError}</pre>}
            <p className="experiment-step-note">
              A member is a corpus segment of this split with real audio. Validation is what a decision is made on; test frozen
              is read once, after every decision.
            </p>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">3</span>
              <h3>Candidates</h3>
            </div>
            <CandidateSelector
              catalog={candidateCatalog}
              selectedCandidates={selectedCandidates}
              setSelectedCandidates={setSelectedCandidates}
              disabled={isRunning}
              newPromptVariantName={newPromptVariantName}
              setNewPromptVariantName={setNewPromptVariantName}
              newPromptVariantDisplayName={newPromptVariantDisplayName}
              setNewPromptVariantDisplayName={setNewPromptVariantDisplayName}
              newPromptVariantText={newPromptVariantText}
              setNewPromptVariantText={setNewPromptVariantText}
              isCreatingPromptVariant={isCreatingPromptVariant}
              createPromptVariantError={createPromptVariantError}
              createPromptVariant={createPromptVariant}
            />
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">4</span>
              <h3>Protocol</h3>
            </div>
            <dl className="protocol-summary">
              <div>
                <dt>Stage</dt>
                <dd>{stage.label}</dd>
              </div>
              <div>
                <dt>Input</dt>
                <dd>{stage.input}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{stage.target}</dd>
              </div>
              <div>
                <dt>Transform</dt>
                <dd className="protocol-flow">{stage.flow}</dd>
              </div>
              <div>
                <dt>Dataset</dt>
                <dd>{formatBenchmarkSetSplit(split)}</dd>
              </div>
              <div>
                <dt>Evaluable members</dt>
                <dd>
                  {preview
                    ? `${preview.evaluableSegments} (${preview.scorableSegments} scorable)`
                    : "reading the corpus…"}
                </dd>
              </div>
              <div className="protocol-summary-wide">
                <dt>Snapshot</dt>
                <dd>
                  Frozen automatically when the run starts: its members and their Layer 1 references are copied into the run,
                  so a later correction never moves its numbers. There is nothing to create by hand.
                </dd>
              </div>
              <div className="protocol-summary-wide">
                <dt>Candidates</dt>
                <dd>
                  {selectedCandidates.length === 0 ? (
                    "None selected yet."
                  ) : (
                    <ul className="protocol-candidates">
                      {selectedCandidates.map((candidate) => {
                        const option = optionByKey.get(formatCandidateIdentityKey(candidate));
                        return (
                          <li className="protocol-candidate" key={formatCandidateIdentityKey(candidate)}>
                            <strong>{option ? option.modelLabel : candidate.model}</strong>
                            {option && (
                              <span className="protocol-candidate-meta">
                                {option.runtimeLabel} · {option.variantLabel}
                              </span>
                            )}
                            <code className="protocol-candidate-identity">{formatCandidateIdentity(candidate)}</code>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </dd>
              </div>
            </dl>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">5</span>
              <h3>Launch</h3>
            </div>
            <div className="actions">
              <button className="secondary-button" disabled={!launchPlan.canLaunch} onClick={launchExperiment}>
                {isRunning ? "Running" : "Run experiment"}
              </button>
              {launchPlan.blockedReason && <span className="experiment-step-note">{launchPlan.blockedReason}</span>}
            </div>

            {launchPlan.warning && <p className="notice">{launchPlan.warning}</p>}
            {launchError && <pre className="error">{launchError}</pre>}

            {launchProgress && (
              <div className="batch-progress">
                <div className="batch-progress-counts">
                  <span className="batch-count">Total {launchProgress.total}</span>
                  <span className="batch-count">Queued {launchProgress.queued}</span>
                  <span className="batch-count">Running {launchProgress.running}</span>
                  <span className="batch-count batch-count-done">Done {launchProgress.done}</span>
                  <span className="batch-count batch-count-failed">Failed {launchProgress.failed}</span>
                </div>
                {launchProgress.current && (
                  <p
                    className="batch-current"
                    title={`${launchProgress.current.sessionId} / ${launchProgress.current.segmentId}`}
                  >
                    Running {launchProgress.current.sessionId} / {launchProgress.current.segmentId}
                  </p>
                )}
                {launchProgress.lastOutcome && (
                  <p
                    className={
                      launchProgress.lastOutcome.status === "failed" ? "batch-last batch-last-failed" : "batch-last"
                    }
                  >
                    {launchProgress.lastOutcome.status === "failed"
                      ? `Failed ${launchProgress.lastOutcome.sessionId} / ${launchProgress.lastOutcome.segmentId}: ${launchProgress.lastOutcome.error ?? "error"}`
                      : `Done ${launchProgress.lastOutcome.sessionId} / ${launchProgress.lastOutcome.segmentId} (${launchProgress.lastOutcome.resultCount} candidates)`}
                  </p>
                )}
              </div>
            )}
          </li>
        </ol>
      </section>
    </>
  );
}

type CandidateSummaryTableProps = {
  candidates: SttBenchmarkCandidateSummary[];
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
};

/**
 * The per-candidate table, shared by a tracked run and the legacy bucket. It is
 * read-only about the measurement itself; the only thing it writes is the human
 * choice of a base candidate (`stt_candidate_selection`), which is a reading of
 * results, not a launch.
 */
function CandidateSummaryTable({
  candidates,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
}: CandidateSummaryTableProps): React.ReactElement {
  return (
    <>
      <p className="empty-state">
        {currentSelection
          ? `Selected base candidate: ${formatCandidateIdentity(currentSelection.candidate)} — ${currentSelection.selectionReason}${
              currentSelection.createdAt ? ` (${formatTimestamp(currentSelection.createdAt)})` : ""
            }. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting.`
          : "No base STT candidate selected yet. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting."}
      </p>

      <div className="actions">
        <input
          aria-label="Candidate selection reason"
          className="reason-input"
          placeholder="Selection reason (e.g. best quality/latency tradeoff on validation)"
          value={selectionReasonDraft}
          onChange={(event) => setSelectionReasonDraft(event.target.value)}
        />
      </div>

      {selectionError && <pre className="error">{selectionError}</pre>}

      <div className="summary-table-scroll">
        <table className="summary-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Segments</th>
              <th className="metric-primary">Mean acoustic CER</th>
              <th className="metric-primary">Median acoustic CER</th>
              <th>Mean strict CER</th>
              <th>Median strict CER</th>
              <th>Mean WER</th>
              <th>Median WER</th>
              <th>Mean latency</th>
              <th>Missing</th>
              <th>Selection</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((summary) => {
              const candidateKey = formatCandidateIdentityKey(summary.candidate);
              const isSelected =
                currentSelection !== null && formatCandidateIdentityKey(currentSelection.candidate) === candidateKey;

              return (
                <tr key={candidateKey}>
                  <td title={candidateKey}>
                    {formatCandidateIdentity(summary.candidate)}
                    {isSelected && <span className="selected-badge">Selected</span>}
                  </td>
                  <td>{summary.resultCount}</td>
                  <td className="metric-primary">{formatRatePercent(summary.meanAcousticCer)}</td>
                  <td className="metric-primary">{formatRatePercent(summary.medianAcousticCer)}</td>
                  <td>{formatRatePercent(summary.meanCer)}</td>
                  <td>{formatRatePercent(summary.medianCer)}</td>
                  <td>{formatRatePercent(summary.meanWer)}</td>
                  <td>{formatRatePercent(summary.medianWer)}</td>
                  <td>{formatLatency(summary.meanLatencyMs === null ? null : Math.round(summary.meanLatencyMs))}</td>
                  <td>{summary.missingCount}</td>
                  <td>
                    <button
                      className="secondary-button"
                      disabled={isSelectingCandidateKey === candidateKey}
                      onClick={() => selectCandidate(summary.candidate)}
                    >
                      {isSelectingCandidateKey === candidateKey ? "Saving" : isSelected ? "Reselect" : "Select"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One card per snapshot member: what the run measured, and what each candidate answered. */
function RunSegmentOutputs({ segments }: { segments: SttBenchmarkRunDetail["segments"] }): React.ReactElement {
  if (segments.length === 0) {
    return <p className="empty-state">This run's snapshot is empty.</p>;
  }

  return (
    <div className="batch-outcomes">
      {segments.map((segment) => (
        <article
          className={segment.status === "failed" ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
          key={`${segment.sessionId}/${segment.segmentId}`}
        >
          <div className="batch-outcome-heading">
            <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
              {segment.sessionId} / {segment.segmentId}
            </strong>
            <em
              className={`batch-outcome-state ${
                segment.status === "failed"
                  ? "batch-outcome-state-failed"
                  : segment.status === "missing" || segment.status === "completed_without_output"
                    ? "batch-outcome-state-missing"
                    : ""
              }`}
            >
              {segment.status === "completed_without_output" ? "completed without output" : segment.status}
            </em>
          </div>

          <p className="run-reference" title={segment.referenceTranscript ?? undefined}>
            Layer 1 reference: {segment.referenceTranscript ?? "none — this member is not scored"}
          </p>

          {segment.error && <p className="batch-outcome-error">{segment.error}</p>}
          {segment.status === "missing" && (
            <p className="batch-outcome-meta">Never executed in this run — no output was logged for it.</p>
          )}
          {segment.status === "completed_without_output" && (
            <p className="batch-outcome-meta">
              This historical run finished as done but logged no output — it is not treated as never executed.
            </p>
          )}

          {segment.results.length > 0 && (
            <ul className="run-outputs">
              {segment.results.map((result) => (
                <li className="run-output" key={formatBenchmarkCandidateKey(result)}>
                  <span className="run-output-candidate" title={formatBenchmarkCandidate(result)}>
                    {formatBenchmarkCandidate(result)}
                  </span>
                  <p className="run-output-transcript">{result.transcript || "-"}</p>
                  <span className="run-output-meta">
                    {formatLatency(result.transcriptionDurationMs)}
                    {result.score ? ` · ${formatScore(result.score)}` : " · no reference, no score"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

type ResultsViewProps = {
  split: SttBenchmarkSetSplit;
  setSplit: (split: SttBenchmarkSetSplit) => void;
  runList: SttBenchmarkRunListEntry[];
  results: ResultsState;
  selectResult: (key: string) => void;
  errorAnalysis: CandidateErrorAnalysis[];
  runExportSummary: SttBenchmarkRunExportSummary | null;
  runExportError: string;
  isExportingRun: boolean;
  exportSelectedRun: () => void;
  openRunExportFolder: () => void;
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
  onNavigate: (view: View) => void;
};

/**
 * The result side (issue #138): pick a run, read the run. Its status, its frozen
 * snapshot, the candidates it launched, their outputs, its errors, its summary
 * and its LLM export — all read from that one run's own events. There is no
 * launch control here: an experiment is announced and started in Experiments, so
 * a run can never be re-run from the page that displays it.
 */
function ResultsView({
  split,
  setSplit,
  runList,
  results,
  selectResult,
  errorAnalysis,
  runExportSummary,
  runExportError,
  isExportingRun,
  exportSelectedRun,
  openRunExportFolder,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
  onNavigate,
}: ResultsViewProps): React.ReactElement {
  const detail = results.detail;
  const legacySummary = results.legacySummary;

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Results</h1>
        </div>
      </header>

      <LabNavigation activeView="results" onNavigate={onNavigate} />

      <section className="panel results-panel" aria-busy={results.isLoading}>
        <div className="panel-header">
          <div>
            <h2>STT runs</h2>
            <p>
              Every tracked run over {formatBenchmarkSetSplit(split)}. A run keeps the snapshot it measured — reopening one
              shows exactly what it saw.
            </p>
          </div>
          <div className="batch-controls">
            <select
              aria-label="Split to browse"
              className="secondary-select"
              disabled={results.isLoading}
              value={split}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isSttBenchmarkSetSplit(value)) {
                  setSplit(value);
                }
              }}
            >
              <option value="validation">Validation</option>
              <option value="test_frozen">Test frozen</option>
            </select>
            <select
              aria-label="Benchmark run to read"
              className="secondary-select"
              disabled={results.isLoading}
              value={results.selectedKey ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value) {
                  selectResult(value);
                }
              }}
            >
              <option value="" disabled>
                {runList.length > 0 ? "Select a run…" : "No tracked run yet"}
              </option>
              {runList.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {formatRunOption(run)}
                </option>
              ))}
              <option value={LEGACY_RUN_KEY}>Legacy (pre-run results)</option>
            </select>
          </div>
        </div>

        {results.error && <pre className="error">{results.error}</pre>}
        {results.isLoading && <p className="empty-state">Reading the run…</p>}
        {!results.isLoading && results.selectedKey === null && (
          <p className="empty-state">
            {runList.length > 0
              ? "Pick a run to read its snapshot, its candidates and their outputs."
              : `No tracked run over ${formatBenchmarkSetSplit(split)} yet — announce and launch one in Experiments.`}
          </p>
        )}
      </section>

      {detail && (
        <>
          <section className="panel run-panel">
            <div className="panel-header">
              <div>
                <h2>Run {formatTimestamp(detail.createdAt)}</h2>
                <p className="benchmark-models" title={detail.runId}>
                  {detail.runId}
                </p>
              </div>
              <em
                className={`run-status ${
                  detail.finished
                    ? (detail.failed ?? 0) > 0
                      ? "run-status-failed"
                      : "run-status-done"
                    : "run-status-unfinished"
                }`}
              >
                {detail.finished ? `${detail.done ?? 0} done · ${detail.failed ?? 0} failed` : "unfinished"}
              </em>
            </div>

            <dl className="run-provenance">
              <div>
                <dt>Stage</dt>
                <dd>
                  {detail.stage} · {detail.datasetKind}
                </dd>
              </div>
              <div>
                <dt>Dataset</dt>
                <dd>{formatBenchmarkSetSplit(detail.split)}</dd>
              </div>
              <div>
                <dt>Snapshot</dt>
                <dd>
                  {detail.segments.length} member{detail.segments.length === 1 ? "" : "s"}, frozen at launch
                </dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>{detail.finishedAt ? formatTimestamp(detail.finishedAt) : "-"}</dd>
              </div>
            </dl>

            <section className="run-candidates">
              <h3>Candidates launched</h3>
              <ul className="protocol-candidates">
                {detail.candidates.map((candidate) => (
                  <li className="protocol-candidate" key={formatCandidateIdentityKey(candidate)}>
                    <strong>{candidate.model}</strong>
                    <span className="protocol-candidate-meta">{candidate.promptVariant ?? "baseline — no prompt"}</span>
                    <code className="protocol-candidate-identity">{formatCandidateIdentity(candidate)}</code>
                  </li>
                ))}
              </ul>
            </section>

            <div className="actions">
              <button
                className="secondary-button"
                disabled={!detail.finished || isExportingRun}
                title={detail.finished ? undefined : "Only a finished run can be exported"}
                onClick={exportSelectedRun}
              >
                {isExportingRun ? "Exporting" : "Export for LLM"}
              </button>
            </div>

            {runExportError && <pre className="error">{runExportError}</pre>}

            {runExportSummary && (
              <div className="dataset-export-summary">
                <p>
                  Exported {runExportSummary.segmentCount} acoustic segment
                  {runExportSummary.segmentCount === 1 ? "" : "s"} and {runExportSummary.candidateCount} candidate
                  {runExportSummary.candidateCount === 1 ? "" : "s"} for run {runExportSummary.runId}. Missing outputs:{" "}
                  {runExportSummary.missingOutputs}.
                </p>
                <p className="dataset-export-path" title={runExportSummary.exportDir}>
                  {runExportSummary.exportDir}
                </p>
                <button className="secondary-button" onClick={openRunExportFolder}>
                  Open export folder
                </button>
              </div>
            )}
          </section>

          <section className="panel summary-panel">
            <div className="panel-header">
              <div>
                <h2>Candidate summary</h2>
                <p>
                  Scored against this run's frozen acoustic snapshot. Acoustic CER (the highlighted metric) ignores sentence
                  punctuation; strict CER counts it. CER/WER: lower is better.
                </p>
              </div>
            </div>

            {detail.summary.length === 0 ? (
              <p className="empty-state">No candidate logged an output in this run.</p>
            ) : (
              <CandidateSummaryTable
                candidates={detail.summary}
                currentSelection={currentSelection}
                selectionReasonDraft={selectionReasonDraft}
                setSelectionReasonDraft={setSelectionReasonDraft}
                selectionError={selectionError}
                isSelectingCandidateKey={isSelectingCandidateKey}
                selectCandidate={selectCandidate}
              />
            )}
          </section>

          <section className="panel benchmark-panel">
            <div className="panel-header">
              <div>
                <h2>Outputs</h2>
                <p>What each candidate answered for each member of this run's frozen snapshot</p>
              </div>
            </div>
            <RunSegmentOutputs segments={detail.segments} />
          </section>

          <section className="panel error-analysis-panel">
            <div className="panel-header">
              <div>
                <h2>Errors</h2>
                <p>This run's failures, plus heuristic diagnostics over its outputs — not a training signal</p>
              </div>
            </div>

            {detail.failures.length > 0 && (
              <ul className="run-failures">
                {detail.failures.map((failure) => (
                  <li className="batch-outcome-error" key={`${failure.sessionId}/${failure.segmentId}`}>
                    {failure.sessionId} / {failure.segmentId}: {failure.error}
                  </li>
                ))}
              </ul>
            )}

            {errorAnalysis.length === 0 ? (
              <p className="empty-state">
                {detail.failures.length > 0
                  ? "No heuristic diagnostic beyond the failures above."
                  : "No error flagged in this run's outputs."}
              </p>
            ) : (
              <div className="error-analysis-candidates">
                {errorAnalysis.map((analysis) => (
                  <article className="error-analysis-candidate" key={analysis.candidateKey}>
                    <strong title={analysis.candidateLabel}>{analysis.candidateLabel}</strong>
                    <div className="error-category-badges">
                      {(Object.keys(analysis.categoryCounts) as SttErrorCategory[])
                        .filter((category) => analysis.categoryCounts[category] > 0)
                        .map((category) => (
                          <span className="error-category-badge" key={category}>
                            {ERROR_CATEGORY_LABELS[category]} · {analysis.categoryCounts[category]}
                          </span>
                        ))}
                    </div>
                    <ul className="error-examples">
                      {analysis.examples.map((example, index) => (
                        <li
                          className="error-example"
                          key={`${example.sessionId}/${example.segmentId}/${example.category}/${index}`}
                        >
                          <span className="error-example-heading">
                            {ERROR_CATEGORY_LABELS[example.category]} · {example.sessionId} / {example.segmentId}
                          </span>
                          <span className="error-example-detail">{example.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {legacySummary && (
        <section className="panel summary-panel">
          <div className="panel-header">
            <div>
              <h2>Legacy results</h2>
              <p>
                Results recorded before run tracking (no run id, no snapshot). Kept readable, never attached to a run and
                never re-scored.
              </p>
            </div>
          </div>

          {legacySummary.candidates.length === 0 ? (
            <p className="empty-state">No legacy result in {formatBenchmarkSetSplit(legacySummary.split)}.</p>
          ) : (
            <CandidateSummaryTable
              candidates={legacySummary.candidates}
              currentSelection={currentSelection}
              selectionReasonDraft={selectionReasonDraft}
              setSelectionReasonDraft={setSelectionReasonDraft}
              selectionError={selectionError}
              isSelectingCandidateKey={isSelectingCandidateKey}
              selectCandidate={selectCandidate}
            />
          )}
        </section>
      )}
    </>
  );
}

type DatasetViewProps = {
  embedded?: boolean;
  segments: ReconstructedSegment[];
  loadSegments: () => void;
  isLoadingSegments: boolean;
  playSegmentAudio: (segment: ReconstructedSegment) => void;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  audioError: string;
  builderMode: "paste" | "segment";
  setBuilderMode: (mode: "paste" | "segment") => void;
  builderSegmentKey: string;
  setBuilderSegmentKey: (key: string) => void;
  builderRawTranscript: string;
  setBuilderRawTranscript: (value: string) => void;
  builderLiteral: string;
  setBuilderLiteral: (value: string) => void;
  builderNotation: string;
  setBuilderNotation: (value: string) => void;
  /** Latest pipeline output over Layer 1 (command words spelled out, never a
   * sentinel), used to render the "what the pipeline changed" diff (#101). */
  builderNotationPrefill: string;
  isPrefillingLayer2: boolean;
  builderPrefillError: string;
  builderSplit: SttBenchmarkSetSplit;
  setBuilderSplit: (split: SttBenchmarkSetSplit) => void;
  isSavingBuilderEntry: boolean;
  builderNotice: string;
  builderError: string;
  saveDatasetBuilderEntry: () => void;
  exportSttDataset: () => void;
  openExportFolder: () => void;
  isExportingDataset: boolean;
  datasetExportSummary: SttDatasetExportSummary | null;
  datasetExportError: string;
};

function DatasetView({
  embedded = false,
  segments,
  loadSegments,
  isLoadingSegments,
  playSegmentAudio,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  audioError,
  builderMode,
  setBuilderMode,
  builderSegmentKey,
  setBuilderSegmentKey,
  builderRawTranscript,
  setBuilderRawTranscript,
  builderLiteral,
  setBuilderLiteral,
  builderNotation,
  setBuilderNotation,
  builderNotationPrefill,
  isPrefillingLayer2,
  builderPrefillError,
  builderSplit,
  setBuilderSplit,
  isSavingBuilderEntry,
  builderNotice,
  builderError,
  saveDatasetBuilderEntry,
  exportSttDataset,
  openExportFolder,
  isExportingDataset,
  datasetExportSummary,
  datasetExportError,
}: DatasetViewProps): React.ReactElement {
  const summary = datasetExportSummary;
  const selectedBuilderSegment = segments.find((segment) => getSegmentKey(segment) === builderSegmentKey) ?? null;

  // Mirrors planDatasetBuilderSave's own rule (apps/lab/src/main/datasetBuilder.ts):
  // a "paste" source has no audio and can therefore NEVER save an acoustic
  // pair — only a picked segment's raw transcript can. Kept in sync with the
  // identical computation in saveDatasetBuilderEntry (App) so the disabled
  // state and the inline hint below never contradict the real save.
  const trimmedLiteral = builderLiteral.trim();

  // Diff between Layer 1 and the pipeline's prefill (#101): recomputed from
  // the two final, sentinel-free strings, so it never shows a sentinel or a
  // command effect — only the words a human would see. Shown regardless of
  // whether the human has since edited Layer 2, since its purpose is to
  // surface what the PIPELINE changed, not to track the human's own edits.
  const prefillDiff: DiffSegment[] = useMemo(
    () => (trimmedLiteral.length > 0 && builderNotationPrefill.length > 0 ? diffWords(trimmedLiteral, builderNotationPrefill) : []),
    [trimmedLiteral, builderNotationPrefill],
  );
  const prefillChanged = prefillDiff.some((segment) => segment.kind !== "equal");

  const effectiveRawTranscript =
    builderMode === "segment" ? (selectedBuilderSegment?.transcript.trim() ?? "") : builderRawTranscript.trim();
  const willSaveAcoustic = builderMode === "segment" && effectiveRawTranscript.length > 0;
  const willSaveMathTransform = builderNotation.trim().length > 0;
  const hasBuilderSource = builderMode !== "segment" || selectedBuilderSegment !== null;
  const canSaveBuilderEntry =
    !isSavingBuilderEntry && trimmedLiteral.length > 0 && hasBuilderSource && (willSaveAcoustic || willSaveMathTransform);

  // Live "what will this save" preview, using the exact same wording
  // planDatasetBuilderSave throws for its "nothing to save" case, so the
  // inline guidance and the real validation error never disagree.
  let builderPlanHint: string;
  if (trimmedLiteral.length === 0) {
    builderPlanHint = "Layer 1 (literal transcript) is required before anything can be saved.";
  } else if (!hasBuilderSource) {
    builderPlanHint = "Pick a DicTeX segment first.";
  } else if (!willSaveAcoustic && !willSaveMathTransform) {
    builderPlanHint =
      builderMode === "segment"
        ? "Nothing to save: the picked segment has no raw transcript for the acoustic layer, and Layer 2 (notation) is empty."
        : "Nothing to save: a pasted (no-audio) entry needs Layer 2 (notation) to build a math_transform pair. Pick a recorded segment if you want an acoustic (audio -> literal) pair.";
  } else {
    const planParts = [
      willSaveAcoustic ? formatDatasetCorrectionKind("acoustic") : null,
      willSaveMathTransform ? formatDatasetCorrectionKind("math_transform") : null,
    ].filter((part): part is string => part !== null);
    builderPlanHint = `Will save ${planParts.join(" + ")} -> ${formatBenchmarkSetSplit(builderSplit)} on Save entry.`;
  }

  return (
    <>
      {!embedded && <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Corpus</h1>
        </div>
      </header>}

      <details className="panel manual-entry" aria-busy={isSavingBuilderEntry}>
        <summary>New manual entry</summary>
        <div className="manual-entry-content">
        <div className="panel-header">
          <div>
            <h2>New manual entry</h2>
            <p>No microphone: paste a transcription or pick a DicTeX segment, then type the two layers by hand</p>
          </div>
        </div>

        <div className="actions" role="group" aria-label="Transcription source">
          <label className="candidate-checkbox">
            <input
              type="radio"
              name="builder-source"
              checked={builderMode === "paste"}
              onChange={() => setBuilderMode("paste")}
            />
            Paste a transcription (no audio)
          </label>
          <label className="candidate-checkbox">
            <input
              type="radio"
              name="builder-source"
              checked={builderMode === "segment"}
              onChange={() => setBuilderMode("segment")}
            />
            Pick a DicTeX segment (has audio)
          </label>
        </div>
        <p className="builder-hint">
          {builderMode === "paste"
            ? 'No audio: this source can only ever save a math_transform entry (Layer 1 -> Layer 2). Switch to "Pick a DicTeX segment" for an acoustic entry.'
            : "Real recorded audio: Layer 1 alone saves an acoustic entry (audio -> literal); adding Layer 2 also saves a math_transform entry."}
        </p>

        {builderMode === "paste" ? (
          <>
            <p className="transcript-label">Pasted transcription (raw STT, optional — never used for acoustic)</p>
            <textarea
              aria-label="Pasted transcription"
              placeholder="Paste DicTeX's raw transcript here for reference, or leave empty for a notation-only entry"
              value={builderRawTranscript}
              onChange={(event) => setBuilderRawTranscript(event.target.value)}
            />
          </>
        ) : (
          <>
            <div className="segment-picker-controls">
              <div>
                <select
                  aria-label="DicTeX segment"
                  className="secondary-select"
                  value={builderSegmentKey}
                  onChange={(event) => setBuilderSegmentKey(event.target.value)}
                >
                  <option value="">Choose a segment…</option>
                  {segments.map((segment) => (
                    <option key={getSegmentKey(segment)} value={getSegmentKey(segment)}>
                      {segment.sessionId} / {segment.segmentId} — {segment.transcript.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <button className="secondary-button" disabled={isLoadingSegments} onClick={loadSegments}>
                {isLoadingSegments ? "Loading" : "Refresh"}
              </button>
            </div>
            {segments.length === 0 && (
              <p className="empty-state">
                No DicTeX segments found yet. Record a dictation in DicTeX, then click Refresh.
              </p>
            )}
            {selectedBuilderSegment && (
              <>
                <p className="correction-raw">Raw: {selectedBuilderSegment.transcript || "-"}</p>
                <div className="segment-audio-controls">
                  <button
                    className="secondary-button"
                    disabled={!selectedBuilderSegment.audioRef || loadingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)}
                    onClick={() => playSegmentAudio(selectedBuilderSegment)}
                  >
                    {loadingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)
                      ? "Loading"
                      : playingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)
                        ? "Stop"
                        : "Play"}
                  </button>
                </div>
              </>
            )}
            {audioError && <pre className="error">{audioError}</pre>}
          </>
        )}

        <p className="transcript-label">Layer 1 — literal-correct transcript (verbal)</p>
        <p className="builder-hint">Required to save anything; also the input to Layer 2.</p>
        <textarea
          aria-label="Layer 1: literal transcript"
          placeholder="e.g. x au carré plus deux"
          value={builderLiteral}
          onChange={(event) => setBuilderLiteral(event.target.value)}
        />

        <p className="transcript-label">Layer 2 — normalized notation (LaTeX/KaTeX-compatible)</p>
        <p className="builder-hint">
          Requires Layer 1. Builds the math_transform pair (literal -&gt; notation) — the only pair a paste source can
          ever produce.
        </p>
        <textarea
          aria-label="Layer 2: normalized notation"
          placeholder="e.g. x^2 + 2"
          disabled={builderLiteral.trim().length === 0}
          value={builderNotation}
          onChange={(event) => setBuilderNotation(event.target.value)}
        />

        {trimmedLiteral.length > 0 &&
          (isPrefillingLayer2 && builderNotationPrefill.length === 0 ? (
            <p className="builder-hint">Prefilling Layer 2 from the pipeline…</p>
          ) : builderPrefillError ? (
            <p className="builder-hint">Prefill unavailable ({builderPrefillError}); type Layer 2 by hand.</p>
          ) : builderNotationPrefill.length > 0 ? (
            <>
              <p className="transcript-label">
                Pipeline prefill vs Layer 1 (dictionary + regex, command words spelled out — a starting point, always
                editable)
              </p>
              <p className="prefill-diff" aria-label="What the pipeline changed">
                {prefillChanged
                  ? prefillDiff.map((segment, index) =>
                      segment.kind === "equal" ? (
                        <React.Fragment key={index}>{segment.text}</React.Fragment>
                      ) : (
                        <mark
                          key={index}
                          className={segment.kind === "added" ? "prefill-diff-added" : "prefill-diff-removed"}
                        >
                          {segment.text}
                        </mark>
                      ),
                    )
                  : "No change from Layer 1 — dictionary and regex left it as-is."}
              </p>
            </>
          ) : null)}

        <div className="actions">
          <select
            aria-label="Benchmark set split for this entry"
            className="secondary-select"
            value={builderSplit}
            onChange={(event) => {
              const split = event.currentTarget.value;
              if (isSttBenchmarkSetSplit(split)) {
                setBuilderSplit(split);
              }
            }}
          >
            <option value="train_candidate_pool">Train pool</option>
            <option value="validation">Validation</option>
            <option value="test_frozen">Test frozen</option>
          </select>
          <button className="secondary-button" disabled={!canSaveBuilderEntry} onClick={saveDatasetBuilderEntry}>
            {isSavingBuilderEntry ? "Saving" : "Save entry"}
          </button>
        </div>

        {builderError && <pre className="error">{builderError}</pre>}
        {builderNotice && <p className="notice">{builderNotice}</p>}
        {!builderError && !builderNotice && <p className="builder-hint">{builderPlanHint}</p>}
        </div>
      </details>

      <section className="panel" aria-busy={isExportingDataset}>
        <div className="panel-header">
          <div>
            <h2>Export corrected STT dataset</h2>
            <p>
              Writes test_frozen-compatible JSONL into the Lab's own store, split by train pool / validation / test frozen
              and by correction kind. Reads events only — DicTeX's data folder is never rewritten, nothing is uploaded.
            </p>
          </div>
          <button className="secondary-button" disabled={isExportingDataset} onClick={exportSttDataset}>
            {isExportingDataset ? "Exporting" : "Export dataset"}
          </button>
        </div>

        {datasetExportError && <pre className="error">{datasetExportError}</pre>}

        {summary && (
          <div className="dataset-export-summary">
            {summary.exportDir === null ? (
              <p className="empty-state">
                No corrected segments in any benchmark split yet. Correct segments and add them to a split first.
              </p>
            ) : (
              <>
                <p className="dataset-export-path" title={summary.exportDir}>
                  {summary.exportDir}
                </p>
                <div className="benchmark-meta">
                  <span>{summary.totalRecords} records</span>
                  <span>
                    Base: {summary.selectedCandidate ? formatCandidateIdentity(summary.selectedCandidate) : "none selected"}
                  </span>
                  {summary.skippedUntypedCorrections > 0 && (
                    <span title="Legacy corrections without a correction kind cannot be routed into the dataset">
                      {summary.skippedUntypedCorrections} untyped skipped
                    </span>
                  )}
                </div>

                {summary.splits.length === 0 ? (
                  <p className="empty-state">No records were written.</p>
                ) : (
                  <ul className="dataset-export-splits">
                    {summary.splits.map((splitSummary) => (
                      <li key={splitSummary.split}>
                        <strong>{formatBenchmarkSetSplit(splitSummary.split)}</strong>{" "}
                        <span>
                          {splitSummary.recordCount} records · {splitSummary.correctedSegmentCount}/
                          {splitSummary.segmentCount} corrected segments
                        </span>
                        <ul>
                          {splitSummary.files.map((file) => (
                            <li key={file.file} title={file.file}>
                              {formatDatasetCorrectionKind(file.correctionKind)}: {file.recordCount} · {file.file}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}

                <button className="secondary-button" onClick={openExportFolder}>
                  Open export folder
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function getSegmentKey(segment: Pick<ReconstructedSegment, "sessionId" | "segmentId">): string {
  return `${segment.sessionId}/${segment.segmentId}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
