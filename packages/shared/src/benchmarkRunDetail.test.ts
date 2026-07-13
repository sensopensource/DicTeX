import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSttBenchmarkRunDetail } from "./benchmarkRunDetail.js";
import { toSttBenchmarkRunOutcomes } from "./errorAnalysis.js";
import type { LocalEvent } from "./localEvents.js";
import { calculateCharacterErrorRate } from "./sttScoring.js";

/**
 * Coverage for the Results view's read-only run projection (issue #138). The
 * view shows exactly one run at a time, so the derivation must isolate a run
 * from every other run, from legacy (no run_id) results, and from any
 * correction made after the run — displaying a result against the wrong
 * snapshot would silently invalidate the analysis.
 */

const REFERENCE_A = "x au carré plus deux";
const REFERENCE_B = "sinus de theta";

function runStarted(
  runId: string,
  createdAt: string,
  snapshot: { sessionId: string; segmentId: string; reference: string | null }[],
): LocalEvent {
  return {
    event_type: "stt_benchmark_run_started",
    run_id: runId,
    created_at: createdAt,
    stage: "stt",
    dataset_kind: "acoustic",
    split: "validation",
    candidates: [
      { stage: "stt", provider: "faster-whisper", model: "base", variant: "cpu-int8-fr", prompt_variant: null },
      { stage: "stt", provider: "faster-whisper", model: "small", variant: "cpu-int8-fr", prompt_variant: null },
    ],
    snapshot: snapshot.map((member) => ({
      session_id: member.sessionId,
      segment_id: member.segmentId,
      audio_ref: `audio/${member.sessionId}/${member.segmentId}.webm`,
      reference_transcript: member.reference,
      correction_created_at: "2026-07-12T09:00:00.000Z",
    })),
  };
}

function runFinished(
  runId: string,
  done: number,
  failures: { sessionId: string; segmentId: string; error: string }[] = [],
): LocalEvent {
  return {
    event_type: "stt_benchmark_run_finished",
    run_id: runId,
    created_at: "2026-07-12T10:05:00.000Z",
    done,
    failed: failures.length,
    failures: failures.map((failure) => ({
      session_id: failure.sessionId,
      segment_id: failure.segmentId,
      error: failure.error,
    })),
  };
}

function result(
  runId: string | null,
  sessionId: string,
  segmentId: string,
  model: string,
  transcript: string,
  storedReference: string | null = REFERENCE_A,
): LocalEvent {
  return {
    event_type: "stt_benchmark_result",
    session_id: sessionId,
    segment_id: segmentId,
    ...(runId ? { run_id: runId } : {}),
    audio_ref: `audio/${sessionId}/${segmentId}.webm`,
    stage: "stt",
    provider: "faster-whisper",
    model,
    variant: "cpu-int8-fr",
    stt_engine: "faster-whisper",
    stt_model: model,
    stt_language: "fr",
    transcript,
    audio_duration_seconds: 2.4,
    transcription_duration_ms: 1830,
    score_metric: "cer",
    score_value: 0.5,
    score_reference_transcript: storedReference,
  };
}

function correction(sessionId: string, segmentId: string, corrected: string, createdAt: string): LocalEvent {
  return {
    event_type: "stt_correction",
    session_id: sessionId,
    segment_id: segmentId,
    created_at: createdAt,
    audio_ref: `audio/${sessionId}/${segmentId}.webm`,
    raw_transcript: "raw",
    corrected_transcript: corrected,
    correction_method: "keyboard",
    correction_kind: "acoustic",
  };
}

/** Two tracked runs over the same split, plus a legacy result on the same segment. */
function twoRunEvents(): LocalEvent[] {
  return [
    runStarted("run_a", "2026-07-12T10:00:00.000Z", [{ sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A }]),
    result("run_a", "s1", "seg_0001", "base", "x au carre plus deux"),
    result("run_a", "s1", "seg_0001", "small", "x au carré plus deux"),
    runFinished("run_a", 1),
    runStarted("run_b", "2026-07-12T11:00:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
      { sessionId: "s2", segmentId: "seg_0002", reference: REFERENCE_B },
    ]),
    result("run_b", "s1", "seg_0001", "base", "totally different output"),
    result("run_b", "s2", "seg_0002", "base", "sinus de theta"),
    runFinished("run_b", 2),
    // A pre-#122 result on the same segment: readable as legacy, never part of a run.
    result(null, "s1", "seg_0001", "base", "legacy transcript"),
  ];
}

