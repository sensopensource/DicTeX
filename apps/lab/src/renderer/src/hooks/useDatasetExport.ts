import { useState } from "react";
import type { SttDatasetExportSummary } from "@dictex/shared";
import type { LabApi } from "../api.js";

export type DatasetExport = {
  datasetExportSummary: SttDatasetExportSummary | null;
  datasetExportError: string;
  isExportingDataset: boolean;
  exportSttDataset: () => Promise<void>;
  openExportFolder: () => Promise<void>;
};

/**
 * Exports the corpus as `test_frozen`-compatible JSONL, one file per split and
 * per filled layer.
 *
 * `openExportFolder` falls back to the default export folder when no export has
 * run yet, unlike a run export which only ever opens the folder of the run it
 * just wrote.
 */
export function useDatasetExport({ api }: { api: LabApi }): DatasetExport {
  const [datasetExportSummary, setDatasetExportSummary] = useState<SttDatasetExportSummary | null>(null);
  const [datasetExportError, setDatasetExportError] = useState("");
  const [isExportingDataset, setIsExportingDataset] = useState(false);

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

  return {
    datasetExportSummary,
    datasetExportError,
    isExportingDataset,
    exportSttDataset,
    openExportFolder,
  };
}
