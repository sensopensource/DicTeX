import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";
import type {
  BenchmarkRunListEntry,
  BenchmarkCandidateIdentity,
  LegacyRuleResolution,
  LegacyRulesMigrationPreview,
  RulesMigrationReceipt,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSplit,
  SttCandidateSelectionResponse,
} from "@dictex/shared";
import { formatCandidateIdentityKey } from "@dictex/shared/formatting";
import { analyzeBatchErrors, toSttBenchmarkRunOutcomes } from "@dictex/shared/errorAnalysis";
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
import { api } from "./api.js";
import { useBenchmarkRuns } from "./hooks/useBenchmarkRuns.js";
import { useCandidateSelection } from "./hooks/useCandidateSelection.js";
import { useCorpus } from "./hooks/useCorpus.js";
import { useDatasetBuilder } from "./hooks/useDatasetBuilder.js";
import { useDatasetExport } from "./hooks/useDatasetExport.js";
import { useSegmentAudio } from "./hooks/useSegmentAudio.js";
import { DatasetView } from "./views/DatasetView.js";
import { ExperimentsView, type ExperimentPreview } from "./views/ExperimentsView.js";
import type { View } from "./views/LabNavigation.js";
import { ResultsView, type BenchmarkRunExportSummary } from "./views/ResultsView.js";
import { SegmentsView } from "./views/SegmentsView.js";
import type { SttBenchmarkCandidateOption } from "../../main/candidateCatalog.js";
import type { NormalizerBenchmarkRunResponse } from "../../main/normalizerBenchmark.js";

function App(): React.ReactElement {
  const [view, setView] = useState<View>("corpus");
  const [notice, setNotice] = useState("");

  // The configured (read-only) DicTeX data folder, the segments read from it,
  // and the Lab's own corrections and split assignments over them.
  const corpus = useCorpus({ api, onNotice: setNotice });
  const { audioError, loadingAudioSegmentKey, playingAudioSegmentKey, playSegmentAudio } = useSegmentAudio({ api });

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

  // Results: one immutable run at a time (issue #138), and the base candidate
  // selected from them.
  const runs = useBenchmarkRuns({ api });
  const selection = useCandidateSelection({ api });

  // Dataset builder (manual two-layer entries, #78). No microphone: either
  // paste a transcription or pick a DicTeX-recorded segment.
  const builder = useDatasetBuilder({ api, segments: corpus.segments, onSaved: () => void corpus.loadSegments() });

  // Dataset export.
  const datasetExport = useDatasetExport({ api });

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

  useEffect(() => {
    const removeBatchProgressListener = api.onBatchBenchmarkProgress(setLaunchProgress);
    void api
      .getSttBenchmarkCandidates()
      .then((catalog) => {
        setCandidateCatalog(catalog);
        setSelectedCandidates(catalog.slice(0, 3).map((option) => option.candidate));
      })
      .catch(() => {
        // Non-fatal; the batch selector just shows no candidates.
      });

    return () => {
      removeBatchProgressListener();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    await runs.showRun(split, navigation.selectedRunKey);
    setLaunchProgress(null);
    setView("results");
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
          split={runs.resultsSplit}
          setSplit={runs.selectResultsSplit}
          runList={runs.runList}
          results={runs.results}
          selectResult={(key) => void runs.selectResult(key)}
          errorAnalysis={runs.errorAnalysis}
          runExportSummary={runs.runExportSummary}
          runExportError={runs.runExportError}
          isExportingRun={runs.isExportingRun}
          exportSelectedRun={() => void runs.exportSelectedRun()}
          openRunExportFolder={() => void runs.openRunExportFolder()}
          currentSelection={selection.currentSelection}
          selectionReasonDraft={selection.selectionReasonDraft}
          setSelectionReasonDraft={selection.editSelectionReasonDraft}
          selectionError={selection.selectionError}
          isSelectingCandidateKey={selection.isSelectingCandidateKey}
          selectCandidate={(candidate) => void selection.selectCandidate(candidate)}
          onNavigate={setView}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <SegmentsView
        dataFolder={corpus.dataFolder}
        sourceCheck={corpus.sourceCheck}
        dataFolderDraft={corpus.dataFolderDraft}
        setDataFolderDraft={corpus.setDataFolderDraft}
        isSavingDataFolder={corpus.isSavingDataFolder}
        pickDataFolder={() => void corpus.pickDataFolder()}
        applyDataFolderDraft={() => void corpus.applyDataFolderDraft()}
        resetDataFolder={() => void corpus.resetDataFolder()}
        segments={corpus.segments}
        segmentsError={corpus.segmentsError}
        isLoadingSegments={corpus.isLoadingSegments}
        loadSegments={() => void corpus.loadSegments()}
        audioError={audioError}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        playSegmentAudio={(segment) => void playSegmentAudio(segment)}
        benchmarkSetTargetKey={corpus.benchmarkSetTargetKey}
        markSttBenchmarkSetMembership={(segment, split) => void corpus.markSttBenchmarkSetMembership(segment, split)}
        startSegmentCorrection={corpus.startSegmentCorrection}
        isSavingCorrection={corpus.isSavingCorrection}
        historyCorrectionTarget={corpus.historyCorrectionTarget}
        historyCorrectionDraft={corpus.historyCorrectionDraft}
        setHistoryCorrectionDraft={corpus.editHistoryCorrectionDraft}
        saveSegmentCorrection={() => void corpus.saveSegmentCorrection()}
        cancelSegmentCorrection={corpus.cancelSegmentCorrection}
        correctionNotice={corpus.correctionNotice}
        notice={notice}
        openLabDataFolder={() => void api.openLabDataFolder()}
        openSourceDataFolder={() => void api.openSourceDataFolder()}
        openLabEventsLog={() => void api.openLabEventsLog()}
        onNavigate={setView}
      />
      <DatasetView
        embedded
        segments={corpus.segments}
        loadSegments={() => void corpus.loadSegments()}
        isLoadingSegments={corpus.isLoadingSegments}
        playSegmentAudio={(segment) => void playSegmentAudio(segment)}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        audioError={audioError}
        builderMode={builder.builderMode}
        setBuilderMode={builder.setBuilderMode}
        builderSegmentKey={builder.builderSegmentKey}
        setBuilderSegmentKey={builder.setBuilderSegmentKey}
        builderRawTranscript={builder.builderRawTranscript}
        setBuilderRawTranscript={builder.setBuilderRawTranscript}
        builderLiteral={builder.builderLiteral}
        setBuilderLiteral={builder.setBuilderLiteral}
        builderNotation={builder.builderNotation}
        setBuilderNotation={builder.setBuilderNotation}
        builderNotationPrefill={builder.builderNotationPrefill}
        isPrefillingLayer2={builder.isPrefillingLayer2}
        builderPrefillError={builder.builderPrefillError}
        builderSplit={builder.builderSplit}
        setBuilderSplit={builder.setBuilderSplit}
        isSavingBuilderEntry={builder.isSavingBuilderEntry}
        builderNotice={builder.builderNotice}
        builderError={builder.builderError}
        saveDatasetBuilderEntry={() => void builder.saveDatasetBuilderEntry()}
        exportSttDataset={() => void datasetExport.exportSttDataset()}
        openExportFolder={() => void datasetExport.openExportFolder()}
        isExportingDataset={datasetExport.isExportingDataset}
        datasetExportSummary={datasetExport.datasetExportSummary}
        datasetExportError={datasetExport.datasetExportError}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
