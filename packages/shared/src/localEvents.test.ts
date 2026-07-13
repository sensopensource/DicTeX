import { test } from "node:test";
import assert from "node:assert/strict";

import { getSttPromptVariantDefinitions, reconstructRecentSegments, type LocalEvent } from "./localEvents.js";

/**
 * Coverage for the STT prompt variant definition reader (issue #121):
 * `stt_prompt_variant_defined` events are append-only and immutable, so
 * reading them must honor "first valid event for a name wins" and degrade
 * quietly on a malformed individual event.
 */

test("getSttPromptVariantDefinitions: returns no definitions for an empty event log", () => {
  assert.deepEqual(getSttPromptVariantDefinitions([]), []);
});

test("getSttPromptVariantDefinitions: reads a well-formed definition", () => {
  const events: LocalEvent[] = [
    {
      event_type: "stt_prompt_variant_defined",
      created_at: "2026-07-11T00:00:00.000Z",
      variant_name: "prompt-v3-fr-math",
      display_name: "Math (FR)",
      prompt_text: "Dictée mathématique en français : x carré, intégrale, dérivée.",
    },
  ];

  assert.deepEqual(getSttPromptVariantDefinitions(events), [
    {
      name: "prompt-v3-fr-math",
      displayName: "Math (FR)",
      promptText: "Dictée mathématique en français : x carré, intégrale, dérivée.",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
  ]);
});

test("getSttPromptVariantDefinitions: immutable — a second event for the same name never overrides the first", () => {
  const events: LocalEvent[] = [
    {
      event_type: "stt_prompt_variant_defined",
      created_at: "2026-07-11T00:00:00.000Z",
      variant_name: "v1",
      display_name: "Original",
      prompt_text: "original text",
    },
    {
      event_type: "stt_prompt_variant_defined",
      created_at: "2026-07-12T00:00:00.000Z",
      variant_name: "v1",
      display_name: "Tampered",
      prompt_text: "tampered text",
    },
  ];

  const definitions = getSttPromptVariantDefinitions(events);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].displayName, "Original");
  assert.equal(definitions[0].promptText, "original text");
});

test("getSttPromptVariantDefinitions: multiple distinct names all load", () => {
  const events: LocalEvent[] = [
    { event_type: "stt_prompt_variant_defined", variant_name: "v1", display_name: "One", prompt_text: "one" },
    { event_type: "stt_prompt_variant_defined", variant_name: "v2", display_name: "Two", prompt_text: "two" },
  ];

  assert.deepEqual(
    getSttPromptVariantDefinitions(events).map((definition) => definition.name),
    ["v1", "v2"],
  );
});

test("getSttPromptVariantDefinitions: skips a malformed event (missing/blank field) without blocking valid ones", () => {
  const events: LocalEvent[] = [
    { event_type: "stt_prompt_variant_defined", variant_name: "", display_name: "Blank id", prompt_text: "text" },
    { event_type: "stt_prompt_variant_defined", variant_name: "no-display-name", prompt_text: "text" } as LocalEvent,
    { event_type: "stt_prompt_variant_defined", variant_name: "no-text", display_name: "No text" } as LocalEvent,
    { event_type: "stt_prompt_variant_defined", variant_name: "  ", display_name: "Whitespace id", prompt_text: "text" },
    { event_type: "stt_prompt_variant_defined", variant_name: "ok", display_name: "Ok", prompt_text: "ok text" },
  ];

  assert.deepEqual(
    getSttPromptVariantDefinitions(events).map((definition) => definition.name),
    ["ok"],
  );
});

test("getSttPromptVariantDefinitions: ignores unrelated event types", () => {
  const events: LocalEvent[] = [
    { event_type: "audio_segment", session_id: "s", segment_id: "seg", audio_ref: "a" },
    { event_type: "stt_prompt_variant_defined", variant_name: "v1", display_name: "One", prompt_text: "one" },
  ];

  assert.equal(getSttPromptVariantDefinitions(events).length, 1);
});

test("reconstructRecentSegments: exposes the latest typed corrections without collapsing layers", () => {
  const events: LocalEvent[] = [
    {
      event_type: "stt_result",
      created_at: "2026-07-13T10:00:00.000Z",
      session_id: "session-1",
      segment_id: "segment-1",
      audio_ref: "audio/segment-1.webm",
      stt_output: "x au carré",
    },
    {
      event_type: "stt_correction",
      created_at: "2026-07-13T10:01:00.000Z",
      session_id: "session-1",
      segment_id: "segment-1",
      audio_ref: "audio/segment-1.webm",
      raw_transcript: "x au carré",
      corrected_transcript: "x au carré",
      correction_kind: "acoustic",
    },
    {
      event_type: "stt_correction",
      created_at: "2026-07-13T10:02:00.000Z",
      session_id: "session-1",
      segment_id: "segment-1",
      audio_ref: "audio/segment-1.webm",
      raw_transcript: "x au carré",
      corrected_transcript: "$x^{2}$",
      correction_kind: "math_transform",
    },
    {
      event_type: "stt_correction",
      created_at: "2026-07-13T10:03:00.000Z",
      session_id: "session-1",
      segment_id: "segment-1",
      audio_ref: "audio/segment-1.webm",
      raw_transcript: "x au carré",
      corrected_transcript: "x au carre",
      correction_kind: "acoustic",
    },
  ];

  const [segment] = reconstructRecentSegments(events);
  assert.deepEqual(segment.correctionsByKind, [
    {
      correctionKind: "acoustic",
      rawTranscript: "x au carré",
      correctedTranscript: "x au carre",
      correctionMethod: null,
      correctionCreatedAt: "2026-07-13T10:03:00.000Z",
    },
    {
      correctionKind: "math_transform",
      rawTranscript: "x au carré",
      correctedTranscript: "$x^{2}$",
      correctionMethod: null,
      correctionCreatedAt: "2026-07-13T10:02:00.000Z",
    },
  ]);
});
