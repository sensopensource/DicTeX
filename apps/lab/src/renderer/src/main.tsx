import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type {
  AudioSegmentRecord,
  BenchmarkCandidateIdentity,
  CorrectionKind,
  ReconstructedSegment,
  SttBenchmarkCandidateSummaryResponse,
  SttBenchmarkResponse,
  SttBenchmarkResult,
  SttBenchmarkSetMembershipRequest,
  SttBenchmarkSetMembershipResponse,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSegmentOutcome,
  SttBenchmarkSetSplit,
  SttCandidateSelectionRequest,
  SttCandidateSelectionResponse,
  SttCorrectionRequest,
  SttCorrectionResponse,
  SttDatasetExportSummary,
} from "@dictex/shared";
import {
  CORRECTION_KIND_OPTIONS,
  formatAudioDuration,
  formatBatchOutcomeScore,
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  formatCorrectionKind,
  formatDatasetCorrectionKind,
  formatLatency,
  formatRatePercent,
  formatScore,
  formatTimestamp,
  formatBenchmarkSetSplit,
  isCorrectionKind,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import {
  analyzeBatchErrors,
  ERROR_CATEGORY_LABELS,
  formatBenchmarkCandidate,
  formatBenchmarkCandidateKey,
  type CandidateErrorAnalysis,
  type SttErrorCategory,
} from "@dictex/shared/errorAnalysis";
import type {
  DatasetBuilderSaveRequest,
  DatasetBuilderSaveResponse,
  DatasetBuilderSource,
} from "../../main/datasetBuilder.js";

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
  runLatestSttBenchmark: () => Promise<SttBenchmarkResponse>;
  runSegmentSttBenchmark: (audioSegment: AudioSegmentRecord) => Promise<SttBenchmarkResponse>;
  runSetSttBenchmark: (split: SttBenchmarkSetSplit, models?: string[]) => Promise<SttBenchmarkSetRunResponse>;
  summarizeSttBenchmarkSet: (split: SttBenchmarkSetSplit) => Promise<SttBenchmarkCandidateSummaryResponse>;
  selectSttCandidate: (request: SttCandidateSelectionRequest) => Promise<SttCandidateSelectionResponse>;
  getLatestSttCandidateSelection: () => Promise<SttCandidateSelectionResponse | null>;
  saveDatasetBuilderEntry: (request: DatasetBuilderSaveRequest) => Promise<DatasetBuilderSaveResponse>;
  exportSttDataset: () => Promise<SttDatasetExportSummary>;
  openExportFolder: (exportDir?: string) => Promise<boolean>;
  getSttBenchmarkModels: () => Promise<string[]>;
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

type View = "segments" | "benchmark" | "dataset";

type HistoryCorrectionTarget = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  rawTranscript: string;
};

