import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSttBenchmarkRunExport,
  STT_BENCHMARK_RUN_EXPORT_FILES,
  type LocalEvent,
} from "./index.js";

const runId = "run_20260712T100000000Z_test";

function baseEvents(): LocalEvent[] {
  return [
    {
      event_type: "stt_benchmark_run_started",
      run_id: runId,
      created_at: "2026-07-12T10:00:00.000Z",
      stage: "stt",
      dataset_kind: "acoustic",
      split: "validation",
      candidates: [
        {
          stage: "stt",
          provider: "faster-whisper",
          model: "small",
          variant: "cpu-int8-fr",
          prompt_variant: null,
        },
        {
          stage: "stt",
          provider: "faster-whisper",
          model: "small",
          variant: "cpu-int8-fr+math-fr",
          prompt_variant: "math-fr",
        },
      ],
      prompt_definitions: [
        { id: "math-fr", display_name: "Math French", prompt_text: "Dictée mathématique en français." },
      ],
      snapshot: [
        {
          session_id: "session_a",
          segment_id: "seg_1",
          audio_ref: "audio/session_a/seg_1.webm",
          reference_transcript: "x au carré",
          correction_created_at: "2026-07-12T09:00:00.000Z",
        },
        {
          session_id: "session_a",
          segment_id: "seg_2",
          audio_ref: "audio/session_a/seg_2.webm",
          reference_transcript: "deux plus deux",
          correction_created_at: "2026-07-12T09:01:00.000Z",
        },
      ],
    },
    {
      event_type: "stt_benchmark_result",
      run_id: runId,
      session_id: "session_a",
      segment_id: "seg_1",
      audio_ref: "audio/session_a/seg_1.webm",
      stage: "stt",
      provider: "faster-whisper",
      model: "small",
      variant: "cpu-int8-fr",
      transcript: "x au carre",
      transcription_duration_ms: 1200,
      score_metric: "cer",
      score_value: 0.1,
      score_reference_transcript: "x au carré",
    },
    {
      event_type: "stt_benchmark_result",
      run_id: runId,
      session_id: "session_a",
      segment_id: "seg_1",
      audio_ref: "audio/session_a/seg_1.webm",
      stage: "stt",
      provider: "faster-whisper",
      model: "small",
      variant: "cpu-int8-fr+math-fr",
      transcript: "x au carré",
      transcription_duration_ms: 1350,
      score_metric: "cer",
      score_value: 0,
      score_reference_transcript: "x au carré",
    },
    {
      event_type: "stt_benchmark_run_finished",
      run_id: runId,
      created_at: "2026-07-12T10:05:00.000Z",
      done: 1,
      failed: 1,
      failures: [{ session_id: "session_a", segment_id: "seg_2", error: "decoder failed" }],
    },
  ];
}

function build(events: LocalEvent[] = baseEvents()) {
  return buildSttBenchmarkRunExport(events, runId, {
    exportedAt: "2026-07-12T11:00:00.000Z",
    promptDefinitions: [],
    resolveAudioPath: (audioRef) => `C:\\DicTeXData\\${audioRef.replaceAll("/", "\\")}`,
  });
}

test("buildSttBenchmarkRunExport: joins every frozen segment to every candidate and represents failures", () => {
  const exported = build();

  assert.equal(exported.dataset.length, 2);
  assert.equal(exported.outputs.length, 2);
  assert.deepEqual(
    exported.outputs.map((record) => [record.session_id, record.segment_id, record.outputs.length]),
    [
      ["session_a", "seg_1", 2],
      ["session_a", "seg_2", 2],
    ],
  );

  const successful = exported.outputs[0].outputs;
  assert.deepEqual(successful.map((output) => output.status), ["done", "done"]);
  assert.equal(successful[1].strict_cer, 0);
  assert.equal(successful[1].acoustic_cer, 0);
  assert.equal(successful[1].wer, 0);
  assert.equal(successful[1].latency_ms, 1350);

  // seg_1's first candidate output "x au carre" vs reference "x au carré": a real
  // lexical difference, so both CERs stay non-zero (issue #134 neutralizes only
  // sentence punctuation, never letters).
  assert.ok((successful[0].strict_cer as number) > 0);
  assert.ok((successful[0].acoustic_cer as number) > 0);

  const failed = exported.outputs[1].outputs;
  assert.deepEqual(failed.map((output) => output.status), ["failed", "failed"]);
  assert.deepEqual(failed.map((output) => output.error), ["decoder failed", "decoder failed"]);
});

test("buildSttBenchmarkRunExport: includes each full prompt once and only relative package file references", () => {
  const exported = build();

  assert.deepEqual(exported.manifest.prompt_variants, [
    { id: "math-fr", display_name: "Math French", prompt_text: "Dictée mathématique en français." },
  ]);
  assert.equal(exported.manifest.candidates[0].prompt_variant_id, null);
  assert.equal(exported.manifest.candidates[1].prompt_variant_id, "math-fr");
  assert.deepEqual(exported.manifest.files, {
    dataset: STT_BENCHMARK_RUN_EXPORT_FILES.dataset,
    outputs: STT_BENCHMARK_RUN_EXPORT_FILES.outputs,
  });
  assert.equal(exported.manifest.snapshot.dataset_file, STT_BENCHMARK_RUN_EXPORT_FILES.dataset);
  assert.equal(exported.manifest.files.dataset.includes(":"), false);
  assert.equal(exported.manifest.files.outputs.includes("\\"), false);
});

