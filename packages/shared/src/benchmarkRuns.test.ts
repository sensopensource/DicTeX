import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSttBenchmarkRunSnapshot,
  getLatestSttCorrectionByKind,
  getLegacySttBenchmarkResultsForSplit,
  getSttBenchmarkResultsForRun,
  getSttBenchmarkRun,
  getSttBenchmarkRuns,
  type BenchmarkRunSnapshotMember,
  type LocalEvent,
} from "./localEvents.js";
import { summarizeLegacySttBenchmarkResultsByCandidate, summarizeSttBenchmarkRun } from "./benchmarkSummary.js";
import { calculateCharacterErrorRate } from "./sttScoring.js";

/**
 * Coverage for benchmark run tracking + acoustic snapshots (issue #122): a run
 * is an append-only experiment bound to the exact input snapshot it measured,
 * so its summary must be immutable under later re-corrections / membership
 * changes, must keep math_transform-only (no-audio) records out of an STT run,
 * and must never merge two runs or a legacy (no run_id) result into a run.
 */

// --- event builders -------------------------------------------------------

function audioSegment(sessionId: string, segmentId: string): LocalEvent {
  return {
    event_type: "audio_segment",
    session_id: sessionId,
    segment_id: segmentId,
    audio_ref: `audio/${sessionId}/${segmentId}.webm`,
  };
}

function membership(sessionId: string, segmentId: string, audioRef: string | null): LocalEvent {
  return {
    event_type: "stt_benchmark_set_membership",
    session_id: sessionId,
    segment_id: segmentId,
    audio_ref: audioRef,
    split: "validation",
  };
}

function correction(
  sessionId: string,
  segmentId: string,
  corrected: string,
  createdAt: string,
  kind: "acoustic" | "math_transform" = "acoustic",
  audioRef: string | null = `audio/${sessionId}/${segmentId}.webm`,
): LocalEvent {
  return {
    event_type: "stt_correction",
    session_id: sessionId,
    segment_id: segmentId,
    created_at: createdAt,
    audio_ref: audioRef,
    raw_transcript: "raw",
    corrected_transcript: corrected,
    correction_method: "keyboard",
    correction_kind: kind,
  };
}

function runStarted(runId: string, snapshot: BenchmarkRunSnapshotMember[]): LocalEvent {
  return {
    event_type: "stt_benchmark_run_started",
    run_id: runId,
    created_at: "2026-07-12T10:00:00.000Z",
    stage: "stt",
    dataset_kind: "acoustic",
    split: "validation",
    candidates: [
      { stage: "stt", provider: "faster-whisper", model: "base", variant: "cpu-int8-fr", prompt_variant: null },
    ],
    snapshot: snapshot.map((member) => ({
      session_id: member.sessionId,
      segment_id: member.segmentId,
      audio_ref: member.audioRef,
      reference_transcript: member.referenceTranscript,
      correction_created_at: member.correctionCreatedAt,
    })),
  };
}

function runResult(
  runId: string | null,
  sessionId: string,
  segmentId: string,
  cer: number,
  ref: string,
  transcript = "hypothesis",
): LocalEvent {
  return {
    event_type: "stt_benchmark_result",
    session_id: sessionId,
    segment_id: segmentId,
    ...(runId ? { run_id: runId } : {}),
    audio_ref: `audio/${sessionId}/${segmentId}.webm`,
    stage: "stt",
    provider: "faster-whisper",
    model: "base",
    variant: "cpu-int8-fr",
    transcript,
    transcription_duration_ms: 120,
    score_metric: "cer",
    score_value: cer,
    score_reference_transcript: ref,
  };
}

function runFinished(runId: string, done: number, failed: number, failures: { session_id: string; segment_id: string; error: string }[]): LocalEvent {
  return {
    event_type: "stt_benchmark_run_finished",
    run_id: runId,
    created_at: "2026-07-12T10:05:00.000Z",
    done,
    failed,
    failures,
  };
}

// --- snapshot: acoustic-only ---------------------------------------------

test("buildSttBenchmarkRunSnapshot: excludes a no-audio math_transform-only entry (acoustic/math_transform separation)", () => {
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    correction("session_a", "seg_0001", "real reference", "2026-07-12T09:00:00.000Z", "acoustic"),
    // A paste-sourced, no-audio entry: empty audio_ref, math_transform only.
    membership("lab_manual_1", "entry_x", ""),
    correction("lab_manual_1", "entry_x", "$x^{2}$", "2026-07-12T09:10:00.000Z", "math_transform", ""),
  ];

  const snapshot = buildSttBenchmarkRunSnapshot(events, "validation");

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].sessionId, "session_a");
  assert.equal(snapshot[0].audioRef, "audio/session_a/seg_0001.webm");
  assert.equal(snapshot[0].referenceTranscript, "real reference");
  assert.equal(snapshot[0].correctionCreatedAt, "2026-07-12T09:00:00.000Z");
});

