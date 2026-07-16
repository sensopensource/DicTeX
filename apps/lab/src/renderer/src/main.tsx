import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";
import type {
  BenchmarkRunListEntry,
  BenchmarkCandidateIdentity,
  ReconstructedSegment,
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
  formatCandidateIdentityKey,
  formatCorrectionKind,
  formatDatasetCorrectionKind,
  formatBenchmarkSetSplit,
  getSegmentKey,
} from "@dictex/shared/formatting";
import { analyzeBatchErrors, toSttBenchmarkRunOutcomes } from "@dictex/shared/errorAnalysis";
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
import { DatasetView } from "./views/DatasetView.js";
import { ExperimentsView, type ExperimentPreview } from "./views/ExperimentsView.js";
import type { View } from "./views/LabNavigation.js";
import { ResultsView, type BenchmarkRunExportSummary } from "./views/ResultsView.js";
import { SegmentsView, type HistoryCorrectionTarget } from "./views/SegmentsView.js";
import type { DatasetBuilderSource } from "../../main/datasetBuilder.js";
import type { SttBenchmarkCandidateOption } from "../../main/candidateCatalog.js";
import type { NormalizerBenchmarkRunResponse } from "../../main/normalizerBenchmark.js";

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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