test("buildSttBenchmarkRunExport: acoustic CER ignores only sentence punctuation, strict CER does not (schema v3)", () => {
  const events = baseEvents();
  const started = events[0] as Extract<LocalEvent, { event_type: "stt_benchmark_run_started" }>;
  // A candidate that heard the words but added a comma the reference lacks.
  started.snapshot[0].reference_transcript = "x au carré plus b";
  const result = events[1] as Extract<LocalEvent, { event_type: "stt_benchmark_result" }>;
  result.transcript = "x au carré, plus b";

  const exported = build(events);
  assert.equal(exported.manifest.schema_version, 3);

  const output = exported.outputs[0].outputs[0];
  assert.ok((output.strict_cer as number) > 0, "strict CER penalizes the extra comma");
  assert.equal(output.acoustic_cer, 0, "acoustic CER ignores the extra comma");

  // The manifest documents both metrics distinctly.
  assert.match(exported.manifest.scoring.strict_cer, /Strict CER/);
  assert.match(exported.manifest.scoring.acoustic_cer, /sentence-punctuation/);
});

test("buildSttBenchmarkRunExport: keeps the run snapshot after current validation and corrections change", () => {
  const events = baseEvents();
  events.push(
    {
      event_type: "stt_correction",
      created_at: "2026-07-12T12:00:00.000Z",
      session_id: "session_a",
      segment_id: "seg_1",
      audio_ref: "audio/session_a/seg_1.webm",
      raw_transcript: "x au carre",
      corrected_transcript: "CHANGED AFTER RUN",
      correction_kind: "acoustic",
    },
    {
      event_type: "stt_correction",
      created_at: "2026-07-12T12:00:30.000Z",
      session_id: "session_a",
      segment_id: "seg_1",
      audio_ref: "audio/session_a/seg_1.webm",
      raw_transcript: "CHANGED AFTER RUN",
      corrected_transcript: "$CHANGED^{2}$",
      correction_kind: "math_transform",
    },
    {
      event_type: "stt_benchmark_set_membership",
      created_at: "2026-07-12T12:01:00.000Z",
      session_id: "session_a",
      segment_id: "seg_1",
      audio_ref: "audio/session_a/seg_1.webm",
      split: "train_candidate_pool",
    },
  );

  const exported = build(events);
  assert.equal(exported.manifest.split, "validation");
  assert.equal(exported.dataset[0].reference_transcript, "x au carré");
  assert.equal(exported.dataset[0].correction_created_at, "2026-07-12T09:00:00.000Z");
});

test("buildSttBenchmarkRunExport: does not mutate source events", () => {
  const events = baseEvents();
  const before = JSON.stringify(events);
  build(events);
  assert.equal(JSON.stringify(events), before);
});

test("buildSttBenchmarkRunExport: preserves a legacy completed segment without output", () => {
  const events = baseEvents();
  const finished = events.at(-1) as Extract<LocalEvent, { event_type: "stt_benchmark_run_finished" }>;
  finished.done = 2;
  finished.failed = 0;
  finished.failures = [];

  const exported = build(events);
  assert.deepEqual(
    exported.outputs[1].outputs.map((output) => output.status),
    ["completed_without_output", "completed_without_output"],
  );
  assert.deepEqual(exported.outputs[1].outputs.map((output) => output.error), [null, null]);
});

test("buildSttBenchmarkRunExport: distinguishes an interrupted missing output from a failed segment", () => {
  const events = baseEvents();
  const finished = events.at(-1) as Extract<LocalEvent, { event_type: "stt_benchmark_run_finished" }>;
  finished.done = 1;
  finished.failed = 0;
  finished.failures = [];

  const exported = build(events);
  assert.deepEqual(exported.outputs[1].outputs.map((output) => output.status), ["missing", "missing"]);
  assert.deepEqual(exported.outputs[1].outputs.map((output) => output.error), [null, null]);
});

test("buildSttBenchmarkRunExport: rejects unfinished runs and missing prompt definitions", () => {
  const unfinished = baseEvents().slice(0, -1);
  assert.throws(() => build(unfinished), /not finished/);

  const withoutCapturedPrompt = baseEvents();
  const started = withoutCapturedPrompt[0] as Extract<LocalEvent, { event_type: "stt_benchmark_run_started" }>;
  delete started.prompt_definitions;
  assert.throws(
    () =>
      buildSttBenchmarkRunExport(withoutCapturedPrompt, runId, {
        exportedAt: "2026-07-12T11:00:00.000Z",
        promptDefinitions: [],
        resolveAudioPath: () => null,
      }),
    /Prompt definition unavailable/,
  );
});

test("buildSttBenchmarkRunExport: resolves a legacy #122 prompt through the compatibility input", () => {
  const events = baseEvents();
  const started = events[0] as Extract<LocalEvent, { event_type: "stt_benchmark_run_started" }>;
  delete started.prompt_definitions;

  const exported = buildSttBenchmarkRunExport(events, runId, {
    exportedAt: "2026-07-12T11:00:00.000Z",
    promptDefinitions: [
      { id: "math-fr", displayName: "Legacy Math", promptText: "Legacy prompt text." },
    ],
    resolveAudioPath: () => null,
  });
  assert.deepEqual(exported.manifest.prompt_variants, [
    { id: "math-fr", display_name: "Legacy Math", prompt_text: "Legacy prompt text." },
  ]);
});

test("buildSttBenchmarkRunExport: rejects a no-audio member instead of leaking math_transform data", () => {
  const events = baseEvents();
  const started = events[0] as Extract<LocalEvent, { event_type: "stt_benchmark_run_started" }>;
  started.snapshot[0].audio_ref = "";
  assert.throws(() => build(events), /without audio/);
});
