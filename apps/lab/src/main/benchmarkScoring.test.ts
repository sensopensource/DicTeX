import assert from "node:assert/strict";
import test from "node:test";

import type { LocalEvent } from "@dictex/shared";
import { scoreSttBenchmarkTranscript } from "./benchmarkScoring.js";

function correction(kind: "acoustic" | "math_transform", transcript: string, createdAt: string): LocalEvent {
  return {
    event_type: "stt_correction",
    session_id: "session_a",
    segment_id: "seg_1",
    created_at: createdAt,
    audio_ref: "audio/session_a/seg_1.webm",
    raw_transcript: "raw",
    corrected_transcript: transcript,
    correction_method: "keyboard",
    correction_kind: kind,
  };
}

test("scoreSttBenchmarkTranscript: direct scoring uses the latest acoustic correction only", () => {
  const events = [
    correction("acoustic", "literal v1", "2026-07-12T09:00:00.000Z"),
    correction("acoustic", "literal v2", "2026-07-12T09:01:00.000Z"),
    correction("math_transform", "$literal^{2}$", "2026-07-12T09:02:00.000Z"),
  ];

  const score = scoreSttBenchmarkTranscript("literal v2", events, "session_a", "seg_1");
  assert.deepEqual(score, {
    stage: "stt",
    metric: "cer",
    value: 0,
    referenceTranscript: "literal v2",
    correctionCreatedAt: "2026-07-12T09:01:00.000Z",
  });
});

test("scoreSttBenchmarkTranscript: another correction kind is never a fallback", () => {
  const events = [correction("math_transform", "$x^{2}$", "2026-07-12T09:00:00.000Z")];
  assert.equal(scoreSttBenchmarkTranscript("x au carré", events, "session_a", "seg_1"), null);
});

test("scoreSttBenchmarkTranscript: a frozen run reference wins even after later corrections", () => {
  const events = [
    correction("acoustic", "new literal", "2026-07-12T12:00:00.000Z"),
    correction("math_transform", "$new literal$", "2026-07-12T12:01:00.000Z"),
  ];
  const frozen = {
    referenceTranscript: "run literal",
    correctionCreatedAt: "2026-07-12T09:00:00.000Z",
  };

  const score = scoreSttBenchmarkTranscript("run literal", events, "session_a", "seg_1", frozen);
  assert.equal(score?.value, 0);
  assert.equal(score?.referenceTranscript, "run literal");
  assert.equal(score?.correctionCreatedAt, "2026-07-12T09:00:00.000Z");
});

test("scoreSttBenchmarkTranscript: a frozen null reference stays unscored", () => {
  const events = [correction("acoustic", "added after run", "2026-07-12T12:00:00.000Z")];
  assert.equal(
    scoreSttBenchmarkTranscript("added after run", events, "session_a", "seg_1", {
      referenceTranscript: null,
      correctionCreatedAt: null,
    }),
    null,
  );
});
