import type { ReconstructedSegment } from "@dictex/shared";
import type { LabApi } from "../../api.js";

/**
 * Builds a `LabApi` carrying only the calls a test declares.
 *
 * Reaching for anything else throws instead of returning `undefined`: a hook
 * that starts calling a new channel must say so in its tests, rather than fail
 * later as an opaque "x is not a function" inside an effect. The real `api`
 * cannot be imported here at all — `api.ts` reads `window.dictexLab` while it is
 * evaluated — which is exactly why hooks take their `LabApi` as an argument.
 */
export function stubLabApi(stubs: Partial<LabApi>): LabApi {
  return new Proxy(stubs as LabApi, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`LabApi.${String(property)} was called but is not stubbed in this test`);
    },
  });
}

/** A `ReconstructedSegment` with plausible defaults; override only what a test is about. */
export function segmentFixture(overrides: Partial<ReconstructedSegment> = {}): ReconstructedSegment {
  return {
    createdAt: "2026-07-15T10:00:00.000Z",
    sessionId: "session_1",
    segmentId: "segment_1",
    audioRef: "audio/session_1/segment_1.webm",
    transcript: "x au carré",
    normalizedTranscript: null,
    normalizationCreatedAt: null,
    sttEngine: "faster-whisper",
    sttModel: "base",
    sttLanguage: "fr",
    audioDurationSeconds: 1.5,
    transcriptionDurationMs: 900,
    correctedTranscript: null,
    correctionCreatedAt: null,
    correctionMethod: null,
    correctionKind: null,
    correctionsByKind: [],
    benchmarkSetSplit: null,
    benchmarkSetCreatedAt: null,
    ...overrides,
  };
}
