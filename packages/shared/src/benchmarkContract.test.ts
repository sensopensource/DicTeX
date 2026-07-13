import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMathTransformBenchmarkRunSnapshot,
  getBenchmarkRunProjection,
  getBenchmarkRunProjections,
  isBenchmarkResultEvent,
  isBenchmarkRunFinishedEvent,
  isBenchmarkRunStartedEvent,
  projectLegacySttBenchmarkResults,
  validateBenchmarkResultEvent,
  validateBenchmarkRunFinishedEvent,
  validateBenchmarkRunStartedEvent,
  validateStageAwareBenchmarkEvents,
  type BenchmarkCandidateRecord,
  type BenchmarkMathTransformResultEvent,
  type BenchmarkMathTransformRunFinishedEvent,
  type BenchmarkMathTransformRunStartedEvent,
  type BenchmarkMathTransformSnapshotMemberRecord,
  type BenchmarkSttResultEvent,
  type BenchmarkSttRunStartedEvent,
} from "./benchmarkContract.js";
import type { LocalEvent } from "./localEvents.js";

const NORMALIZER_CANDIDATE = {
  stage: "math_transform",
  provider: "dictex",
  model: "deterministic-pipeline",
  variant: "dictionary-a_rules-b",
} as const satisfies BenchmarkCandidateRecord<"math_transform">;

const STT_CANDIDATE = {
  stage: "stt",
  provider: "faster-whisper",
  model: "large-v3-turbo",
  variant: "cuda-float16-fr",
} as const satisfies BenchmarkCandidateRecord<"stt">;

function mathMember(segmentId: string, input = "x au carré", target = "$x^{2}$") {
  return {
    stage: "math_transform",
    session_id: "session_a",
    segment_id: segmentId,
    layer1_input: input,
    layer2_target: target,
    math_transform_correction_created_at: "2026-07-13T10:00:00.000Z",
  } as const satisfies BenchmarkMathTransformSnapshotMemberRecord;
}

function mathStart(runId: string, members = [mathMember("seg_0001")]): BenchmarkMathTransformRunStartedEvent {
  return {
    event_type: "benchmark_run_started",
    run_id: runId,
    created_at: "2026-07-13T11:00:00.000Z",
    stage: "math_transform",
    dataset_kind: "math_transform",
    split: "validation",
    candidates: [NORMALIZER_CANDIDATE],
    snapshot: members,
  };
}

function mathResult(
  runId: string,
  segmentId: string,
  outputTranscript = "$x^2$",
): BenchmarkMathTransformResultEvent {
  return {
    event_type: "benchmark_result",
    run_id: runId,
    created_at: "2026-07-13T11:00:01.000Z",
    stage: "math_transform",
    session_id: "session_a",
    segment_id: segmentId,
    candidate: NORMALIZER_CANDIDATE,
    output_transcript: outputTranscript,
    transformation_duration_ms: 3,
    layers: [
      {
        layer: "regex_rules",
        input: "x au carré",
        output: outputTranscript,
        applied: true,
        diagnostics: [],
      },
    ],
  };
}

function mathFinished(
  runId: string,
  failures: BenchmarkMathTransformRunFinishedEvent["failures"] = [],
): BenchmarkMathTransformRunFinishedEvent {
  return {
    event_type: "benchmark_run_finished",
    run_id: runId,
    created_at: "2026-07-13T11:00:02.000Z",
    stage: "math_transform",
    done: 1,
    failed: failures.length,
    failures,
  };
}

function membership(sessionId: string, segmentId: string, audioRef: string | null = ""): LocalEvent {
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
  kind: "acoustic" | "math_transform",
  rawTranscript: string,
  correctedTranscript: string,
  createdAt: string,
): LocalEvent {
  return {
    event_type: "stt_correction",
    session_id: sessionId,
    segment_id: segmentId,
    audio_ref: "",
    correction_kind: kind,
    correction_method: "keyboard",
    raw_transcript: rawTranscript,
    corrected_transcript: correctedTranscript,
    created_at: createdAt,
  };
}

