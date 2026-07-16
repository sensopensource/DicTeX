import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";
import type {
  BenchmarkMathTransformRunProjection,
  BenchmarkRunListEntry,
  BenchmarkCandidateIdentity,
  ReconstructedSegment,
  SttBenchmarkRunExportSummary,
  NormalizerBenchmarkRunExportSummary,
  LegacyRuleResolution,
  LegacyRulesMigrationPreview,
  RulesMigrationReceipt,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSplit,
  SttCandidateSelectionResponse,
  SttDatasetExportSummary,
} from "@dictex/shared";
import {
  formatBenchmarkRunOption,
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  formatCorrectionKind,
  formatDatasetCorrectionKind,
  formatLatency,
  formatRatePercent,
  formatTimestamp,
  formatBenchmarkSetSplit,
  getSegmentKey,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import {
  analyzeBatchErrors,
  ERROR_CATEGORY_LABELS,
  toSttBenchmarkRunOutcomes,
  type CandidateErrorAnalysis,
  type SttErrorCategory,
} from "@dictex/shared/errorAnalysis";
import { diffWords, type DiffSegment } from "@dictex/shared/textDiff";
import {
  NORMALIZER_BENCHMARK_DISPLAY_NAME,
  parseNormalizerBenchmarkVariant,
  summarizeNormalizerBenchmarkRun,
} from "@dictex/shared/normalizerBenchmark";
import { planCorpusCorrection, type CorpusCorrectionLayer } from "./corpusCorrection.js";
import {
  getExperimentStage,
  planExperimentLaunch,
  planLaunchNavigation,
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
import { api, type DataFolderStatus, type SourceFolderCheck } from "./api.js";
import { CandidateSummaryTable } from "./views/CandidateSummaryTable.js";
import { ExperimentsView, type ExperimentPreview } from "./views/ExperimentsView.js";
import { LabNavigation, type View } from "./views/LabNavigation.js";
import { RunSegmentOutputs } from "./views/RunSegmentOutputs.js";
import { SegmentsView, type HistoryCorrectionTarget } from "./views/SegmentsView.js";
import type { DatasetBuilderSource } from "../../main/datasetBuilder.js";
import type { SttBenchmarkCandidateOption } from "../../main/candidateCatalog.js";
import type { NormalizerBenchmarkRunResponse } from "../../main/normalizerBenchmark.js";

type BenchmarkRunExportSummary = SttBenchmarkRunExportSummary | NormalizerBenchmarkRunExportSummary;

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
  const [setPreview, setSetPreview] = useState<ExperimentPreview | null>(null);
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
  const [rulesMigrationPreview, setRulesMigrationPreview] = useState<LegacyRulesMigrationPreview | null>(null);
  const [rulesMigrationResolutions, setRulesMigrationResolutions] = useState<LegacyRuleResolution[]>([]);
  const [rulesMigrationReceipt, setRulesMigrationReceipt] = useState<RulesMigrationReceipt | null>(null);
  const [rulesMigrationError, setRulesMigrationError] = useState("");
  const [isMigratingRules, setIsMigratingRules] = useState(false);

  // Results: one immutable run at a time (issue #138). The split here is a
  // browse filter over the run list — it never drives a launch, so changing it
  // cannot change what a pending experiment would run.
  const [resultsSplit, setResultsSplit] = useState<SttBenchmarkSetSplit>("validation");
  const [runList, setRunList] = useState<BenchmarkRunListEntry[]>([]);
  const [results, setResults] = useState<ResultsState>(emptyResultsState);
  const [runExportSummary, setRunExportSummary] = useState<BenchmarkRunExportSummary | null>(null);
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
    () =>
      results.detail?.stage === "stt"
        ? analyzeBatchErrors(toSttBenchmarkRunOutcomes(results.detail))
        : [],
    [results.detail],
  );
  const experimentStage = getExperimentStage(experimentStageId);
  // Never render or launch from a count fetched for a previous split. The
  // handler below clears it eagerly; this check also protects the small window
  // before React has run the next effect's cleanup.
  const experimentPreview =
    setPreview?.split === experimentSplit && setPreview.stage === experimentStage.benchmarkStage
      ? setPreview
      : null;
  const experimentCandidates =
    experimentStage.id === "normalizer"
      ? experimentPreview?.stage === "math_transform"
        ? [experimentPreview.candidate.candidate]
        : []
      : selectedCandidates;
  const launchPlan = planExperimentLaunch({
    stage: experimentStage,
    split: experimentSplit,
    preview: experimentPreview,
    candidates: experimentCandidates,
    isRunning: isRunningExperiment,
  });
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef("");

  useEffect(() => {
    const removeBatchProgressListener = api.onBatchBenchmarkProgress(setLaunchProgress);
    void refreshDataFolder();
    void api
      .getSttBenchmarkCandidates()
      .then((catalog) => {
        setCandidateCatalog(catalog);
        setSelectedCandidates(catalog.slice(0, 3).map((option) => option.candidate));
      })
      .catch(() => {
        // Non-fatal; the batch selector just shows no candidates.
      });
    void api.getLatestSttCandidateSelection().then(setCurrentSelection).catch(() => {
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
    api
      .listBenchmarkRuns(resultsSplit)
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
    const previewPromise: Promise<ExperimentPreview> =
      experimentStage.benchmarkStage === "math_transform"
        ? api.previewNormalizerBenchmarkSet(experimentSplit)
        : api
            .previewSttBenchmarkSet(experimentSplit)
            .then((preview) => ({ ...preview, stage: "stt" as const }));
    previewPromise
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
  }, [view, experimentSplit, experimentStage.benchmarkStage]);

  function selectExperimentStage(stageId: ExperimentStageId): void {
    if (stageId === experimentStageId) {
      return;
    }
    setExperimentStageId(stageId);
    setSetPreview(null);
    setPreviewError("");
    setLaunchError("");
    setLaunchProgress(null);
  }

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
      void api
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
        api.getDataFolder(),
        api.checkDataFolder(),
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
      setSegments(await api.getSegments(50));
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
      const status = await api.pickDataFolder();
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
      const status = await api.setDataFolder(dataFolderDraft.trim());
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
      const status = await api.resetDataFolder();
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
      const playback = await api.getSegmentAudio({
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
      const saved = await api.saveSttCorrection({
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
      const marked = await api.markSttBenchmarkSetMembership({
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
      setRunList(await api.listBenchmarkRuns(split));
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
        const legacy = await api.summarizeLegacySttBenchmarkSet(resultsSplit);
        setResults((current) => applyLegacySummary(current, key, legacy));
        return;
      }

      const detail = await api.getBenchmarkRunDetail(key);
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

  async function reviewRulesMigration(): Promise<void> {
    setRulesMigrationError("");
    setRulesMigrationReceipt(null);
    setRulesMigrationResolutions([]);
    try {
      setRulesMigrationPreview(await api.previewRulesMigration([]));
    } catch (error) {
      setRulesMigrationPreview(null);
      setRulesMigrationError(error instanceof Error ? error.message : "Could not inspect legacy rules");
    }
  }

  async function resolveAmbiguousRule(index: number, value: string): Promise<void> {
    const next = rulesMigrationResolutions.filter((resolution) => resolution.index !== index);
    if (value === "keep_personal") {
      next.push({ index, action: "keep_personal" });
    } else if (value.startsWith("replace:")) {
      next.push({ index, action: "replace_bundled", bundledRuleId: value.slice("replace:".length) });
    }
    setRulesMigrationResolutions(next);
    setRulesMigrationError("");
    try {
      setRulesMigrationPreview(await api.previewRulesMigration(next));
    } catch (error) {
      setRulesMigrationError(error instanceof Error ? error.message : "Could not update the migration preview");
    }
  }

  async function confirmRulesMigration(): Promise<void> {
    if (rulesMigrationPreview?.state !== "ready") {
      return;
    }
    if (!window.confirm("Create a timestamped backup and activate the reviewed personal overlay?")) {
      return;
    }
    setRulesMigrationError("");
    setIsMigratingRules(true);
    try {
      const receipt = await api.migrateRules({
        resolutions: rulesMigrationResolutions,
        expectedLegacyHash: rulesMigrationPreview.legacyHash,
        expectedEffectiveHash: rulesMigrationPreview.expectedEffectiveHash!,
      });
      setRulesMigrationReceipt(receipt);
      setRulesMigrationPreview(null);
      const refreshed = await api.previewNormalizerBenchmarkSet(experimentSplit);
      setSetPreview(refreshed);
    } catch (error) {
      setRulesMigrationError(error instanceof Error ? error.message : "Rules migration failed");
    } finally {
      setIsMigratingRules(false);
    }
  }

  async function openRulesFolder(): Promise<void> {
    try {
      await api.openSourceRulesFolder();
    } catch {
      // Non-fatal convenience.
    }
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

    let response: SttBenchmarkSetRunResponse | NormalizerBenchmarkRunResponse | null = null;
    try {
      if (experimentStage.id === "normalizer") {
        const candidate = experimentPreview?.stage === "math_transform"
          ? experimentPreview.candidate.candidate
          : null;
        if (!candidate) {
          throw new Error("Read the current deterministic pipeline before launching");
        }
        response = await api.runSetNormalizerBenchmark(split, candidate);
      } else {
        response = await api.runSetSttBenchmark(split, selectedCandidates);
      }
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
      setRunExportSummary(await api.exportBenchmarkRun(runId));
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
      await api.openExportFolder(runExportSummary.exportDir);
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
      const selection = await api.selectSttCandidate({
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
      const catalog = await api.getSttBenchmarkCandidates();
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
      await api.createSttPromptVariant({
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
      const response = await api.saveDatasetBuilderEntry({
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
      setDatasetExportSummary(await api.exportSttDataset());
    } catch (exportError) {
      setDatasetExportError(exportError instanceof Error ? exportError.message : "Dataset export failed");
    } finally {
      setIsExportingDataset(false);
    }
  }

  async function openExportFolder(): Promise<void> {
    try {
      await api.openExportFolder(datasetExportSummary?.exportDir ?? undefined);
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
          setStageId={selectExperimentStage}
          stage={experimentStage}
          split={experimentSplit}
          setSplit={selectExperimentSplit}
          preview={experimentPreview}
          previewError={previewError}
          selectedCandidates={experimentCandidates}
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
          rulesMigrationPreview={rulesMigrationPreview}
          rulesMigrationReceipt={rulesMigrationReceipt}
          rulesMigrationError={rulesMigrationError}
          isMigratingRules={isMigratingRules}
          reviewRulesMigration={() => void reviewRulesMigration()}
          resolveAmbiguousRule={(index, value) => void resolveAmbiguousRule(index, value)}
          confirmRulesMigration={() => void confirmRulesMigration()}
          openRulesFolder={() => void openRulesFolder()}
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
        openLabDataFolder={() => void api.openLabDataFolder()}
        openSourceDataFolder={() => void api.openSourceDataFolder()}
        openLabEventsLog={() => void api.openLabEventsLog()}
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

function NormalizerRunResults({
  detail,
  runExportSummary,
  runExportError,
  isExportingRun,
  exportSelectedRun,
  openRunExportFolder,
}: {
  detail: BenchmarkMathTransformRunProjection;
  runExportSummary: BenchmarkRunExportSummary | null;
  runExportError: string;
  isExportingRun: boolean;
  exportSelectedRun: () => void;
  openRunExportFolder: () => void;
}): React.ReactElement {
  const summaries = summarizeNormalizerBenchmarkRun(detail);
  const version = parseNormalizerBenchmarkVariant(detail.candidates[0]?.variant ?? null);

  return (
    <>
      <section className="panel run-panel">
        <div className="panel-header">
          <div>
            <h2>Run {formatTimestamp(detail.createdAt)}</h2>
            <p className="benchmark-models" title={detail.runId ?? undefined}>{detail.runId}</p>
          </div>
          <em className={`run-status ${detail.terminal ? (detail.outcomeCounts.failed > 0 ? "run-status-failed" : "run-status-done") : "run-status-unfinished"}`}>
            {detail.terminal
              ? `${detail.outcomeCounts.done} done · ${detail.outcomeCounts.failed} failed · ${detail.outcomeCounts.missing} missing`
              : "unfinished"}
          </em>
        </div>

        <dl className="run-provenance">
          <div>
            <dt>Stage</dt>
            <dd>Normalizer · math_transform</dd>
          </div>
          <div>
            <dt>Transform</dt>
            <dd>Layer 1 -&gt; Normalizer -&gt; Layer 2</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{formatBenchmarkSetSplit(detail.split)}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>{detail.members.length} frozen pair{detail.members.length === 1 ? "" : "s"}</dd>
          </div>
        </dl>

        <section className="run-candidates">
          <h3>Candidate launched</h3>
          <div className="normalizer-candidate-card">
            <strong>{NORMALIZER_BENCHMARK_DISPLAY_NAME}</strong>
            <code>{detail.candidates[0] ? formatCandidateIdentity(detail.candidates[0]) : "-"}</code>
            {version && (
              <dl className="normalizer-version">
                <div>
                  <dt>Dictionary SHA-256</dt>
                  <dd><code>{version.dictionaryHash}</code></dd>
                </div>
                <div>
                  <dt>Effective rules SHA-256</dt>
                  <dd><code>{version.rulesHash}</code></dd>
                </div>
                {version.rulesMode && (
                  <div>
                    <dt>Rules source</dt>
                    <dd>{version.rulesMode === "legacy" ? "Legacy local file" : version.rulesMode === "overlay" ? "Current personal overlay" : "Bundled"}</dd>
                  </div>
                )}
                {version.bundledRulesVersion !== undefined && (
                  <div>
                    <dt>Bundled rules</dt>
                    <dd>v{version.bundledRulesVersion} · <code>{version.bundledRulesHash}</code></dd>
                  </div>
                )}
                {version.localRulesHash && (
                  <div>
                    <dt>Local rules SHA-256</dt>
                    <dd><code>{version.localRulesHash}</code></dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </section>

        <p className="batch-outcome-meta">
          {detail.pipelineSnapshot
            ? `The LLM export includes this run's personal dictionary (${detail.pipelineSnapshot.dictionary.source_content !== null || detail.pipelineSnapshot.dictionary.effective_entries.length ? "source included" : "default empty"}). DicTeX does not upload it.`
            : "This historical run has no complete pipeline provenance. Export will be refused; run the Normalizer benchmark again."}
        </p>
        <div className="actions">
          <button
            className="secondary-button"
            disabled={!detail.terminal || isExportingRun}
            title={detail.terminal ? undefined : "Only a finished run can be exported"}
            onClick={exportSelectedRun}
          >
            {isExportingRun ? "Exporting" : "Export for LLM"}
          </button>
        </div>

        {runExportError && <pre className="error">{runExportError}</pre>}

        {runExportSummary && "containsPersonalDictionary" in runExportSummary && (
          <div className="dataset-export-summary">
            <p>
              Exported {runExportSummary.segmentCount} math transform segment
              {runExportSummary.segmentCount === 1 ? "" : "s"} and {runExportSummary.candidateCount} candidate
              {runExportSummary.candidateCount === 1 ? "" : "s"}. Done: {runExportSummary.done}; failed:{" "}
              {runExportSummary.failed}; missing: {runExportSummary.missingOutputs}.
            </p>
            <p>
              Personal dictionary: {runExportSummary.containsPersonalDictionary ? "included — review before sharing" : "empty"}.
            </p>
            <p className="dataset-export-path" title={runExportSummary.exportDir}>{runExportSummary.exportDir}</p>
            <button className="secondary-button" onClick={openRunExportFolder}>Open export folder</button>
          </div>
        )}
      </section>

      <section className="panel summary-panel">
        <div className="panel-header">
          <div>
            <h2>Exact match summary</h2>
            <p>Output and Layer 2 target are canonicalized with the shared LaTeX convention before comparison.</p>
          </div>
        </div>
        <div className="summary-table-scroll">
          <table className="summary-table">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Exact matches</th>
                <th>Exact match</th>
                <th>Done</th>
                <th>Failed</th>
                <th>Missing</th>
                <th>Mean latency</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={formatCandidateIdentityKey(summary.candidate)}>
                  <td>{NORMALIZER_BENCHMARK_DISPLAY_NAME}</td>
                  <td>{summary.exactMatches} / {summary.total}</td>
                  <td>{formatRatePercent(summary.total === 0 ? null : summary.exactMatches / summary.total)}</td>
                  <td>{summary.done}</td>
                  <td>{summary.failed}</td>
                  <td>{summary.missing}</td>
                  <td>{formatLatency(summary.meanTransformationDurationMs === null ? null : Math.round(summary.meanTransformationDurationMs))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel benchmark-panel">
        <div className="panel-header">
          <div>
            <h2>Layer 1 -&gt; Normalizer -&gt; Layer 2</h2>
            <p>Frozen inputs and targets, canonical exact match, text diff and deterministic layer traces</p>
          </div>
        </div>
        <div className="batch-outcomes">
          {detail.members.map((member) => {
            const outcome = member.outcomes[0];
            const result = outcome?.result;
            const score = result?.score;
            const diff = score ? diffWords(score.canonicalOutput, score.canonicalTarget) : [];
            const failed = outcome?.status === "failed";
            return (
              <article
                className={failed ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
                key={`${member.sessionId}/${member.segmentId}`}
              >
                <div className="batch-outcome-heading">
                  <strong title={`${member.sessionId} / ${member.segmentId}`}>
                    {member.sessionId} / {member.segmentId}
                  </strong>
                  <em className={`batch-outcome-state ${failed ? "batch-outcome-state-failed" : outcome?.status === "missing" ? "batch-outcome-state-missing" : ""}`}>
                    {score ? (score.value ? "exact" : "different") : outcome?.status ?? "missing"}
                  </em>
                </div>
                <p className="run-reference"><strong>Layer 1:</strong> {member.layer1Input}</p>
                <p className="run-reference"><strong>Layer 2 target:</strong> {member.layer2Target}</p>
                <p className="batch-outcome-meta">
                  Correction frozen {member.mathTransformCorrectionCreatedAt
                    ? formatTimestamp(member.mathTransformCorrectionCreatedAt)
                    : "without a date"}
                </p>
                {outcome?.error && <p className="batch-outcome-error">{outcome.error}</p>}
                {result && score && (
                  <>
                    <p className="run-output-transcript"><strong>Output:</strong> {result.outputTranscript}</p>
                    <p className="batch-outcome-meta">Canonical output vs target · {formatLatency(result.transformationDurationMs)}</p>
                    <p className="prefill-diff normalizer-output-diff" aria-label="Canonical output compared with Layer 2 target">
                      {diff.map((segment, index) =>
                        segment.kind === "equal" ? (
                          <React.Fragment key={index}>{segment.text}</React.Fragment>
                        ) : (
                          <mark
                            className={segment.kind === "added" ? "prefill-diff-added" : "prefill-diff-removed"}
                            key={index}
                          >
                            {segment.text}
                          </mark>
                        ),
                      )}
                    </p>
                    <details className="normalizer-layer-traces">
                      <summary>Layer traces ({result.layers.length})</summary>
                      <ol>
                        {result.layers.map((layer, index) => (
                          <li key={`${layer.layer}/${index}`}>
                            <strong>{layer.layer}</strong> · {layer.applied ? "changed" : "unchanged"}
                            <span>{layer.input}</span>
                            <span>{layer.output}</span>
                            {(layer.diagnostics ?? []).length > 0 && <small>{(layer.diagnostics ?? []).join("; ")}</small>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

type ResultsViewProps = {
  split: SttBenchmarkSetSplit;
  setSplit: (split: SttBenchmarkSetSplit) => void;
  runList: BenchmarkRunListEntry[];
  results: ResultsState;
  selectResult: (key: string) => void;
  errorAnalysis: CandidateErrorAnalysis[];
  runExportSummary: BenchmarkRunExportSummary | null;
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
            <h2>Benchmark runs</h2>
            <p>
              Every tracked STT or Normalizer run over {formatBenchmarkSetSplit(split)}. A run keeps the snapshot it measured — reopening one
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
                  {formatBenchmarkRunOption(run)}
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

      {detail?.stage === "stt" && (
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

      {detail?.stage === "math_transform" && (
        <NormalizerRunResults
          detail={detail}
          runExportSummary={runExportSummary}
          runExportError={runExportError}
          isExportingRun={isExportingRun}
          exportSelectedRun={exportSelectedRun}
          openRunExportFolder={openRunExportFolder}
        />
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
