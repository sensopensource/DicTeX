import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNormalizerBenchmarkCandidate,
  buildNormalizerBenchmarkPipelineSnapshot,
  buildNormalizerBenchmarkRunExport,
  createTranscriptNormalizer,
  NORMALIZER_BENCHMARK_RUN_EXPORT_FILES,
  prepareNormalizerBenchmarkResultForStorage,
  type BenchmarkMathTransformRunFinishedEvent,
  type BenchmarkMathTransformRunStartedEvent,
  type BenchmarkMathTransformResultEvent,
  type LocalEvent,
} from "@dictex/shared";
import {
  readNormalizerBenchmarkRunExport,
  writeNormalizerBenchmarkRunExport,
} from "./normalizerBenchmarkRunExportWriter.js";

async function fixture() {
  const configRoot = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-writer-config-"));
  const dictionaryPath = path.join(configRoot, "dictionary.json");
  writeFileSync(dictionaryPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  const normalizer = await createTranscriptNormalizer({
    dictionaryPath,
    rulesPath: path.join(configRoot, "absent-rules.json"),
  });
  const candidate = buildNormalizerBenchmarkCandidate(normalizer.version).candidate;
  const runId = "run_writer";
  const member = {
    stage: "math_transform" as const,
    session_id: "session_writer",
    segment_id: "seg_1",
    layer1_input: "x au carré",
    layer2_target: "$x^{2}$",
    math_transform_correction_created_at: "2026-07-13T09:00:00.000Z",
  };
  const normalized = prepareNormalizerBenchmarkResultForStorage(
    await normalizer.normalize(member.layer1_input, { detailedTrace: true }),
  );
  const start: BenchmarkMathTransformRunStartedEvent = {
    event_type: "benchmark_run_started",
    run_id: runId,
    created_at: "2026-07-13T10:00:00.000Z",
    stage: "math_transform",
    dataset_kind: "math_transform",
    split: "validation",
    candidates: [candidate],
    snapshot: [member],
    pipeline_snapshot: buildNormalizerBenchmarkPipelineSnapshot(normalizer.pipelineSnapshot, normalizer.version),
  };
  const result: BenchmarkMathTransformResultEvent = {
    event_type: "benchmark_result",
    run_id: runId,
    created_at: "2026-07-13T10:00:01.000Z",
    stage: "math_transform",
    session_id: member.session_id,
    segment_id: member.segment_id,
    candidate,
    output_transcript: normalized.outputTranscript,
    transformation_duration_ms: 2,
    layers: normalized.layers,
    operations: normalized.operations,
  };
  const terminal: BenchmarkMathTransformRunFinishedEvent = {
    event_type: "benchmark_run_finished",
    run_id: runId,
    created_at: "2026-07-13T10:00:02.000Z",
    stage: "math_transform",
    done: 1,
    failed: 0,
    failures: [],
  };
  return {
    configRoot,
    runExport: buildNormalizerBenchmarkRunExport(
      [start, result, terminal] satisfies LocalEvent[],
      runId,
      "2026-07-13T11:00:00.000Z",
    ),
  };
}

test("normalizer writer creates exactly three files and the filesystem reader validates them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-writer-"));
  const { configRoot, runExport } = await fixture();
  try {
    const summary = await writeNormalizerBenchmarkRunExport(root, runExport);
    assert.deepEqual(
      (await readdir(summary.exportDir)).sort(),
      Object.values(NORMALIZER_BENCHMARK_RUN_EXPORT_FILES).sort(),
    );
    assert.deepEqual(await readNormalizerBenchmarkRunExport(summary.exportDir), runExport);
    assert.equal(summary.segmentCount, 1);
    assert.equal(summary.missingOutputs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("normalizer writer preserves colliding exports and reader rejects extra files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-writer-"));
  const { configRoot, runExport } = await fixture();
  try {
    const first = await writeNormalizerBenchmarkRunExport(root, runExport);
    const second = await writeNormalizerBenchmarkRunExport(root, runExport);
    assert.notEqual(first.exportDir, second.exportDir);
    await writeFile(path.join(first.exportDir, "unexpected.txt"), "unexpected", "utf8");
    await assert.rejects(readNormalizerBenchmarkRunExport(first.exportDir), /must contain exactly/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
});
