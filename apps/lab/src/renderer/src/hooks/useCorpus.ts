import { useEffect, useState } from "react";
import type { ReconstructedSegment, SttBenchmarkSetSplit } from "@dictex/shared";
import { formatBenchmarkSetSplit, formatCorrectionKind, getSegmentKey } from "@dictex/shared/formatting";
import { planCorpusCorrection, type CorpusCorrectionLayer } from "../corpusCorrection.js";
import type { DataFolderStatus, LabApi, SourceFolderCheck } from "../api.js";
import type { HistoryCorrectionTarget } from "../views/SegmentsView.js";

export type Corpus = {
  dataFolder: DataFolderStatus | null;
  sourceCheck: SourceFolderCheck | null;
  dataFolderDraft: string;
  setDataFolderDraft: (draft: string) => void;
  isSavingDataFolder: boolean;
  pickDataFolder: () => Promise<void>;
  applyDataFolderDraft: () => Promise<void>;
  resetDataFolder: () => Promise<void>;

  segments: ReconstructedSegment[];
  segmentsError: string;
  isLoadingSegments: boolean;
  loadSegments: () => Promise<void>;

  historyCorrectionTarget: HistoryCorrectionTarget | null;
  historyCorrectionDraft: string;
  editHistoryCorrectionDraft: (draft: string) => void;
  startSegmentCorrection: (segment: ReconstructedSegment, layer: CorpusCorrectionLayer) => void;
  cancelSegmentCorrection: () => void;
  saveSegmentCorrection: () => Promise<void>;
  isSavingCorrection: boolean;
  correctionNotice: string;

  benchmarkSetTargetKey: string | null;
  markSttBenchmarkSetMembership: (segment: ReconstructedSegment, split: SttBenchmarkSetSplit) => Promise<void>;
};

/**
 * Owns the corpus: the configured (read-only) DicTeX data folder, the segments
 * read from it, and the Lab's own corrections and split assignments over them.
 *
 * The folder and the segments are one concern, not two, because they depend on
 * each other in both directions: loading segments re-reads the folder status so
 * the "data folder ok" pill matches what was just read, and changing the folder
 * reloads the list from the new source. Splitting them would only turn that
 * cycle into two hooks that have to call back into each other.
 *
 * Writes never touch the source folder — `saveSttCorrection` and
 * `markSttBenchmarkSetMembership` append to the Lab's own event log — so this
 * hook reloads the segments after each write rather than mutating them in
 * place: the derived state the list shows is the one the main process rebuilt
 * from both logs, never a local guess about what the append produced.
 */
export function useCorpus({ api, onNotice }: { api: LabApi; onNotice: (message: string) => void }): Corpus {
  const [dataFolder, setDataFolder] = useState<DataFolderStatus | null>(null);
  const [sourceCheck, setSourceCheck] = useState<SourceFolderCheck | null>(null);
  const [dataFolderDraft, setDataFolderDraft] = useState("");
  const [isSavingDataFolder, setIsSavingDataFolder] = useState(false);

  const [segments, setSegments] = useState<ReconstructedSegment[]>([]);
  const [segmentsError, setSegmentsError] = useState("");
  const [isLoadingSegments, setIsLoadingSegments] = useState(false);

  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [benchmarkSetTargetKey, setBenchmarkSetTargetKey] = useState<string | null>(null);
  const [historyCorrectionTarget, setHistoryCorrectionTarget] = useState<HistoryCorrectionTarget | null>(null);
  const [historyCorrectionDraft, setHistoryCorrectionDraft] = useState("");

  async function refreshDataFolder(): Promise<void> {
    try {
      const [status, check] = await Promise.all([api.getDataFolder(), api.checkDataFolder()]);
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

  useEffect(() => {
    void refreshDataFolder();
    void loadSegments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickDataFolder(): Promise<void> {
    setIsSavingDataFolder(true);
    try {
      const status = await api.pickDataFolder();
      if (status) {
        setDataFolder(status);
        onNotice(`DicTeX data folder set to ${status.path}`);
        await loadSegments();
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not set data folder");
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
      onNotice(`DicTeX data folder set to ${status.path}`);
      await loadSegments();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not set data folder");
    } finally {
      setIsSavingDataFolder(false);
    }
  }

  async function resetDataFolder(): Promise<void> {
    setIsSavingDataFolder(true);
    try {
      const status = await api.resetDataFolder();
      setDataFolder(status);
      onNotice(`DicTeX data folder reset to default (${status.path})`);
      await loadSegments();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not reset data folder");
    } finally {
      setIsSavingDataFolder(false);
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
    onNotice(`Correction target ${segment.sessionId} / ${segment.segmentId}`);
  }

  function cancelSegmentCorrection(): void {
    setHistoryCorrectionTarget(null);
    setHistoryCorrectionDraft("");
  }

  /** Typing into the editor clears the previous save's notice, which no longer describes the draft. */
  function editHistoryCorrectionDraft(draft: string): void {
    setHistoryCorrectionDraft(draft);
    setCorrectionNotice("");
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

  async function markSttBenchmarkSetMembership(
    segment: ReconstructedSegment,
    split: SttBenchmarkSetSplit,
  ): Promise<void> {
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
      onNotice(`Marked ${marked.sessionId} / ${marked.segmentId} as ${formatBenchmarkSetSplit(marked.split)}`);
      void loadSegments();
    } catch (markError) {
      setSegmentsError(markError instanceof Error ? markError.message : "Could not mark benchmark set membership");
    } finally {
      setBenchmarkSetTargetKey(null);
    }
  }

  return {
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

    historyCorrectionTarget,
    historyCorrectionDraft,
    editHistoryCorrectionDraft,
    startSegmentCorrection,
    cancelSegmentCorrection,
    saveSegmentCorrection,
    isSavingCorrection,
    correctionNotice,

    benchmarkSetTargetKey,
    markSttBenchmarkSetMembership,
  };
}