function App(): React.ReactElement {
  const [view, setView] = useState<View>("segments");
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
  const [historyCorrectionKind, setHistoryCorrectionKind] = useState<CorrectionKind | "">("");

  // Benchmark.
  const [benchmarkSource, setBenchmarkSource] = useState<AudioSegmentRecord | null>(null);
  const [benchmarkResults, setBenchmarkResults] = useState<SttBenchmarkResult[]>([]);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkModels, setBenchmarkModels] = useState<string[]>([]);
  const [selectedBenchmarkModels, setSelectedBenchmarkModels] = useState<string[]>([]);
  const [benchmarkTargetKey, setBenchmarkTargetKey] = useState<string | null>(null);
  const [batchSplit, setBatchSplit] = useState<SttBenchmarkSetSplit>("test_frozen");
  const [batchProgress, setBatchProgress] = useState<SttBenchmarkSetProgress | null>(null);
  const [batchOutcomes, setBatchOutcomes] = useState<SttBenchmarkSetSegmentOutcome[]>([]);
  const [batchError, setBatchError] = useState("");
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [candidateSummary, setCandidateSummary] = useState<SttBenchmarkCandidateSummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<SttCandidateSelectionResponse | null>(null);
  const [selectionReasonDraft, setSelectionReasonDraft] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [isSelectingCandidateKey, setIsSelectingCandidateKey] = useState("");

  // Dataset builder (manual two-layer entries, #78). No microphone: either
  // paste a transcription or pick a DicTeX-recorded segment.
  const [builderMode, setBuilderMode] = useState<"paste" | "segment">("paste");
  const [builderSegmentKey, setBuilderSegmentKey] = useState("");
  const [builderReferenceModel, setBuilderReferenceModel] = useState("");
  const [builderRawTranscript, setBuilderRawTranscript] = useState("");
  const [builderLiteral, setBuilderLiteral] = useState("");
  const [builderNotation, setBuilderNotation] = useState("");
  const [builderSplit, setBuilderSplit] = useState<SttBenchmarkSetSplit>("train_candidate_pool");
  const [isSavingBuilderEntry, setIsSavingBuilderEntry] = useState(false);
  const [builderNotice, setBuilderNotice] = useState("");
  const [builderError, setBuilderError] = useState("");

  // Dataset export.
  const [datasetExportSummary, setDatasetExportSummary] = useState<SttDatasetExportSummary | null>(null);
  const [datasetExportError, setDatasetExportError] = useState("");
  const [isExportingDataset, setIsExportingDataset] = useState(false);

  const errorAnalysis = useMemo(() => analyzeBatchErrors(batchOutcomes), [batchOutcomes]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef("");

  useEffect(() => {
    const removeBatchProgressListener = window.dictexLab.onBatchBenchmarkProgress(setBatchProgress);
    void refreshDataFolder();
    void window.dictexLab
      .getSttBenchmarkModels()
      .then((models) => {
        setBenchmarkModels(models);
        setSelectedBenchmarkModels(models.slice(0, 3));
        setBuilderReferenceModel((current) => current || (models[0] ?? ""));
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

  function startSegmentCorrection(segment: ReconstructedSegment): void {
    setHistoryCorrectionTarget({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      rawTranscript: segment.transcript,
    });
    setHistoryCorrectionDraft(segment.correctedTranscript ?? segment.transcript);
    setHistoryCorrectionKind("");
    setCorrectionNotice("");
    setNotice(`Correction target ${segment.sessionId} / ${segment.segmentId}`);
  }

  function cancelSegmentCorrection(): void {
    setHistoryCorrectionTarget(null);
    setHistoryCorrectionDraft("");
    setHistoryCorrectionKind("");
  }

  async function saveSegmentCorrection(): Promise<void> {
    if (!historyCorrectionTarget) {
      return;
    }
    if (historyCorrectionKind === "") {
      setCorrectionNotice("Choose a correction kind before saving");
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
        correctionKind: historyCorrectionKind,
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

  async function runSegmentSttBenchmark(segment: ReconstructedSegment): Promise<void> {
    const segmentKey = getSegmentKey(segment);
    setBenchmarkError("");
    setIsBenchmarking(true);
    setBenchmarkTargetKey(segmentKey);
    try {
      const result = await window.dictexLab.runSegmentSttBenchmark({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
      setView("benchmark");
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
      setBenchmarkTargetKey(null);
    }
  }

  async function runLatestSttBenchmark(): Promise<void> {
    setBenchmarkError("");
    setIsBenchmarking(true);
    setBenchmarkTargetKey("latest");
    try {
      const result = await window.dictexLab.runLatestSttBenchmark();
      setBenchmarkSource(result.source);
      setBenchmarkResults(result.results);
    } catch (benchmarkRunError) {
      setBenchmarkError(benchmarkRunError instanceof Error ? benchmarkRunError.message : "Benchmark failed");
    } finally {
      setIsBenchmarking(false);
      setBenchmarkTargetKey(null);
    }
  }

  function toggleBenchmarkModel(model: string): void {
    setSelectedBenchmarkModels((current) => {
      if (current.includes(model)) {
        return current.filter((selected) => selected !== model);
      }
      if (current.length >= 3) {
        return current;
      }
      return [...current, model];
    });
  }

  async function runSetSttBenchmark(): Promise<void> {
    if (selectedBenchmarkModels.length < 1) {
      setBatchError("Check at least one STT candidate to run");
      return;
    }

    setBatchError("");
    setBatchOutcomes([]);
    setBatchProgress(null);
    setIsRunningBatch(true);
    try {
      const response = await window.dictexLab.runSetSttBenchmark(batchSplit, selectedBenchmarkModels);
      setBatchOutcomes(response.outcomes);
      setNotice(
        `Benchmarked ${formatBenchmarkSetSplit(response.split)}: ${response.done} done, ${response.failed} failed of ${response.total}`,
      );
    } catch (runError) {
      setBatchError(runError instanceof Error ? runError.message : "Benchmark set run failed");
    } finally {
      setIsRunningBatch(false);
    }
  }

  async function summarizeCandidates(): Promise<void> {
    setSummaryError("");
    setIsSummarizing(true);
    try {
      const response = await window.dictexLab.summarizeSttBenchmarkSet(batchSplit);
      setCandidateSummary({
        ...response,
        candidates: response.candidates.filter((summary) => selectedBenchmarkModels.includes(summary.candidate.model)),
      });
    } catch (summaryRunError) {
      setSummaryError(summaryRunError instanceof Error ? summaryRunError.message : "Benchmark summary failed");
    } finally {
      setIsSummarizing(false);
    }
  }

  async function runAnalysis(): Promise<void> {
    await runSetSttBenchmark();
    await summarizeCandidates();
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
    if (rawTranscript.length === 0 && notation.length === 0) {
      setBuilderError(
        "Nothing to save: provide a raw transcript (paste one or pick a segment) for the acoustic layer, or fill Layer 2 for the math-transform layer",
      );
      return;
    }

    setIsSavingBuilderEntry(true);
    try {
      const response = await window.dictexLab.saveDatasetBuilderEntry({
        source,
        rawTranscript,
        referenceModel: builderReferenceModel,
        literalTranscript: literal,
        notationTranscript: notation,
        split: builderSplit,
      });
      const savedLayers = [
        response.savedAcoustic ? "acoustic" : null,
        response.savedMathTransform ? "math_transform" : null,
      ].filter((layer): layer is string => layer !== null);
      setBuilderNotice(
        `Saved ${savedLayers.join(" + ")} for ${response.sessionId} / ${response.segmentId} (${formatBenchmarkSetSplit(response.split)})`,
      );
      setBuilderNotation("");
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

  if (view === "benchmark") {
    return (
      <main className="app-shell">
        <BenchmarkView
          benchmarkSource={benchmarkSource}
          benchmarkResults={benchmarkResults}
          benchmarkError={benchmarkError}
          isBenchmarking={isBenchmarking}
          benchmarkModels={benchmarkModels}
          benchmarkTargetKey={benchmarkTargetKey}
          runLatestSttBenchmark={() => void runLatestSttBenchmark()}
          isRunningBatch={isRunningBatch}
          batchSplit={batchSplit}
          setBatchSplit={setBatchSplit}
          batchProgress={batchProgress}
          batchOutcomes={batchOutcomes}
          batchError={batchError}
          selectedBenchmarkModels={selectedBenchmarkModels}
          toggleBenchmarkModel={toggleBenchmarkModel}
          runAnalysis={() => void runAnalysis()}
          candidateSummary={candidateSummary}
          summaryError={summaryError}
          isSummarizing={isSummarizing}
          summarizeCandidates={() => void summarizeCandidates()}
          currentSelection={currentSelection}
          selectionReasonDraft={selectionReasonDraft}
          setSelectionReasonDraft={(value) => {
            setSelectionReasonDraft(value);
            setSelectionError("");
          }}
          selectionError={selectionError}
          isSelectingCandidateKey={isSelectingCandidateKey}
          selectCandidate={(candidate) => void selectCandidate(candidate)}
          errorAnalysis={errorAnalysis}
          onBack={() => setView("segments")}
        />
      </main>
    );
  }

  if (view === "dataset") {
    return (
      <main className="app-shell">
        <DatasetView
          segments={segments}
          benchmarkModels={benchmarkModels}
          builderMode={builderMode}
          setBuilderMode={setBuilderMode}
          builderSegmentKey={builderSegmentKey}
          setBuilderSegmentKey={setBuilderSegmentKey}
          builderReferenceModel={builderReferenceModel}
          setBuilderReferenceModel={setBuilderReferenceModel}
          builderRawTranscript={builderRawTranscript}
          setBuilderRawTranscript={setBuilderRawTranscript}
          builderLiteral={builderLiteral}
          setBuilderLiteral={setBuilderLiteral}
          builderNotation={builderNotation}
          setBuilderNotation={setBuilderNotation}
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
          onBack={() => setView("segments")}
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
        benchmarkTargetKey={benchmarkTargetKey}
        runSegmentSttBenchmark={(segment) => void runSegmentSttBenchmark(segment)}
        isBenchmarking={isBenchmarking}
        isRunningBatch={isRunningBatch}
        isSavingCorrection={isSavingCorrection}
        historyCorrectionTarget={historyCorrectionTarget}
        historyCorrectionDraft={historyCorrectionDraft}
        setHistoryCorrectionDraft={(value) => {
          setHistoryCorrectionDraft(value);
          setCorrectionNotice("");
        }}
        historyCorrectionKind={historyCorrectionKind}
        setHistoryCorrectionKind={(kind) => {
          setHistoryCorrectionKind(kind);
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
  startSegmentCorrection: (segment: ReconstructedSegment) => void;
  benchmarkTargetKey: string | null;
  runSegmentSttBenchmark: (segment: ReconstructedSegment) => void;
  isBenchmarking: boolean;
  isRunningBatch: boolean;
  isSavingCorrection: boolean;
  historyCorrectionTarget: HistoryCorrectionTarget | null;
  historyCorrectionDraft: string;
  setHistoryCorrectionDraft: (value: string) => void;
  historyCorrectionKind: CorrectionKind | "";
  setHistoryCorrectionKind: (kind: CorrectionKind | "") => void;
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
  benchmarkTargetKey,
  runSegmentSttBenchmark,
  isBenchmarking,
  isRunningBatch,
  isSavingCorrection,
  historyCorrectionTarget,
  historyCorrectionDraft,
  setHistoryCorrectionDraft,
  historyCorrectionKind,
  setHistoryCorrectionKind,
  saveSegmentCorrection,
  cancelSegmentCorrection,
  correctionNotice,
  notice,
  openLabDataFolder,
  openSourceDataFolder,
  openLabEventsLog,
  onNavigate,
}: SegmentsViewProps): React.ReactElement {
  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Segments</h1>
        </div>
        <div className={`status-pill ${sourceCheck?.eventsFound ? "status-copied" : "status-error"}`}>
          {sourceCheck === null ? "checking" : sourceCheck.eventsFound ? "data folder ok" : "no events found"}
        </div>
      </header>

      <section className="panel nav-panel">
        <button className="nav-button" onClick={() => onNavigate("benchmark")}>
          Benchmark
        </button>
        <button className="nav-button" onClick={() => onNavigate("dataset")}>
          Dataset
        </button>
      </section>

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

      <section className="panel history-panel" aria-busy={isLoadingSegments}>
        <div className="history-header">
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
          <p className="empty-state">No stored dictation segments found in the DicTeX data folder.</p>
        ) : (
          <div className="history-list">
            {segments.map((segment) => (
              <article className="history-item" key={getSegmentKey(segment)}>
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
                      disabled={!segment.audioRef || loadingAudioSegmentKey === getSegmentKey(segment)}
                      onClick={() => playSegmentAudio(segment)}
                    >
                      {loadingAudioSegmentKey === getSegmentKey(segment)
                        ? "Loading"
                        : playingAudioSegmentKey === getSegmentKey(segment)
                          ? "Stop"
                          : "Play"}
                    </button>
                    <select
                      aria-label={`STT benchmark set split for ${segment.sessionId} / ${segment.segmentId}`}
                      className="secondary-select"
                      disabled={!segment.correctedTranscript || benchmarkSetTargetKey === getSegmentKey(segment)}
                      value={segment.benchmarkSetSplit ?? ""}
                      onChange={(event) => {
                        const split = event.currentTarget.value;
                        if (isSttBenchmarkSetSplit(split)) {
                          markSttBenchmarkSetMembership(segment, split);
                        }
                      }}
                    >
                      <option value="">Set split</option>
                      <option value="train_candidate_pool">Train pool</option>
                      <option value="validation">Validation</option>
                      <option value="test_frozen">Test frozen</option>
                    </select>
                    <button
                      className="secondary-button"
                      disabled={isSavingCorrection}
                      onClick={() => startSegmentCorrection(segment)}
                    >
                      Correct
                    </button>
                    <button
                      className="secondary-button"
                      disabled={isBenchmarking || isRunningBatch}
                      onClick={() => runSegmentSttBenchmark(segment)}
                    >
                      {benchmarkTargetKey === getSegmentKey(segment) ? "Running" : "Benchmark"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {historyCorrectionTarget && (
        <section className="panel correction-panel">
          <div className="correction-header">
            <div>
              <h2>STT correction</h2>
              <p title={`${historyCorrectionTarget.sessionId} / ${historyCorrectionTarget.segmentId}`}>
                {historyCorrectionTarget.sessionId} / {historyCorrectionTarget.segmentId}
              </p>
            </div>
            <button className="secondary-button" disabled={isSavingCorrection} onClick={cancelSegmentCorrection}>
              Cancel
            </button>
          </div>

          <p className="correction-raw">Raw: {historyCorrectionTarget.rawTranscript || "-"}</p>
          <textarea
            value={historyCorrectionDraft}
            onChange={(event) => setHistoryCorrectionDraft(event.target.value)}
            aria-label="Corrected transcript"
          />
          <div className="actions">
            <CorrectionKindSelect
              ariaLabel={`Correction kind for ${historyCorrectionTarget.sessionId} / ${historyCorrectionTarget.segmentId}`}
              value={historyCorrectionKind}
              disabled={isSavingCorrection}
              onChange={(kind) => setHistoryCorrectionKind(kind)}
            />
            <button
              className="secondary-button"
              disabled={isSavingCorrection || historyCorrectionDraft.length === 0 || historyCorrectionKind === ""}
              onClick={saveSegmentCorrection}
            >
              {isSavingCorrection ? "Saving" : "Save correction"}
            </button>
          </div>
          {correctionNotice && <p className="notice">{correctionNotice}</p>}
        </section>
      )}

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

type BenchmarkViewProps = {
  benchmarkSource: AudioSegmentRecord | null;
  benchmarkResults: SttBenchmarkResult[];
  benchmarkError: string;
  isBenchmarking: boolean;
  benchmarkModels: string[];
  benchmarkTargetKey: string | null;
  runLatestSttBenchmark: () => void;
  isRunningBatch: boolean;
  batchSplit: SttBenchmarkSetSplit;
  setBatchSplit: (split: SttBenchmarkSetSplit) => void;
  batchProgress: SttBenchmarkSetProgress | null;
  batchOutcomes: SttBenchmarkSetSegmentOutcome[];
  batchError: string;
  selectedBenchmarkModels: string[];
  toggleBenchmarkModel: (model: string) => void;
  runAnalysis: () => void;
  candidateSummary: SttBenchmarkCandidateSummaryResponse | null;
  summaryError: string;
  isSummarizing: boolean;
  summarizeCandidates: () => void;
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
  errorAnalysis: CandidateErrorAnalysis[];
  onBack: () => void;
};

function BenchmarkView({
  benchmarkSource,
  benchmarkResults,
  benchmarkError,
  isBenchmarking,
  benchmarkModels,
  benchmarkTargetKey,
  runLatestSttBenchmark,
  isRunningBatch,
  batchSplit,
  setBatchSplit,
  batchProgress,
  batchOutcomes,
  batchError,
  selectedBenchmarkModels,
  toggleBenchmarkModel,
  runAnalysis,
  candidateSummary,
  summaryError,
  isSummarizing,
  summarizeCandidates,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
  errorAnalysis,
  onBack,
}: BenchmarkViewProps): React.ReactElement {
  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Benchmark</h1>
        </div>
        <button className="secondary-button" onClick={onBack}>
          Back to segments
        </button>
      </header>

      <section className="panel benchmark-panel" aria-busy={isBenchmarking}>
        <div className="benchmark-header">
          <div>
            <h2>STT benchmark</h2>
            <p title={benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : undefined}>
              {benchmarkSource ? `${benchmarkSource.sessionId} / ${benchmarkSource.segmentId}` : "Latest audio segment"}
            </p>
            {benchmarkModels.length > 0 && <p className="benchmark-models">Models: {benchmarkModels.join(", ")}</p>}
          </div>
          <button
            className="secondary-button"
            disabled={isBenchmarking || isRunningBatch}
            onClick={runLatestSttBenchmark}
          >
            {benchmarkTargetKey === "latest" ? "Running" : "Benchmark latest"}
          </button>
        </div>

        {benchmarkError && <pre className="error">{benchmarkError}</pre>}

        {benchmarkResults.length > 0 && (
          <div className="benchmark-results">
            {benchmarkResults.map((result) => (
              <article className="benchmark-result" key={formatBenchmarkCandidateKey(result)}>
                <div className="benchmark-meta">
                  <strong title={formatBenchmarkCandidate(result)}>{formatBenchmarkCandidate(result)}</strong>
                  <span>{result.sttLanguage}</span>
                  <span>{formatAudioDuration(result.audioDurationSeconds)}</span>
                  <span>{result.transcriptionDurationMs} ms</span>
                  {result.score && <span title={`Reference: ${result.score.referenceTranscript}`}>{formatScore(result.score)}</span>}
                </div>
                <p>{result.transcript || "-"}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel benchmark-panel" aria-busy={isRunningBatch}>
        <div className="benchmark-header">
          <div>
            <h2>Benchmark set</h2>
            <p>Compare 1-3 STT candidates over every corrected {formatBenchmarkSetSplit(batchSplit)} segment</p>
          </div>
          <div className="batch-controls">
            <select
              aria-label="STT benchmark set split to run"
              className="secondary-select"
              disabled={isRunningBatch || isBenchmarking}
              value={batchSplit}
              onChange={(event) => {
                const split = event.currentTarget.value;
                if (isSttBenchmarkSetSplit(split)) {
                  setBatchSplit(split);
                }
              }}
            >
              <option value="test_frozen">Test frozen</option>
              <option value="validation">Validation</option>
            </select>
            <button
              className="secondary-button"
              disabled={isRunningBatch || isBenchmarking || selectedBenchmarkModels.length < 1}
              onClick={runAnalysis}
            >
              {isRunningBatch ? "Running" : "Run analysis"}
            </button>
          </div>
        </div>

        {benchmarkModels.length > 0 && (
          <div className="candidate-checkbox-row" role="group" aria-label="STT candidates to compare (1-3)">
            {benchmarkModels.map((model) => {
              const isChecked = selectedBenchmarkModels.includes(model);
              return (
                <label key={model} className="candidate-checkbox">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isRunningBatch || isBenchmarking || (!isChecked && selectedBenchmarkModels.length >= 3)}
                    onChange={() => toggleBenchmarkModel(model)}
                  />
                  {model}
                </label>
              );
            })}
          </div>
        )}

        {batchError && <pre className="error">{batchError}</pre>}

        {batchProgress && (
          <div className="batch-progress">
            <div className="batch-progress-counts">
              <span className="batch-count">Total {batchProgress.total}</span>
              <span className="batch-count">Queued {batchProgress.queued}</span>
              <span className="batch-count">Running {batchProgress.running}</span>
              <span className="batch-count batch-count-done">Done {batchProgress.done}</span>
              <span className="batch-count batch-count-failed">Failed {batchProgress.failed}</span>
            </div>
            {batchProgress.current && (
              <p className="batch-current" title={`${batchProgress.current.sessionId} / ${batchProgress.current.segmentId}`}>
                Running {batchProgress.current.sessionId} / {batchProgress.current.segmentId}
              </p>
            )}
            {batchProgress.lastOutcome && (
              <p className={batchProgress.lastOutcome.status === "failed" ? "batch-last batch-last-failed" : "batch-last"}>
                {batchProgress.lastOutcome.status === "failed"
                  ? `Failed ${batchProgress.lastOutcome.sessionId} / ${batchProgress.lastOutcome.segmentId}: ${batchProgress.lastOutcome.error ?? "error"}`
                  : `Done ${batchProgress.lastOutcome.sessionId} / ${batchProgress.lastOutcome.segmentId} (${batchProgress.lastOutcome.resultCount} candidates)`}
              </p>
            )}
          </div>
        )}

        {batchProgress && batchProgress.total === 0 && !isRunningBatch && (
          <p className="empty-state">No corrected segments in {formatBenchmarkSetSplit(batchSplit)} yet.</p>
        )}

        {batchOutcomes.length > 0 && (
          <div className="batch-outcomes">
            {batchOutcomes.map((outcome) => (
              <article
                className={outcome.status === "failed" ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
                key={`${outcome.sessionId}/${outcome.segmentId}`}
              >
                <div className="batch-outcome-heading">
                  <strong title={`${outcome.sessionId} / ${outcome.segmentId}`}>
                    {outcome.sessionId} / {outcome.segmentId}
                  </strong>
                  <em
                    className={
                      outcome.status === "failed" ? "batch-outcome-state batch-outcome-state-failed" : "batch-outcome-state"
                    }
                  >
                    {outcome.status}
                  </em>
                </div>
                {outcome.status === "failed" ? (
                  <p className="batch-outcome-error">{outcome.error ?? "Benchmark failed"}</p>
                ) : (
                  <p className="batch-outcome-meta">
                    {outcome.results.length} candidates{formatBatchOutcomeScore(outcome)}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel summary-panel">
        <div className="benchmark-header">
          <div>
            <h2>Candidate summary</h2>
            <p>
              Compare {selectedBenchmarkModels.length > 0 ? selectedBenchmarkModels.join(", ") : "checked candidates"} over{" "}
              {formatBenchmarkSetSplit(batchSplit)}. CER/WER: lower is better.
            </p>
          </div>
          <button className="secondary-button" disabled={isSummarizing} onClick={summarizeCandidates}>
            {isSummarizing ? "Summarizing" : "Summarize by candidate"}
          </button>
        </div>

        {summaryError && <pre className="error">{summaryError}</pre>}

        <p className="empty-state">
          {currentSelection
            ? `Selected base candidate: ${formatCandidateIdentity(currentSelection.candidate)} — ${currentSelection.selectionReason}${
                currentSelection.createdAt ? ` (${formatTimestamp(currentSelection.createdAt)})` : ""
              }. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting.`
            : "No base STT candidate selected yet. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting."}
        </p>

        {!candidateSummary && (
          <p className="empty-state">Run analysis above, or summarize by candidate, to see per-candidate scores.</p>
        )}

        {candidateSummary && candidateSummary.split !== batchSplit && (
          <p className="empty-state">
            Showing {formatBenchmarkSetSplit(candidateSummary.split)}; select the split again and re-run to refresh.
          </p>
        )}

        {candidateSummary && candidateSummary.totalSegments === 0 && (
          <p className="empty-state">No corrected segments in {formatBenchmarkSetSplit(candidateSummary.split)} yet.</p>
        )}

        {candidateSummary && candidateSummary.totalSegments > 0 && candidateSummary.candidates.length === 0 && (
          <p className="empty-state">No candidate results match the checked candidates above yet.</p>
        )}

        {candidateSummary && candidateSummary.candidates.length > 0 && (
          <>
            <div className="actions">
              <input
                aria-label="Candidate selection reason"
                className="reason-input"
                placeholder="Selection reason (e.g. best quality/latency tradeoff on test_frozen)"
                value={selectionReasonDraft}
                onChange={(event) => setSelectionReasonDraft(event.target.value)}
              />
            </div>

            {selectionError && <pre className="error">{selectionError}</pre>}

            <table className="summary-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Segments</th>
                  <th>Mean CER</th>
                  <th>Median CER</th>
                  <th>Mean WER</th>
                  <th>Median WER</th>
                  <th>Mean latency</th>
                  <th>Missing</th>
                  <th>Selection</th>
                </tr>
              </thead>
              <tbody>
                {candidateSummary.candidates.map((summary) => {
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
          </>
        )}
      </section>

      <section className="panel error-analysis-panel">
        <div className="benchmark-header">
          <div>
            <h2>Error analysis</h2>
            <p>Heuristic diagnostics from the last benchmark set run, not a training signal</p>
          </div>
        </div>

        {errorAnalysis.length === 0 ? (
          <p className="empty-state">Run analysis above to see per-candidate error diagnostics.</p>
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
                    <li className="error-example" key={`${example.sessionId}/${example.segmentId}/${example.category}/${index}`}>
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
  );
}

type DatasetViewProps = {
  segments: ReconstructedSegment[];
  benchmarkModels: string[];
  builderMode: "paste" | "segment";
  setBuilderMode: (mode: "paste" | "segment") => void;
  builderSegmentKey: string;
  setBuilderSegmentKey: (key: string) => void;
  builderReferenceModel: string;
  setBuilderReferenceModel: (model: string) => void;
  builderRawTranscript: string;
  setBuilderRawTranscript: (value: string) => void;
  builderLiteral: string;
  setBuilderLiteral: (value: string) => void;
  builderNotation: string;
  setBuilderNotation: (value: string) => void;
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
  onBack: () => void;
};

function DatasetView({
  segments,
  benchmarkModels,
  builderMode,
  setBuilderMode,
  builderSegmentKey,
  setBuilderSegmentKey,
  builderReferenceModel,
  setBuilderReferenceModel,
  builderRawTranscript,
  setBuilderRawTranscript,
  builderLiteral,
  setBuilderLiteral,
  builderNotation,
  setBuilderNotation,
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
  onBack,
}: DatasetViewProps): React.ReactElement {
  const summary = datasetExportSummary;
  const selectedBuilderSegment = segments.find((segment) => getSegmentKey(segment) === builderSegmentKey) ?? null;
  const canSaveBuilderEntry = builderLiteral.trim().length > 0 && !isSavingBuilderEntry;

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Dataset</h1>
        </div>
        <button className="secondary-button" onClick={onBack}>
          Back to segments
        </button>
      </header>

      <section className="panel" aria-busy={isSavingBuilderEntry}>
        <div className="benchmark-header">
          <div>
            <h2>Build a dataset entry</h2>
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
            Paste a transcription
          </label>
          <label className="candidate-checkbox">
            <input
              type="radio"
              name="builder-source"
              checked={builderMode === "segment"}
              onChange={() => setBuilderMode("segment")}
            />
            Pick a DicTeX segment
          </label>
        </div>

        {builderMode === "paste" ? (
          <>
            <p className="transcript-label">Reference STT model (tags the pasted transcript, if any)</p>
            <select
              aria-label="Reference STT model"
              className="secondary-select"
              value={builderReferenceModel}
              onChange={(event) => setBuilderReferenceModel(event.target.value)}
            >
              {benchmarkModels.length === 0 && <option value="">no candidates</option>}
              {benchmarkModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <p className="transcript-label">Pasted transcription (raw STT, optional)</p>
            <textarea
              aria-label="Pasted transcription"
              placeholder="Paste DicTeX's raw transcript here, or leave empty for a notation-only entry"
              value={builderRawTranscript}
              onChange={(event) => setBuilderRawTranscript(event.target.value)}
            />
          </>
        ) : (
          <>
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
            {segments.length === 0 && (
              <p className="empty-state">No DicTeX segments found yet — refresh from the Segments view.</p>
            )}
            {selectedBuilderSegment && (
              <p className="correction-raw">Raw: {selectedBuilderSegment.transcript || "-"}</p>
            )}
          </>
        )}

        <p className="transcript-label">Layer 1 — literal-correct transcript (verbal)</p>
        <textarea
          aria-label="Layer 1: literal transcript"
          placeholder="e.g. x au carré plus deux"
          value={builderLiteral}
          onChange={(event) => setBuilderLiteral(event.target.value)}
        />

        <p className="transcript-label">Layer 2 — normalized notation (LaTeX/KaTeX-compatible)</p>
        <textarea
          aria-label="Layer 2: normalized notation"
          placeholder="e.g. x^2 + 2"
          disabled={builderLiteral.trim().length === 0}
          value={builderNotation}
          onChange={(event) => setBuilderNotation(event.target.value)}
        />

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
      </section>

      <section className="panel" aria-busy={isExportingDataset}>
        <div className="benchmark-header">
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

function CorrectionKindSelect({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: CorrectionKind | "";
  onChange: (kind: CorrectionKind | "") => void;
  disabled?: boolean;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <select
      aria-label={ariaLabel}
      className="secondary-select"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onChange(isCorrectionKind(next) ? next : "");
      }}
    >
      <option value="">Correction kind…</option>
      {CORRECTION_KIND_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
