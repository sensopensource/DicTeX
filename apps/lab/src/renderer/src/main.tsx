import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";
import { api } from "./api.js";
import { useBenchmarkRuns } from "./hooks/useBenchmarkRuns.js";
import { useCandidateSelection } from "./hooks/useCandidateSelection.js";
import { useCorpus } from "./hooks/useCorpus.js";
import { useDatasetBuilder } from "./hooks/useDatasetBuilder.js";
import { useDatasetExport } from "./hooks/useDatasetExport.js";
import { useExperiments } from "./hooks/useExperiments.js";
import { useRulesMigration } from "./hooks/useRulesMigration.js";
import { useSegmentAudio } from "./hooks/useSegmentAudio.js";
import { DatasetView } from "./views/DatasetView.js";
import { ExperimentsView } from "./views/ExperimentsView.js";
import type { View } from "./views/LabNavigation.js";
import { ResultsView } from "./views/ResultsView.js";
import { SegmentsView } from "./views/SegmentsView.js";

/**
 * Assembles the Lab: which view is on screen, and which hooks feed it.
 *
 * Every piece of state lives in a hook under ./hooks. `App` holds only what is
 * genuinely shared across them — the current view and the one-line notice — and
 * wires the few places where one concern must tell another that something
 * changed: a launch shows its run, a saved dataset entry re-reads the corpus, a
 * confirmed rules migration re-reads the pipeline the experiment would run.
 *
 * `api` is injected here rather than imported by each hook: `api.ts` reads
 * `window.dictexLab` while it is evaluated, so a hook importing it directly
 * could not be rendered outside Electron. Passing it from this one composition
 * root keeps every hook testable.
 */
function App(): React.ReactElement {
  const [view, setView] = useState<View>("corpus");
  const [notice, setNotice] = useState("");

  // The configured (read-only) DicTeX data folder, the segments read from it,
  // and the Lab's own corrections and split assignments over them.
  const corpus = useCorpus({ api, onNotice: setNotice });
  const audio = useSegmentAudio({ api });

  // Results: one immutable run at a time (issue #138), and the base candidate
  // selected from them.
  const runs = useBenchmarkRuns({ api });
  const selection = useCandidateSelection({ api });

  // Experiments: the protocol to launch. Never a past result (issue #138).
  const experiments = useExperiments({ api, view, showRun: runs.showRun, onNavigate: setView });
  const rulesMigration = useRulesMigration({ api, onMigrated: experiments.refreshNormalizerPreview });

  // Dataset builder (manual two-layer entries, #78). No microphone: either
  // paste a transcription or pick a DicTeX-recorded segment.
  const builder = useDatasetBuilder({ api, segments: corpus.segments, onSaved: () => void corpus.loadSegments() });
  const datasetExport = useDatasetExport({ api });

  if (view === "experiments") {
    return (
      <main className="app-shell">
        <ExperimentsView
          candidateCatalog={experiments.candidateCatalog}
          stageId={experiments.stageId}
          setStageId={experiments.selectExperimentStage}
          stage={experiments.stage}
          split={experiments.experimentSplit}
          setSplit={experiments.selectExperimentSplit}
          preview={experiments.experimentPreview}
          previewError={experiments.previewError}
          selectedCandidates={experiments.experimentCandidates}
          setSelectedCandidates={experiments.setSelectedCandidates}
          launchPlan={experiments.launchPlan}
          isRunning={experiments.isRunningExperiment}
          launchProgress={experiments.launchProgress}
          launchError={experiments.launchError}
          launchExperiment={() => void experiments.launchExperiment()}
          newPromptVariantName={experiments.newPromptVariantName}
          setNewPromptVariantName={experiments.setNewPromptVariantName}
          newPromptVariantDisplayName={experiments.newPromptVariantDisplayName}
          setNewPromptVariantDisplayName={experiments.setNewPromptVariantDisplayName}
          newPromptVariantText={experiments.newPromptVariantText}
          setNewPromptVariantText={experiments.setNewPromptVariantText}
          isCreatingPromptVariant={experiments.isCreatingPromptVariant}
          createPromptVariantError={experiments.createPromptVariantError}
          createPromptVariant={experiments.createPromptVariant}
          rulesMigrationPreview={rulesMigration.rulesMigrationPreview}
          rulesMigrationReceipt={rulesMigration.rulesMigrationReceipt}
          rulesMigrationError={rulesMigration.rulesMigrationError}
          isMigratingRules={rulesMigration.isMigratingRules}
          reviewRulesMigration={() => void rulesMigration.reviewRulesMigration()}
          resolveAmbiguousRule={(index, value) => void rulesMigration.resolveAmbiguousRule(index, value)}
          confirmRulesMigration={() => void rulesMigration.confirmRulesMigration()}
          openRulesFolder={() => void rulesMigration.openRulesFolder()}
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
        audioError={audio.audioError}
        loadingAudioSegmentKey={audio.loadingAudioSegmentKey}
        playingAudioSegmentKey={audio.playingAudioSegmentKey}
        playSegmentAudio={(segment) => void audio.playSegmentAudio(segment)}
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
        playSegmentAudio={(segment) => void audio.playSegmentAudio(segment)}
        loadingAudioSegmentKey={audio.loadingAudioSegmentKey}
        playingAudioSegmentKey={audio.playingAudioSegmentKey}
        audioError={audio.audioError}
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