test("getLatestSttCorrectionByKind: keeps the latest correction within the requested layer", () => {
  const events: LocalEvent[] = [
    correction("session_a", "seg_0001", "literal v1", "2026-07-12T09:00:00.000Z", "acoustic"),
    correction("session_a", "seg_0001", "literal v2", "2026-07-12T09:01:00.000Z", "acoustic"),
    correction("session_a", "seg_0001", "$x^{2}$", "2026-07-12T09:02:00.000Z", "math_transform"),
  ];

  const acoustic = getLatestSttCorrectionByKind(events, "session_a", "seg_0001", "acoustic");
  assert.equal(acoustic?.correctedTranscript, "literal v2");
  assert.equal(acoustic?.correctionCreatedAt, "2026-07-12T09:01:00.000Z");
  assert.equal(acoustic?.correctionKind, "acoustic");
});

test("buildSttBenchmarkRunSnapshot: freezes the latest acoustic correction before a later math transform", () => {
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    correction("session_a", "seg_0001", "literal v1", "2026-07-12T09:00:00.000Z", "acoustic"),
    correction("session_a", "seg_0001", "literal v2", "2026-07-12T09:01:00.000Z", "acoustic"),
    correction("session_a", "seg_0001", "$x^{2}$", "2026-07-12T09:02:00.000Z", "math_transform"),
  ];

  const snapshot = buildSttBenchmarkRunSnapshot(events, "validation");
  assert.equal(snapshot[0].referenceTranscript, "literal v2");
  assert.equal(snapshot[0].correctionCreatedAt, "2026-07-12T09:01:00.000Z");
});

test("buildSttBenchmarkRunSnapshot: another correction layer never replaces a missing acoustic reference", () => {
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    correction("session_a", "seg_0001", "$x^{2}$", "2026-07-12T09:00:00.000Z", "math_transform"),
  ];

  const snapshot = buildSttBenchmarkRunSnapshot(events, "validation");
  assert.equal(snapshot[0].referenceTranscript, null);
  assert.equal(snapshot[0].correctionCreatedAt, null);
});

test("buildSttBenchmarkRunSnapshot: includes an acoustic segment with no correction, reference null", () => {
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
  ];

  const snapshot = buildSttBenchmarkRunSnapshot(events, "validation");
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].referenceTranscript, null);
  assert.equal(snapshot[0].correctionCreatedAt, null);
});

// --- run readers: immutability & separation -------------------------------

test("getSttBenchmarkRuns: first run-start for a run_id wins (append-only, immutable)", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: "2026-07-12T09:00:00.000Z" },
  ];
  const tampered: LocalEvent = {
    event_type: "stt_benchmark_run_started",
    run_id: "run_1",
    created_at: "2026-07-12T11:00:00.000Z",
    stage: "stt",
    dataset_kind: "acoustic",
    split: "validation",
    candidates: [],
    snapshot: [],
  };

  const runs = getSttBenchmarkRuns([runStarted("run_1", snapshot), tampered]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].snapshot.length, 1);
  assert.equal(runs[0].candidates.length, 1);
  assert.equal(runs[0].datasetKind, "acoustic");
});

test("getSttBenchmarkRun: terminal counts come from the run-finished event; unfinished run has finished=null", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: null },
  ];

  const unfinished = getSttBenchmarkRun([runStarted("run_1", snapshot)], "run_1");
  assert.ok(unfinished);
  assert.equal(unfinished.finished, null);

  const finished = getSttBenchmarkRun([runStarted("run_1", snapshot), runFinished("run_1", 1, 0, [])], "run_1");
  assert.ok(finished);
  assert.deepEqual(finished.finished, { createdAt: "2026-07-12T10:05:00.000Z", done: 1, failed: 0, failures: [] });
});

test("getSttBenchmarkResultsForRun: scoped by run_id + snapshot, ignoring other runs and legacy results", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: null },
  ];
  const events: LocalEvent[] = [
    runResult("run_1", "session_a", "seg_0001", 0.1, "ref"),
    runResult("run_2", "session_a", "seg_0001", 0.9, "ref"),
    runResult(null, "session_a", "seg_0001", 0.5, "ref"),
  ];

  const results = getSttBenchmarkResultsForRun(events, "run_1", snapshot);
  assert.equal(results.length, 1);
  assert.equal(results[0].scoreValue, 0.1);
});

// --- summary: immutable under later re-correction -------------------------

test("summarizeSttBenchmarkRun: a re-correction AFTER the run never changes the run's snapshot or scores", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref v1", correctionCreatedAt: "2026-07-12T09:00:00.000Z" },
  ];
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    correction("session_a", "seg_0001", "ref v1", "2026-07-12T09:00:00.000Z"),
    runStarted("run_1", snapshot),
    runResult("run_1", "session_a", "seg_0001", 0.2, "ref v1"),
    runFinished("run_1", 1, 0, []),
    // Later re-correction of the same segment — must NOT move run_1's numbers.
    correction("session_a", "seg_0001", "ref v2 totally different", "2026-07-12T12:00:00.000Z"),
  ];

  const summary = summarizeSttBenchmarkRun(events, "run_1");
  assert.ok(summary);
  assert.equal(summary.totalSegments, 1);
  assert.equal(summary.candidates.length, 1);
  assert.equal(summary.candidates[0].meanCer, calculateCharacterErrorRate("hypothesis", "ref v1"));
  assert.equal(summary.candidates[0].resultCount, 1);
  assert.equal(summary.candidates[0].missingCount, 0);
});