// Compile-time contract checks: the discriminants prevent cross-stage snapshots
// and candidates even before runtime validation is called.
const typedSttStart: BenchmarkSttRunStartedEvent = {
  event_type: "benchmark_run_started",
  run_id: "typed_stt",
  stage: "stt",
  dataset_kind: "acoustic",
  split: "validation",
  candidates: [STT_CANDIDATE],
  snapshot: [
    {
      stage: "stt",
      session_id: "session_a",
      segment_id: "seg_0001",
      audio_ref: "audio/session_a/seg_0001.webm",
      layer1_reference: "x au carré",
      acoustic_correction_created_at: null,
    },
  ],
};

// @ts-expect-error A math_transform snapshot cannot be assigned to an STT start event.
const crossStageSnapshot: BenchmarkSttRunStartedEvent = { ...typedSttStart, snapshot: [mathMember("seg_bad")] };

const crossStageCandidate: BenchmarkSttResultEvent = {
  event_type: "benchmark_result",
  run_id: "typed_stt",
  stage: "stt",
  session_id: "session_a",
  segment_id: "seg_0001",
  // @ts-expect-error An STT result cannot carry a math_transform candidate identity.
  candidate: NORMALIZER_CANDIDATE,
  transcript: "x au carré",
  transcription_duration_ms: 1,
};

void crossStageSnapshot;
void crossStageCandidate;

test("stage-aware event unions validate their stage-specific shapes", () => {
  const start = mathStart("run_math");
  const result = mathResult("run_math", "seg_0001");
  const terminal = mathFinished("run_math");

  assert.equal(isBenchmarkRunStartedEvent(start), true);
  assert.equal(isBenchmarkResultEvent(result), true);
  assert.equal(isBenchmarkRunFinishedEvent(terminal), true);
  assert.equal(validateBenchmarkRunStartedEvent({ ...start, dataset_kind: "acoustic" }).valid, false);
  assert.equal(
    validateBenchmarkRunStartedEvent({
      ...start,
      snapshot: [{ ...start.snapshot[0], audio_ref: "audio/should-not-exist.webm" }],
    }).valid,
    false,
    "runtime validation rejects a mixed optional-field bag",
  );
  assert.equal(
    validateBenchmarkResultEvent({ ...result, candidate: { ...result.candidate, stage: "stt" } }).valid,
    false,
  );
  assert.equal(validateBenchmarkRunFinishedEvent({ ...terminal, failed: 1 }).valid, false);
  assert.equal(
    validateBenchmarkRunStartedEvent({ ...start, stage: "end_to_end", dataset_kind: "end_to_end" }).valid,
    false,
    "end_to_end is named but has no writable event variant",
  );
});

test("buildMathTransformBenchmarkRunSnapshot freezes the pair carried by math_transform itself", () => {
  const events: LocalEvent[] = [
    membership("session_a", "seg_0001"),
    correction(
      "session_a",
      "seg_0001",
      "math_transform",
      "x au carré",
      "$x^{2}$",
      "2026-07-13T10:00:00.000Z",
    ),
    // This later acoustic correction must not be used to reconstruct Layer 1.
    correction(
      "session_a",
      "seg_0001",
      "acoustic",
      "raw STT",
      "a later and different literal correction",
      "2026-07-13T10:05:00.000Z",
    ),
  ];

  assert.deepEqual(buildMathTransformBenchmarkRunSnapshot(events, "validation"), [
    {
      stage: "math_transform",
      session_id: "session_a",
      segment_id: "seg_0001",
      layer1_input: "x au carré",
      layer2_target: "$x^{2}$",
      math_transform_correction_created_at: "2026-07-13T10:00:00.000Z",
    },
  ]);
});

