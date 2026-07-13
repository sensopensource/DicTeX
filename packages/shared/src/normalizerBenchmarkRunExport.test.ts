import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildNormalizerBenchmarkCandidate,
  buildNormalizerBenchmarkPipelineSnapshot,
  prepareNormalizerBenchmarkResultForStorage,
} from "./normalizerBenchmark.js";
import {
  buildNormalizerBenchmarkRunExport,
  NORMALIZER_BENCHMARK_RUN_EXPORT_FILES,
  parseNormalizerBenchmarkRunExportFiles,
  validateNormalizerBenchmarkRunExport,
} from "./normalizerBenchmarkRunExport.js";
import { containsSentinel } from "./commands.js";
import { createTranscriptNormalizer } from "./normalizer.js";
import type {
  BenchmarkMathTransformRunFinishedEvent,
  BenchmarkMathTransformRunStartedEvent,
  BenchmarkMathTransformResultEvent,
} from "./benchmarkContract.js";
import type { LocalEvent } from "./localEvents.js";

async function fixture(): Promise<{
  events: LocalEvent[];
  runId: string;
  directory: string;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-export-"));
  const dictionaryPath = path.join(directory, "dictionary.json");
  writeFileSync(
    dictionaryPath,
    JSON.stringify({
      version: 1,
      entries: [
        { from: "dic tex", to: "DicTeX" },
        { from: "", to: "ignored" },
      ],
    }),
    "utf8",
  );
  const normalizer = await createTranscriptNormalizer({
    dictionaryPath,
    rulesPath: path.join(directory, "absent-rules.json"),
  });
  const candidate = buildNormalizerBenchmarkCandidate(normalizer.version).candidate;
  const runId = "run_normalizer_export";
  const snapshot = [
    {
      stage: "math_transform" as const,
      session_id: "session_export",
      segment_id: "seg_done",
      layer1_input: "dic tex retour à la ligne x au carré plus y",
      layer2_target: "DicTeX retour à la ligne $x^{2} + y$",
      math_transform_correction_created_at: "2026-07-13T08:00:00.000Z",
    },
    {
      stage: "math_transform" as const,
      session_id: "session_export",
      segment_id: "seg_failed",
      layer1_input: "failure input",
      layer2_target: "$f$",
      math_transform_correction_created_at: "2026-07-13T08:01:00.000Z",
    },
    {
      stage: "math_transform" as const,
      session_id: "session_export",
      segment_id: "seg_missing",
      layer1_input: "missing input",
      layer2_target: "$m$",
      math_transform_correction_created_at: "2026-07-13T08:02:00.000Z",
    },
  ];
  const start: BenchmarkMathTransformRunStartedEvent = {
    event_type: "benchmark_run_started",
    run_id: runId,
    created_at: "2026-07-13T09:00:00.000Z",
    stage: "math_transform",
    dataset_kind: "math_transform",
    split: "validation",
    candidates: [candidate],
    snapshot,
    pipeline_snapshot: buildNormalizerBenchmarkPipelineSnapshot(
      normalizer.pipelineSnapshot,
      normalizer.version,
    ),
  };
  const normalized = await normalizer.normalize(snapshot[0].layer1_input, { detailedTrace: true });
  const stored = prepareNormalizerBenchmarkResultForStorage(normalized);
  const result: BenchmarkMathTransformResultEvent = {
    event_type: "benchmark_result",
    run_id: runId,
    created_at: "2026-07-13T09:00:01.000Z",
    stage: "math_transform",
    session_id: "session_export",
    segment_id: "seg_done",
    candidate,
    output_transcript: stored.outputTranscript,
    transformation_duration_ms: 4,
    layers: stored.layers,
    operations: stored.operations,
  };
  const terminal: BenchmarkMathTransformRunFinishedEvent = {
    event_type: "benchmark_run_finished",
    run_id: runId,
    created_at: "2026-07-13T09:00:02.000Z",
    stage: "math_transform",
    done: 1,
    failed: 1,
    failures: [
      {
        session_id: "session_export",
        segment_id: "seg_failed",
        candidate,
        error: "synthetic execution failure",
      },
    ],
  };
  return { events: [start, result, terminal], runId, directory };
}