test("summarizeSttBenchmarkRun: derives CER and WER from the frozen snapshot reference", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    {
      sessionId: "session_a",
      segmentId: "seg_0001",
      audioRef: "audio/session_a/seg_0001.webm",
      referenceTranscript: "hypothesis",
      correctionCreatedAt: "2026-07-12T09:00:00.000Z",
    },
  ];
  const result = runResult("run_1", "session_a", "seg_0001", 0.99, "$hypothesis^{2}$");

  const summary = summarizeSttBenchmarkRun(
    [runStarted("run_1", snapshot), result, runFinished("run_1", 1, 0, [])],
    "run_1",
  );

  assert.equal(summary?.candidates[0].meanCer, 0);
  assert.equal(summary?.candidates[0].meanWer, 0);
});

test("summarizeSttBenchmarkRun: two runs of the same split stay separate", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: null },
  ];
  const events: LocalEvent[] = [
    runStarted("run_1", snapshot),
    runResult("run_1", "session_a", "seg_0001", 0.1, "ref", "ref"),
    runFinished("run_1", 1, 0, []),
    { ...runStarted("run_2", snapshot), created_at: "2026-07-13T10:00:00.000Z" },
    runResult("run_2", "session_a", "seg_0001", 0.8, "ref", "wrong"),
    runFinished("run_2", 1, 0, []),
  ];

  const first = summarizeSttBenchmarkRun(events, "run_1");
  const second = summarizeSttBenchmarkRun(events, "run_2");
  assert.equal(first?.candidates[0].meanCer, 0);
  assert.equal(second?.candidates[0].meanCer, calculateCharacterErrorRate("wrong", "ref"));
});

test("summarizeSttBenchmarkRun: a partial stop leaves an unexecuted segment as missing, distinct from a failure", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: null },
    { sessionId: "session_a", segmentId: "seg_0002", audioRef: "audio/session_a/seg_0002.webm", referenceTranscript: "ref", correctionCreatedAt: null },
    { sessionId: "session_a", segmentId: "seg_0003", audioRef: "audio/session_a/seg_0003.webm", referenceTranscript: "ref", correctionCreatedAt: null },
  ];
  const events: LocalEvent[] = [
    runStarted("run_1", snapshot),
    runResult("run_1", "session_a", "seg_0001", 0.1, "ref"),
    // seg_0002 failed; seg_0003 was never executed (partial stop).
    runFinished("run_1", 1, 1, [{ session_id: "session_a", segment_id: "seg_0002", error: "provider crash" }]),
  ];

  const summary = summarizeSttBenchmarkRun(events, "run_1");
  assert.ok(summary);
  assert.equal(summary.totalSegments, 3);
  assert.equal(summary.candidates[0].resultCount, 1);
  assert.equal(summary.candidates[0].missingCount, 2);
  assert.equal(summary.done, 1);
  assert.equal(summary.failed, 1);

  const run = getSttBenchmarkRun(events, "run_1");
  // The failure is recorded; the never-run seg_0003 is neither a result nor a failure.
  assert.deepEqual(run?.finished?.failures, [{ sessionId: "session_a", segmentId: "seg_0002", error: "provider crash" }]);
});

test("summarizeSttBenchmarkRun: returns null for an unknown run id", () => {
  assert.equal(summarizeSttBenchmarkRun([], "run_missing"), null);
});

// --- legacy: read compatibly, never attached to a run ---------------------

test("legacy results (no run_id) are readable, summarized as legacy, and never counted in a run", () => {
  const snapshot: BenchmarkRunSnapshotMember[] = [
    { sessionId: "session_a", segmentId: "seg_0001", audioRef: "audio/session_a/seg_0001.webm", referenceTranscript: "ref", correctionCreatedAt: null },
  ];
  const events: LocalEvent[] = [
    audioSegment("session_a", "seg_0001"),
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    correction("session_a", "seg_0001", "ref", "2026-07-12T09:00:00.000Z"),
    // A pre-#122 result with no run_id.
    runResult(null, "session_a", "seg_0001", 0.3, "ref"),
    // A modern run over the same segment.
    runStarted("run_1", snapshot),
    runResult("run_1", "session_a", "seg_0001", 0.05, "ref", "ref"),
    runFinished("run_1", 1, 0, []),
  ];

  const legacy = getLegacySttBenchmarkResultsForSplit(events, "validation");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].scoreValue, 0.3);

  const legacySummary = summarizeLegacySttBenchmarkResultsByCandidate(events, "validation");
  assert.equal(legacySummary.candidates.length, 1);
  assert.equal(legacySummary.candidates[0].meanCer, 0.3);

  // The run summary must see only its own result, never the legacy one.
  const runSummary = summarizeSttBenchmarkRun(events, "run_1");
  assert.equal(runSummary?.candidates[0].meanCer, 0);
  assert.equal(runSummary?.candidates[0].resultCount, 1);
});
