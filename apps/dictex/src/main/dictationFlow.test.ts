import assert from "node:assert/strict";
import { test } from "node:test";

import type { NormalizationResult } from "@dictex/shared";

import {
  runDictationTranscription,
  type DictationFlowDeps,
  type DictationFlowInput,
  type JsonValue,
} from "./dictationFlow.js";
import { WorkerDiedError, type WorkerTranscription } from "./sttWorkerClient.js";

const rawTranscript = "x au carré";

function workerResult(overrides: Partial<WorkerTranscription> = {}): WorkerTranscription {
  return {
    id: "req_1",
    transcript: rawTranscript,
    audioPath: "audio/session_x/seg_0001.webm",
    audioSize: 4,
    sttEngine: "faster-whisper",
    sttModel: "base",
    sttLanguage: "fr",
    sttLanguageProbability: 0.9,
    audioDurationSeconds: 1.5,
    inferenceDurationMs: 12,
    ...overrides,
  };
}

type Harness = {
  events: Record<string, JsonValue>[];
  clipboard: string[];
  normalizeCalls: number;
  storeAudioCalls: number;
  deps: DictationFlowDeps;
};

function makeHarness(overrides: {
  transcribe?: DictationFlowDeps["transcribe"];
  normalize?: (raw: string) => Promise<NormalizationResult>;
}): Harness {
  const events: Record<string, JsonValue>[] = [];
  const clipboard: string[] = [];
  const state = { normalizeCalls: 0, storeAudioCalls: 0 };
  let clock = 1000;

  const deps: DictationFlowDeps = {
    now: () => {
      const value = clock;
      clock += 200;
      return value;
    },
    isoNow: () => "2026-07-11T00:00:00.000Z",
    storeAudio: async (segmentId) => {
      state.storeAudioCalls += 1;
      return {
        audioPath: `C:/data/audio/session_x/${segmentId}.webm`,
        audioRef: `audio/session_x/${segmentId}.webm`,
      };
    },
    appendEvent: async (event) => {
      events.push(event);
    },
    transcribe: overrides.transcribe ?? (async () => workerResult()),
    normalize:
      overrides.normalize ??
      (async () => {
        throw new Error("normalize must not be called");
      }),
    writeClipboard: (text) => {
      clipboard.push(text);
    },
    pasteActiveApp: async () => false,
  };

  return {
    events,
    clipboard,
    get normalizeCalls() {
      return state.normalizeCalls;
    },
    get storeAudioCalls() {
      return state.storeAudioCalls;
    },
    deps: {
      ...deps,
      normalize: async (raw: string) => {
        state.normalizeCalls += 1;
        return deps.normalize(raw);
      },
    },
  };
}

const baseInput: DictationFlowInput = {
  sessionId: "session_x",
  segmentId: "seg_0001",
  createdAt: "2026-07-11T00:00:00.000Z",
  mimeType: "audio/webm",
  audioBytes: new Uint8Array([0, 1, 2, 3]),
  normalizerEnabled: true,
  autoPaste: false,
};

test("Normalizer On: one stt_result with raw output, normalized text inserted", async () => {
  const normalization: NormalizationResult = {
    input: rawTranscript,
    output: "$x^{2}$",
    passthrough: false,
    layers: [{ layer: "regex_rules", input: rawTranscript, output: "$x^{2}$", applied: true, diagnostics: [] }],
    diagnostics: [],
  };
  const harness = makeHarness({ normalize: async () => normalization });

  const result = await runDictationTranscription(harness.deps, { ...baseInput, normalizerEnabled: true });

  assert.deepEqual(
    harness.events.map((event) => event.event_type),
    ["audio_segment", "stt_result", "normalization_result"],
  );
  const sttResult = harness.events[1];
  assert.equal(sttResult.stt_output, rawTranscript, "raw STT output is preserved verbatim");
  assert.equal(sttResult.transcription_duration_ms, 200);

  const normalizationEvent = harness.events[2];
  assert.equal(normalizationEvent.output_transcript, "$x^{2}$");
  assert.equal(normalizationEvent.passthrough, false);
  assert.equal("disabled" in normalizationEvent, false);

  assert.deepEqual(harness.clipboard, ["$x^{2}$"]);
  assert.equal(result.transcript, rawTranscript);
  assert.equal(result.normalizedTranscript, "$x^{2}$");
  assert.equal(result.normalizationApplied, true);
  assert.equal(harness.normalizeCalls, 1);
});

test("Normalizer Off: inserted text is byte-identical to raw and event says disabled", async () => {
  const harness = makeHarness({});

  const result = await runDictationTranscription(harness.deps, { ...baseInput, normalizerEnabled: false });

  assert.deepEqual(
    harness.events.map((event) => event.event_type),
    ["audio_segment", "stt_result", "normalization_result"],
  );
  const normalizationEvent = harness.events[2];
  assert.equal(normalizationEvent.disabled, true);
  assert.equal("passthrough" in normalizationEvent, false);
  assert.deepEqual(normalizationEvent.layers, []);

  assert.deepEqual(harness.clipboard, [rawTranscript]);
  assert.equal(result.normalizedTranscript, rawTranscript);
  assert.equal(result.normalizationApplied, false);
  assert.equal(harness.normalizeCalls, 0, "the normalizer is never invoked when disabled");
});

test("a failed transcription keeps the audio and audio_segment and writes no STT events", async () => {
  const harness = makeHarness({
    transcribe: async () => {
      throw new WorkerDiedError("worker died twice", "worker_exited");
    },
  });

  await assert.rejects(
    () => runDictationTranscription(harness.deps, { ...baseInput, normalizerEnabled: true }),
    WorkerDiedError,
  );

  assert.equal(harness.storeAudioCalls, 1, "audio is stored before transcription");
  assert.deepEqual(
    harness.events.map((event) => event.event_type),
    ["audio_segment"],
    "no stt_result or normalization_result is written on failure",
  );
  assert.deepEqual(harness.clipboard, [], "nothing is inserted on failure");
});