test("stage-aware projection distinguishes done, failed and missing per candidate x member", () => {
  const start = mathStart("run_statuses", [
    mathMember("seg_done"),
    mathMember("seg_failed", "racine de x", "$\\sqrt{x}$"),
    mathMember("seg_missing", "x plus y", "$x + y$"),
  ]);
  const events: LocalEvent[] = [
    start,
    mathResult("run_statuses", "seg_done", "$x^2$"),
    {
      ...mathFinished("run_statuses", [
        {
          session_id: "session_a",
          segment_id: "seg_failed",
          candidate: NORMALIZER_CANDIDATE,
          error: "invalid rules file",
        },
      ]),
      done: 1,
    },
  ];

  const projection = getBenchmarkRunProjection(events, "run_statuses");
  assert.equal(projection?.stage, "math_transform");
  if (projection?.stage !== "math_transform") {
    return;
  }
  assert.deepEqual(
    projection.members.map((member) => member.outcomes[0].status),
    ["done", "failed", "missing"],
  );
  assert.equal(projection.members[0].outcomes[0].result?.score.value, true, "LaTeX spelling is canonicalized");
  assert.equal(projection.members[1].outcomes[0].error, "invalid rules file");
  assert.deepEqual(projection.outcomeCounts, {
    done: 1,
    failed: 1,
    missing: 1,
    completedWithoutOutput: 0,
  });
});

test("first stage-aware start and first candidate x member result win immutably", () => {
  const first = mathStart("run_first", [mathMember("seg_0001", "x au carré", "$x^{2}$")]);
  const duplicate = mathStart("run_first", [mathMember("seg_tampered", "tampered", "tampered")]);
  const firstResult = mathResult("run_first", "seg_0001", "$x^2$");
  const duplicateResult = mathResult("run_first", "seg_0001", "wrong");
  const source: LocalEvent[] = [
    first,
    firstResult,
    duplicate,
    duplicateResult,
    mathFinished("run_first"),
    correction(
      "session_a",
      "seg_0001",
      "math_transform",
      "later input",
      "later target",
      "2026-07-13T12:00:00.000Z",
    ),
  ];
  const before = JSON.stringify(source);

  const projection = getBenchmarkRunProjection(source, "run_first");
  assert.equal(JSON.stringify(source), before, "projection never mutates or repairs source events");
  assert.equal(projection?.members.length, 1);
  assert.equal(projection?.members[0].segmentId, "seg_0001");
  if (projection?.stage === "math_transform") {
    assert.equal(projection.members[0].layer1Input, "x au carré");
    assert.equal(projection.members[0].layer2Target, "$x^{2}$", "a post-start re-correction cannot change the run");
    assert.equal(projection.members[0].outcomes[0].result?.outputTranscript, "$x^2$");
  }
});

test("orphan, cross-run and post-terminal results are never aggregated", () => {
  const events: LocalEvent[] = [
    mathResult("run_orphan", "seg_0001", "orphan"),
    mathStart("run_a"),
    mathResult("run_b", "seg_0001", "other run"),
    mathResult("run_a", "seg_0001", "$x^{2}$"),
    mathFinished("run_a"),
    mathResult("run_a", "seg_0001", "after terminal"),
  ];

  const projection = getBenchmarkRunProjection(events, "run_a");
  assert.equal(projection?.outcomeCounts.done, 1);
  if (projection?.stage === "math_transform") {
    assert.equal(projection.members[0].outcomes[0].result?.outputTranscript, "$x^{2}$");
  }
});

test("cross-event validation reports duplicates, orphans and run-stage mismatches", () => {
  const sttResult: BenchmarkSttResultEvent = {
    event_type: "benchmark_result",
    run_id: "run_math",
    stage: "stt",
    session_id: "session_a",
    segment_id: "seg_0001",
    candidate: STT_CANDIDATE,
    transcript: "x au carré",
    transcription_duration_ms: 4,
  };
  const issues = validateStageAwareBenchmarkEvents([
    mathResult("orphan", "seg_0001"),
    mathStart("run_math"),
    mathStart("run_math"),
    sttResult,
    mathResult("run_math", "seg_0001"),
    mathResult("run_math", "seg_0001"),
    mathFinished("run_math"),
    mathFinished("run_math"),
  ]);

  assert.deepEqual(
    issues.map((entry) => entry.code),
    ["orphan_result", "duplicate_start", "stage_mismatch", "duplicate_result", "duplicate_terminal"],
  );
});

