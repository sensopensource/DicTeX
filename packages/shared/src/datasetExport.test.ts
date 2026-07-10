import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSttDatasetExport } from "./datasetExport.js";
import { containsSentinel } from "./commands.js";
import type { LocalEvent } from "./localEvents.js";

const NL = String.fromCodePoint(0xe000); // U+E000 — retour à la ligne

// One segment placed in test_frozen, carrying the two chained corrections the
// enrichment tool writes: an acoustic pair (audio -> literal) and a
// math_transform pair (literal -> notation). Both layers hold the command words
// in full, canonical form — the store is plain text, never a sentinel.
const AUDIO_REF = "audio/session_x/seg_0001.webm";
const LITERAL = "retour à la ligne x au carré plus deux"; // Layer 1
const NOTATION = "retour à la ligne x² + 2"; // Layer 2
const RAW_STT = "euh retour à la ligne x au carré plus deux"; // raw STT output

function baseEvents(): LocalEvent[] {
  return [
    { event_type: "audio_segment", session_id: "session_x", segment_id: "seg_0001", audio_ref: AUDIO_REF },
    {
      event_type: "stt_result",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      stt_engine: "faster-whisper",
      stt_model: "small",
      stt_language: "fr",
      stt_output: RAW_STT,
    },
    {
      event_type: "stt_correction",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      raw_transcript: RAW_STT,
      corrected_transcript: LITERAL,
      correction_method: "keyboard",
      correction_kind: "acoustic",
    },
    {
      event_type: "stt_correction",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      raw_transcript: LITERAL,
      corrected_transcript: NOTATION,
      correction_method: "keyboard",
      correction_kind: "math_transform",
    },
    {
      event_type: "stt_benchmark_set_membership",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      split: "test_frozen",
    },
  ];
}

function recordsOf(events: LocalEvent[]) {
  const exported = buildSttDatasetExport(events, "2026-07-10T00:00:00.000Z");
  const frozen = exported.splits.find((split) => split.split === "test_frozen");
  assert.ok(frozen, "test_frozen split present");
  const acoustic = frozen.kinds.find((group) => group.correctionKind === "acoustic")?.records ?? [];
  const mathTransform = frozen.kinds.find((group) => group.correctionKind === "math_transform")?.records ?? [];
  return { acoustic, mathTransform };
}

test("export substitutes sentinels into BOTH layers of a math_transform pair", () => {
  const { mathTransform } = recordsOf(baseEvents());
  assert.equal(mathTransform.length, 1);
  const pair = mathTransform[0];
  // input (Layer 1) and target (Layer 2) both carry the sentinel, so the seq2seq
  // sees it on both sides and learns to pass it through.
  assert.ok(containsSentinel(pair.rawTranscript), "Layer 1 substituted");
  assert.ok(containsSentinel(pair.correctedTranscript), "Layer 2 substituted");
  assert.equal(pair.rawTranscript, `${NL} x au carré plus deux`);
  assert.equal(pair.correctedTranscript, `${NL} x² + 2`);
});

test("export NEVER substitutes an acoustic pair (Layer 1 stays verbatim for STT)", () => {
  const { acoustic } = recordsOf(baseEvents());
  assert.equal(acoustic.length, 1);
  const pair = acoustic[0];
  assert.equal(containsSentinel(pair.rawTranscript), false);
  assert.equal(containsSentinel(pair.correctedTranscript), false);
  // The command words survive spelled out, exactly as spoken.
  assert.equal(pair.rawTranscript, RAW_STT);
  assert.equal(pair.correctedTranscript, LITERAL);
});

test("no-sentinel-in-store invariant: building the export never mutates the store", () => {
  const events = baseEvents();
  const before = JSON.stringify(events);
  buildSttDatasetExport(events, "2026-07-10T00:00:00.000Z");
  const after = JSON.stringify(events);
  // The append-only event store is untouched by export; substitution is a pure
  // function applied to the derived training pair only.
  assert.equal(after, before);
  // And no event in the store contains a sentinel character.
  assert.equal(containsSentinel(after), false);
});

test("regenerating the export is deterministic (retroactive correctness by rebuild)", () => {
  const events = baseEvents();
  const first = JSON.stringify(recordsOf(events).mathTransform);
  const second = JSON.stringify(recordsOf(events).mathTransform);
  assert.equal(first, second);
});
