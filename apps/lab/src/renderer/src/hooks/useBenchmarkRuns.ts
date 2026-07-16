import { useEffect, useMemo, useState } from "react";
import type { BenchmarkRunListEntry, SttBenchmarkSetSplit } from "@dictex/shared";
import {
  analyzeBatchErrors,
  toSttBenchmarkRunOutcomes,
  type CandidateErrorAnalysis,
} from "@dictex/shared/errorAnalysis";
import {
  applyLegacySummary,
  applyResultsError,
  applyRunDetail,
  emptyResultsState,
  LEGACY_RUN_KEY,
  startResultsSelection,
  type ResultsState,
} from "../resultsSelection.js";
import type { LabApi } from "../api.js";
import type { BenchmarkRunExportSummary } from "../views/ResultsView.js";

export type BenchmarkRuns = {
  resultsSplit: SttBenchmarkSetSplit;
  selectResultsSplit: (split: SttBenchmarkSetSplit) => void;
  runList: BenchmarkRunListEntry[];
  results: ResultsState;
  selectResult: (key: string) => Promise<void>;
  errorAnalysis: CandidateErrorAnalysis[];

  runExportSummary: BenchmarkRunExportSummary | null;
  runExportError: string;
  isExportingRun: boolean;
  exportSelectedRun: () => Promise<void>;
  openRunExportFolder: () => Promise<void>;

  /**
   * Shows a specific run of a specific split, as the launch path does when the
   * run it just created becomes the selected result.
   */
  showRun: (split: SttBenchmarkSetSplit, runKey: string) => Promise<void>;
};

/**
 * Reads one immutable benchmark run at a time (issue #138).
 *
 * The split here is a browse filter over the run list — it never drives a
 * launch, so changing it cannot change what a pending experiment would run.
 * The selection state machine lives in `../resultsSelection.ts`: it drops the
 * previous run's data before the new data lands and discards a response that no
 * longer answers the current selection, so a run can never be rendered against
 * another run's snapshot.
 */
export function useBenchmarkRuns({ api }: { api: LabApi }): BenchmarkRuns {
  const [resultsSplit, setResultsSplit] = useState<SttBenchmarkSetSplit>("validation");
  const [runList, setRunList] = useState<BenchmarkRunListEntry[]>([]);
  const [results, setResults] = useState<ResultsState>(emptyResultsState);
  const [runExportSummary, setRunExportSummary] = useState<BenchmarkRunExportSummary | null>(null);
  const [runExportError, setRunExportError] = useState("");
  const [isExportingRun, setIsExportingRun] = useState(false);

  // The error analysis of the SELECTED run, derived from that run's own logged
  // outputs — not from the in-memory outcomes of the last launch, which would
  // show the newest run's errors under an older run's header.
  const errorAnalysis = useMemo(
    () => (results.detail?.stage === "stt" ? analyzeBatchErrors(toSttBenchmarkRunOutcomes(results.detail)) : []),
    [results.detail],
  );

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
  }, [resultsSplit, api]);

  async function refreshRunList(split: SttBenchmarkSetSplit): Promise<void> {
    try {
      setRunList(await api.listBenchmarkRuns(split));
    } catch {
      setRunList([]);
    }
  }

  /**
   * Selects one result: a tracked run (its own snapshot, outputs, failures and
   * summary) or the legacy bucket of pre-#122 results.
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

  async function showRun(split: SttBenchmarkSetSplit, runKey: string): Promise<void> {
    setResultsSplit(split);
    await refreshRunList(split);
    await selectResult(runKey);
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

  return {
    resultsSplit,
    selectResultsSplit,
    runList,
    results,
    selectResult,
    errorAnalysis,

    runExportSummary,
    runExportError,
    isExportingRun,
    exportSelectedRun,
    openRunExportFolder,

    showRun,
  };
}