test("buildSttBenchmarkRunDetail: a run shows its own snapshot and its own results only", () => {
  const events = twoRunEvents();

  const runA = buildSttBenchmarkRunDetail(events, "run_a");
  assert.notEqual(runA, null);
  assert.deepEqual(
    runA?.segments.map((segment) => `${segment.sessionId}/${segment.segmentId}`),
    ["s1/seg_0001"],
    "run A's snapshot has one member; run B's extra segment must not leak in",
  );

  const transcripts = runA?.segments[0].results.map((candidateResult) => candidateResult.transcript);
  assert.deepEqual(
    transcripts,
    ["x au carre plus deux", "x au carré plus deux"],
    "only run A's results, in the run's own candidate order (base then small)",
  );
  assert.equal(
    transcripts?.includes("totally different output"),
    false,
    "a result of another run over the same segment is never counted",
  );
  assert.equal(transcripts?.includes("legacy transcript"), false, "a legacy result (no run_id) is never counted");
});

test("buildSttBenchmarkRunDetail: two runs of one split keep separate summaries", () => {
  const events = twoRunEvents();

  const runA = buildSttBenchmarkRunDetail(events, "run_a");
  const runB = buildSttBenchmarkRunDetail(events, "run_b");

  assert.equal(runA?.segments.length, 1);
  assert.equal(runB?.segments.length, 2);
  assert.equal(runA?.summary.length, 2, "run A launched two candidates and logged a result for each");
  assert.equal(runB?.summary.length, 1, "run B only logged results for its base candidate");

  const runAsmall = runA?.summary.find((candidate) => candidate.candidate.model === "small");
  assert.equal(runAsmall?.meanCer, 0, "run A's small candidate matched its frozen reference exactly");

  const runBbase = runB?.summary.find((candidate) => candidate.candidate.model === "base");
  assert.equal(runBbase?.resultCount, 2);
  assert.equal(runBbase?.missingCount, 0);
});

test("buildSttBenchmarkRunDetail: scores follow the frozen snapshot, not a later re-correction", () => {
  const events = [
    ...twoRunEvents(),
    // The human re-corrects the segment AFTER both runs. A historical run must
    // not be re-scored against a reference it never measured.
    correction("s1", "seg_0001", "completely rewritten reference", "2026-07-13T08:00:00.000Z"),
  ];

  const runA = buildSttBenchmarkRunDetail(events, "run_a");
  const scored = runA?.segments[0].results[0];

  assert.equal(runA?.segments[0].referenceTranscript, REFERENCE_A);
  assert.equal(scored?.score?.referenceTranscript, REFERENCE_A);
  assert.equal(
    scored?.score?.value,
    calculateCharacterErrorRate("x au carre plus deux", REFERENCE_A),
    "the CER is recomputed against the frozen reference",
  );
});

test("buildSttBenchmarkRunDetail: failed, missing and done segments stay distinguishable", () => {
  const events: LocalEvent[] = [
    runStarted("run_c", "2026-07-12T12:00:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
      { sessionId: "s2", segmentId: "seg_0002", reference: REFERENCE_B },
      { sessionId: "s3", segmentId: "seg_0003", reference: null },
    ]),
    result("run_c", "s1", "seg_0001", "base", "x au carre plus deux"),
    runFinished("run_c", 1, [{ sessionId: "s2", segmentId: "seg_0002", error: "cuda:float16 unavailable" }]),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_c");
  assert.deepEqual(
    detail?.segments.map((segment) => segment.status),
    ["done", "failed", "missing"],
    "a segment the run never executed is reported as missing, not as a silent success",
  );
  assert.equal(detail?.segments[1].error, "cuda:float16 unavailable");
  assert.equal(detail?.segments[2].results.length, 0);
  assert.equal(
    detail?.segments[0].results[0].score?.value,
    calculateCharacterErrorRate("x au carre plus deux", REFERENCE_A),
  );
});

