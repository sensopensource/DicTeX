import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STT_BENCHMARK_RUN_EXPORT_FILES,
  type SttBenchmarkRunExport,
  type SttBenchmarkRunExportSummary,
} from "@dictex/shared";

/** Writes exactly the three documented files into a newly-reserved folder. */
export async function writeSttBenchmarkRunExport(
  exportsRoot: string,
  runExport: SttBenchmarkRunExport,
): Promise<SttBenchmarkRunExportSummary> {
  await mkdir(exportsRoot, { recursive: true });
  const folderStamp = runExport.manifest.exported_at.replace(/[^0-9A-Za-z_-]/g, "-");
  const exportDir = await reserveExportDirectory(exportsRoot, `stt-benchmark-run-${folderStamp}`);

  await Promise.all([
    writeFile(
      path.join(exportDir, STT_BENCHMARK_RUN_EXPORT_FILES.manifest),
      `${JSON.stringify(runExport.manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
    writeFile(
      path.join(exportDir, STT_BENCHMARK_RUN_EXPORT_FILES.dataset),
      serializeJsonLines(runExport.dataset),
      { encoding: "utf8", flag: "wx" },
    ),
    writeFile(
      path.join(exportDir, STT_BENCHMARK_RUN_EXPORT_FILES.outputs),
      serializeJsonLines(runExport.outputs),
      { encoding: "utf8", flag: "wx" },
    ),
  ]);

  const missingOutputs = runExport.outputs.reduce(
    (count, record) => count + record.outputs.filter((output) => output.status === "missing").length,
    0,
  );

  return {
    runId: runExport.manifest.run_id,
    createdAt: runExport.manifest.exported_at,
    exportDir,
    segmentCount: runExport.dataset.length,
    candidateCount: runExport.manifest.candidates.length,
    done: runExport.manifest.status.done,
    failed: runExport.manifest.status.failed,
    missingOutputs,
  };
}

async function reserveExportDirectory(exportsRoot: string, baseName: string): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const folderName = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const candidate = path.join(exportsRoot, folderName);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }
  }
}

function serializeJsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
