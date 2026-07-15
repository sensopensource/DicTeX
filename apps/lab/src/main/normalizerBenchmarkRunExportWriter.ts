import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NORMALIZER_BENCHMARK_RUN_EXPORT_FILES,
  parseNormalizerBenchmarkRunExportFiles,
  type NormalizerBenchmarkRunExport,
  type NormalizerBenchmarkRunExportSummary,
} from "@dictex/shared";

export async function writeNormalizerBenchmarkRunExport(
  exportsRoot: string,
  runExport: NormalizerBenchmarkRunExport,
): Promise<NormalizerBenchmarkRunExportSummary> {
  await mkdir(exportsRoot, { recursive: true });
  const folderStamp = runExport.manifest.exported_at.replace(/[^0-9A-Za-z_-]/g, "-");
  const exportDir = await reserveExportDirectory(exportsRoot, `normalizer-benchmark-run-${folderStamp}`);

  await Promise.all([
    writeFile(
      path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.manifest),
      `${JSON.stringify(runExport.manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
    writeFile(
      path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset),
      serializeJsonLines(runExport.dataset),
      { encoding: "utf8", flag: "wx" },
    ),
    writeFile(
      path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.outputs),
      serializeJsonLines(runExport.outputs),
      { encoding: "utf8", flag: "wx" },
    ),
  ]);

  const missingOutputs = runExport.outputs.reduce(
    (count, record) => count + record.outputs.filter((output) => output.status === "missing").length,
    0,
  );
  return {
    exportType: "normalizer_benchmark_run_llm",
    runId: runExport.manifest.run_id,
    createdAt: runExport.manifest.exported_at,
    exportDir,
    segmentCount: runExport.dataset.length,
    candidateCount: runExport.manifest.candidates.length,
    done: runExport.manifest.status.done,
    failed: runExport.manifest.status.failed,
    missingOutputs,
    containsPersonalDictionary: runExport.manifest.privacy.contains_personal_dictionary,
  };
}

/** Filesystem reader used by tests and future local analysis tooling. */
export async function readNormalizerBenchmarkRunExport(exportDir: string): Promise<NormalizerBenchmarkRunExport> {
  const names = (await readdir(exportDir)).sort();
  const expected = Object.values(NORMALIZER_BENCHMARK_RUN_EXPORT_FILES).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Normalizer benchmark export must contain exactly ${expected.join(", ")}`);
  }
  const [manifest, dataset, outputs] = await Promise.all([
    readFile(path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.manifest), "utf8"),
    readFile(path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset), "utf8"),
    readFile(path.join(exportDir, NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.outputs), "utf8"),
  ]);
  return parseNormalizerBenchmarkRunExportFiles({ manifest, dataset, outputs });
}

async function reserveExportDirectory(exportsRoot: string, baseName: string): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = path.join(exportsRoot, suffix === 1 ? baseName : `${baseName}-${suffix}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
}

function serializeJsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}
