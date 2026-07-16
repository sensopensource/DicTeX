import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateOptionMatchesModel,
  formatAudioDuration,
  formatBenchmarkRunOption,
  formatLatency,
  formatTimestamp,
  getCandidateRuntimeLabels,
  getSegmentKey,
  groupCandidateModelsByProvider,
  sameCandidateModel,
} from "./formatting.js";

test("builds one stable key from a segment identity", () => {
  assert.equal(getSegmentKey({ sessionId: "session_1", segmentId: "seg_2" }), "session_1/seg_2");
  assert.equal(
    getSegmentKey({ sessionId: "session_1", segmentId: "seg_2" }, { separator: "::" }),
    "session_1::seg_2",
  );
});

test("preserves compact and full timestamp presentation contracts", () => {
  assert.equal(formatTimestamp(null), "-");
  assert.equal(formatTimestamp(null, { missingLabel: "unknown time", style: "full" }), "unknown time");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");

  const timestamp = "2026-07-16T12:34:00.000Z";
  assert.equal(formatTimestamp(timestamp, { style: "full" }), new Date(timestamp).toLocaleString());
});

test("formats finite durations and latencies without exposing invalid numbers", () => {
  assert.equal(formatAudioDuration(1.234), "1.23 s");
  assert.equal(formatAudioDuration(Number.POSITIVE_INFINITY, { rejectNonFinite: true }), "-");
  assert.equal(formatLatency(12.6), "12.6 ms");
  assert.equal(formatLatency(12.6, { round: true }), "13 ms");
  assert.equal(formatLatency(Number.NaN, { rejectNonFinite: true }), "-");
});

test("formats run options with stage, plurality, and terminal status", () => {
  assert.equal(
    formatBenchmarkRunOption({
      runId: "run_1",
      createdAt: null,
      stage: "math_transform",
      datasetKind: "math_transform",
      split: "validation",
      snapshotSize: 1,
      candidateCount: 1,
      done: 1,
      failed: 0,
      finished: true,
    }),
    "run_1 · Normalizer · 1 member · 1 done / 0 failed",
  );

  assert.equal(
    formatBenchmarkRunOption({
      runId: "run_2",
      createdAt: null,
      stage: "stt",
      datasetKind: "acoustic",
      split: "test_frozen",
      snapshotSize: 2,
      candidateCount: 2,
      done: null,
      failed: null,
      finished: false,
    }),
    "run_2 · STT · 2 members · unfinished",
  );
});

test("groups candidate models by provider while preserving catalog order", () => {
  const catalog = [
    { providerLabel: "Faster Whisper", modelLabel: "base", runtimeLabel: "CPU int8" },
    { providerLabel: "Faster Whisper", modelLabel: "base", runtimeLabel: "CUDA float16" },
    { providerLabel: "Faster Whisper", modelLabel: "small", runtimeLabel: "CPU int8" },
    { providerLabel: "Vosk", modelLabel: "small-fr", runtimeLabel: "CPU" },
  ];

  assert.deepEqual(groupCandidateModelsByProvider(catalog), [
    {
      providerLabel: "Faster Whisper",
      models: [
        { providerLabel: "Faster Whisper", modelLabel: "base" },
        { providerLabel: "Faster Whisper", modelLabel: "small" },
      ],
    },
    { providerLabel: "Vosk", models: [{ providerLabel: "Vosk", modelLabel: "small-fr" }] },
  ]);
  assert.deepEqual(getCandidateRuntimeLabels(catalog.slice(0, 3)), ["CPU int8", "CUDA float16"]);
});

test("compares catalog options to model choices by value", () => {
  const model = { providerLabel: "Faster Whisper", modelLabel: "base" };
  const matchingOption = { ...model, runtimeLabel: "CPU int8" };

  assert.equal(sameCandidateModel(model, { ...model }), true);
  assert.equal(candidateOptionMatchesModel(matchingOption, model), true);
  assert.equal(candidateOptionMatchesModel({ ...matchingOption, modelLabel: "small" }, model), false);
});