test("normalizer export freezes full provenance, compact operation refs and every outcome", async () => {
  const { events, runId, directory } = await fixture();
  try {
    const runExport = buildNormalizerBenchmarkRunExport(events, runId, "2026-07-13T10:00:00.000Z");
    assert.deepEqual(runExport.dataset.map((record) => record.segment_id), ["seg_done", "seg_failed", "seg_missing"]);
    assert.deepEqual(
      runExport.outputs.map((record) => record.outputs[0].status),
      ["done", "failed", "missing"],
    );
    assert.equal(runExport.outputs[0].outputs[0].exact_match, true);
    assert.equal(runExport.outputs[0].outputs[0].output_canonical, "DicTeX retour à la ligne $x^{2} + y$");
    assert.deepEqual(runExport.manifest.status, { done: 1, failed: 1, missing: 1 });
    assert.equal(runExport.manifest.privacy.contains_personal_dictionary, true);
    assert.equal(runExport.manifest.pipeline_snapshot.dictionary.source_state, "file");
    assert.equal(runExport.manifest.pipeline_snapshot.dictionary.source_content?.includes("dic tex"), true);
    assert.equal(runExport.manifest.pipeline_snapshot.dictionary.ignored_entries.length, 1);
    assert.equal(runExport.manifest.pipeline_snapshot.regex_rules.source_state, "default_absent");
    assert.ok(runExport.manifest.pipeline_snapshot.regex_rules.effective_rules.length > 1);
    assert.deepEqual(
      runExport.outputs[0].outputs[0].operations.map((operation) => operation.operation),
      ["dictionary", "command", "regex", "regex"],
    );
    const regexOperations = runExport.outputs[0].outputs[0].operations.filter(
      (operation) => operation.operation === "regex",
    );
    assert.ok(regexOperations.every((operation) => operation.occurrences[0].replacement_text));
    assert.equal(JSON.stringify(runExport.outputs).includes('"pattern"'), false, "static regex definitions stay in manifest");
    assert.equal(containsSentinel(JSON.stringify(runExport)), false);
    assert.deepEqual(validateNormalizerBenchmarkRunExport(runExport), { valid: true, errors: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizer export is reproducible from the run and ignores later corpus state", async () => {
  const { events, runId, directory } = await fixture();
  try {
    const before = buildNormalizerBenchmarkRunExport(events, runId, "2026-07-13T10:00:00.000Z");
    events.push({
      event_type: "stt_correction",
      session_id: "session_export",
      segment_id: "seg_done",
      raw_transcript: "changed later",
      corrected_transcript: "$changed$",
      correction_kind: "math_transform",
      created_at: "2026-07-13T11:00:00.000Z",
    });
    const after = buildNormalizerBenchmarkRunExport(events, runId, "2026-07-13T12:00:00.000Z");
    assert.deepEqual(after.dataset, before.dataset);
    assert.deepEqual(after.outputs, before.outputs);
    assert.deepEqual(after.manifest.pipeline_snapshot, before.manifest.pipeline_snapshot);
    assert.notEqual(after.manifest.exported_at, before.manifest.exported_at);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historical provenance and unfinished runs are refused without consulting current config", async () => {
  const { events, runId, directory } = await fixture();
  try {
    const historical = structuredClone(events);
    const start = historical[0] as BenchmarkMathTransformRunStartedEvent;
    delete start.pipeline_snapshot;
    assert.throws(
      () => buildNormalizerBenchmarkRunExport(historical, runId, "2026-07-13T10:00:00.000Z"),
      /predates complete pipeline provenance/,
    );
    assert.throws(
      () => buildNormalizerBenchmarkRunExport(events.slice(0, 2), runId, "2026-07-13T10:00:00.000Z"),
      /not finished/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the three serialized files round-trip through the package reader and validator", async () => {
  const { events, runId, directory } = await fixture();
  try {
    const runExport = buildNormalizerBenchmarkRunExport(events, runId, "2026-07-13T10:00:00.000Z");
    const parsed = parseNormalizerBenchmarkRunExportFiles({
      manifest: JSON.stringify(runExport.manifest),
      dataset: `${runExport.dataset.map((record) => JSON.stringify(record)).join("\n")}\n`,
      outputs: `${runExport.outputs.map((record) => JSON.stringify(record)).join("\n")}\n`,
    });
    assert.deepEqual(parsed, runExport);
    assert.deepEqual(runExport.manifest.files, {
      dataset: NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset,
      outputs: NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.outputs,
    });
    const corrupted = structuredClone(runExport);
    corrupted.outputs[0].outputs[0].target_canonical = "$not-the-frozen-target$";
    const invalid = validateNormalizerBenchmarkRunExport(corrupted);
    assert.equal(invalid.valid, false);
    if (!invalid.valid) {
      assert.ok(invalid.errors.some((error) => /frozen dataset/.test(error)));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