test("buildSttBenchmarkRunDetail: a snapshot member without an acoustic reference is never scored", () => {
  const events: LocalEvent[] = [
    runStarted("run_d", "2026-07-12T13:00:00.000Z", [{ sessionId: "s3", segmentId: "seg_0003", reference: null }]),
    result("run_d", "s3", "seg_0003", "base", "some transcript", null),
    runFinished("run_d", 1),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_d");
  assert.equal(detail?.segments[0].status, "done");
  assert.equal(detail?.segments[0].results[0].score, null, "no acoustic reference means no score, never a fallback");
  assert.equal(detail?.summary[0].meanCer, null);
});

test("buildSttBenchmarkRunDetail: a historical done terminal without output is not called missing", () => {
  const events: LocalEvent[] = [
    runStarted("run_legacy_done_without_output", "2026-07-12T13:30:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
    ]),
    runFinished("run_legacy_done_without_output", 1),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_legacy_done_without_output");
  assert.equal(detail?.segments[0].status, "completed_without_output");
  assert.equal(detail?.segments[0].results.length, 0);
});

test("buildSttBenchmarkRunDetail: an interrupted run without a terminal stays missing", () => {
  const events: LocalEvent[] = [
    runStarted("run_interrupted", "2026-07-12T13:35:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
    ]),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_interrupted");
  assert.equal(detail?.segments[0].status, "missing");
});

test("buildSttBenchmarkRunDetail: a failure with partial outputs remains failed", () => {
  const events: LocalEvent[] = [
    runStarted("run_partial_failure", "2026-07-12T13:40:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
    ]),
    result("run_partial_failure", "s1", "seg_0001", "base", "x au carre plus deux"),
    runFinished("run_partial_failure", 0, [{ sessionId: "s1", segmentId: "seg_0001", error: "second candidate failed" }]),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_partial_failure");
  assert.equal(detail?.segments[0].status, "failed");
  assert.equal(detail?.segments[0].results.length, 1);
});

test("toSttBenchmarkRunOutcomes: only executed segments feed the error analysis", () => {
  const events: LocalEvent[] = [
    runStarted("run_e", "2026-07-12T14:00:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
      { sessionId: "s2", segmentId: "seg_0002", reference: REFERENCE_B },
      { sessionId: "s3", segmentId: "seg_0003", reference: REFERENCE_B },
    ]),
    result("run_e", "s1", "seg_0001", "base", "x au carre plus deux"),
    runFinished("run_e", 1, [{ sessionId: "s2", segmentId: "seg_0002", error: "boom" }]),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_e");
  assert.notEqual(detail, null);
  const outcomes = toSttBenchmarkRunOutcomes(detail!);

  assert.deepEqual(
    outcomes.map((outcome) => [outcome.segmentId, outcome.status]),
    [
      ["seg_0001", "done"],
      ["seg_0002", "failed"],
    ],
    "the never-executed segment is dropped rather than reported as a failure",
  );
  assert.equal(outcomes[1].error, "boom");
});

test("toSttBenchmarkRunOutcomes: completed_without_output stays out of error analysis", () => {
  const events: LocalEvent[] = [
    runStarted("run_legacy_analysis", "2026-07-12T14:30:00.000Z", [
      { sessionId: "s1", segmentId: "seg_0001", reference: REFERENCE_A },
    ]),
    runFinished("run_legacy_analysis", 1),
  ];

  const detail = buildSttBenchmarkRunDetail(events, "run_legacy_analysis");
  assert.notEqual(detail, null);
  assert.deepEqual(toSttBenchmarkRunOutcomes(detail!), []);
});

test("buildSttBenchmarkRunDetail: an unknown run id resolves to nothing", () => {
  assert.equal(buildSttBenchmarkRunDetail(twoRunEvents(), "run_missing"), null);
});
