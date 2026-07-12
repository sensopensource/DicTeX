import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STT_BENCHMARK_RUN_EXPORT_FILES,
  type SttBenchmarkRunExport,
} from "@dictex/shared";
import { writeSttBenchmarkRunExport } from "./benchmarkRunExportWriter.js";

function fixture(): SttBenchmarkRunExport {
  return {
    manifest: {
      schema_version: 1,
      export_type: "stt_benchmark_run_llm",
      run_id: "run_1",
      exported_at: "2026-07-12T11:00:00.000Z",
      run_started_at: "2026-07-12T10:00:00.000Z",
      run_finished_at: "2026-07-12T10:05:00.000Z",
      stage: "stt",
      dataset_kind: "acoustic",
      split: "validation",
      status: { done: 1, failed: 0 },
      snapshot: {
        source_event: "stt_benchmark_run_started",
        segment_count: 1,
        dataset_file: STT_BENCHMARK_RUN_EXPORT_FILES.dataset,
      },
      files: {
        dataset: STT_BENCHMARK_RUN_EXPORT_FILES.dataset,
        outputs: STT_BENCHMARK_RUN_EXPORT_FILES.outputs,
      },
      scoring: { cer: "cer", wer: "wer", limitations: [] },
      prompt_variants: [],
      candidates: [
        { stage: "stt", provider: "faster-whisper", model: "small", variant: "cpu-int8-fr", prompt_variant_id: null },
      ],
    },
    dataset: [
      {
        split: "validation",
        dataset_kind: "acoustic",
        session_id: "session_a",
        segment_id: "seg_1",
        audio_ref: "audio/session_a/seg_1.webm",
        audio_path: "C:\\data\\audio\\session_a\\seg_1.webm",
        reference_transcript: "bonjour",
        correction_created_at: "2026-07-12T09:00:00.000Z",
      },
    ],
    outputs: [
      {
        session_id: "session_a",
        segment_id: "seg_1",
        outputs: [
          {
            candidate: { stage: "stt", provider: "faster-whisper", model: "small", variant: "cpu-int8-fr" },
            prompt_variant_id: null,
            status: "done",
            transcript: "bonjour",
            latency_ms: 900,
            cer: 0,
            wer: 0,
            error: null,
          },
        ],
      },
    ],
  };
}

test("writeSttBenchmarkRunExport: writes exactly the three portable package files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dictex-run-export-"));
  const summary = await writeSttBenchmarkRunExport(root, fixture());

  assert.deepEqual((await readdir(summary.exportDir)).sort(), Object.values(STT_BENCHMARK_RUN_EXPORT_FILES).sort());
  const manifest = JSON.parse(
    await readFile(path.join(summary.exportDir, STT_BENCHMARK_RUN_EXPORT_FILES.manifest), "utf8"),
  ) as { files: { dataset: string; outputs: string } };
  assert.deepEqual(manifest.files, {
    dataset: "dataset.acoustic.jsonl",
    outputs: "outputs.jsonl",
  });
  assert.match(
    await readFile(path.join(summary.exportDir, STT_BENCHMARK_RUN_EXPORT_FILES.dataset), "utf8"),
    /session_a/,
  );
  assert.equal(summary.missingOutputs, 0);
});

test("writeSttBenchmarkRunExport: never overwrites an earlier export with the same timestamp", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dictex-run-export-"));
  const first = await writeSttBenchmarkRunExport(root, fixture());
  const second = await writeSttBenchmarkRunExport(root, fixture());

  assert.notEqual(first.exportDir, second.exportDir);
  assert.equal((await readdir(root)).length, 2);
});