test("modern tracked STT runs are adapted without changing the STT writer family", () => {
  const events: LocalEvent[] = [
    {
      event_type: "stt_benchmark_run_started",
      run_id: "run_stt_existing",
      created_at: "2026-07-13T09:00:00.000Z",
      stage: "stt",
      dataset_kind: "acoustic",
      split: "validation",
      candidates: [{ ...STT_CANDIDATE, prompt_variant: null }],
      snapshot: [
        {
          session_id: "session_a",
          segment_id: "seg_0001",
          audio_ref: "audio/session_a/seg_0001.webm",
          reference_transcript: "x au carré",
          correction_created_at: "2026-07-13T08:00:00.000Z",
        },
      ],
    },
    {
      event_type: "stt_benchmark_result",
      run_id: "run_stt_existing",
      session_id: "session_a",
      segment_id: "seg_0001",
      stage: "stt",
      provider: STT_CANDIDATE.provider,
      model: STT_CANDIDATE.model,
      variant: STT_CANDIDATE.variant,
      transcript: "x au carré",
      transcription_duration_ms: 10,
    },
    {
      event_type: "stt_benchmark_run_finished",
      run_id: "run_stt_existing",
      done: 1,
      failed: 0,
      failures: [],
    },
  ];

  const projection = getBenchmarkRunProjection(events, "run_stt_existing");
  assert.equal(projection?.source, "stt_tracked");
  assert.equal(projection?.stage, "stt");
  if (projection?.stage === "stt") {
    assert.equal(projection.members[0].outcomes[0].status, "done");
    assert.equal(projection.members[0].outcomes[0].result?.score?.strictCer, 0);
  }
  assert.equal(events.some((event) => event.event_type === "benchmark_run_started"), false);
});

test("the first start owns a run id globally across old and stage-aware families", () => {
  const oldStart = {
    event_type: "stt_benchmark_run_started",
    run_id: "run_collision",
    stage: "stt",
    dataset_kind: "acoustic",
    split: "validation",
    candidates: [{ ...STT_CANDIDATE, prompt_variant: null }],
    snapshot: [
      {
        session_id: "session_a",
        segment_id: "seg_0001",
        audio_ref: "audio/session_a/seg_0001.webm",
        reference_transcript: null,
        correction_created_at: null,
      },
    ],
  } satisfies LocalEvent;

  const projection = getBenchmarkRunProjection([oldStart, mathStart("run_collision")], "run_collision");
  assert.equal(projection?.source, "stt_tracked");
  assert.equal(projection?.stage, "stt");
});

test("legacy STT results remain readable in an explicitly legacy projection", () => {
  const events: LocalEvent[] = [
    membership("session_a", "seg_0001", "audio/session_a/seg_0001.webm"),
    {
      event_type: "stt_benchmark_result",
      session_id: "session_a",
      segment_id: "seg_0001",
      stage: "stt",
      provider: STT_CANDIDATE.provider,
      model: STT_CANDIDATE.model,
      variant: STT_CANDIDATE.variant,
      transcript: "x au carré",
      score_reference_transcript: "x au carré",
    },
  ];

  const legacy = projectLegacySttBenchmarkResults(events, "validation");
  assert.equal(legacy?.projectionId, "legacy:stt:validation");
  assert.equal(legacy?.source, "stt_legacy");
  assert.equal(legacy?.members[0].outcomes[0].status, "done");
  assert.equal(legacy?.members[0].outcomes[0].result?.score?.strictCer, 0);
});

test("the common split projection keeps both event families and legacy results separated", () => {
  const events: LocalEvent[] = [
    ...([mathStart("run_math"), mathResult("run_math", "seg_0001"), mathFinished("run_math")] as LocalEvent[]),
    membership("session_a", "seg_legacy", "audio/session_a/seg_legacy.webm"),
    {
      event_type: "stt_benchmark_result",
      session_id: "session_a",
      segment_id: "seg_legacy",
      stage: "stt",
      provider: STT_CANDIDATE.provider,
      model: STT_CANDIDATE.model,
      variant: STT_CANDIDATE.variant,
      transcript: "legacy",
      score_reference_transcript: "legacy",
    },
  ];

  const projections = getBenchmarkRunProjections(events, "validation");
  assert.deepEqual(
    projections.map((projection) => [projection.projectionId, projection.source, projection.stage]),
    [
      ["run_math", "stage_aware", "math_transform"],
      ["legacy:stt:validation", "stt_legacy", "stt"],
    ],
  );
});
