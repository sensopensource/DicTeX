import type { DictexApi, RecentSegment } from "../../api.js";

/**
 * Every `DictexApi` method that is genuinely optional on the real preload
 * bridge (an older Electron `preload.js` may not expose it yet). A hook is
 * allowed to feature-detect these with `typeof api.x === "function"` without
 * declaring them in every test, so they default to `undefined` — present but
 * absent — instead of the throw a truly unstubbed call gets.
 */
const OPTIONAL_KEYS: (keyof DictexApi)[] = [
  "getSttModels",
  "getSttWorkerStatus",
  "onSttWorkerStatus",
  "setSttModel",
  "getNormalizerEnabled",
  "setNormalizerEnabled",
  "getRecentSegments",
  "getSegmentAudio",
  "publishOverlayState",
];

/**
 * Builds a `DictexApi` carrying only the calls a test declares.
 *
 * Reaching for anything else throws instead of returning `undefined`: a hook
 * that starts calling a new channel must say so in its tests, rather than fail
 * later as an opaque "x is not a function" inside an effect. The real `api`
 * cannot be imported here at all — `api.ts` reads `window.dictex` while it is
 * evaluated — which is exactly why hooks take their `DictexApi` as an argument.
 *
 * Symbol-keyed lookups (React/Node introspection, e.g. `$$typeof`) and a
 * handful of well-known probe keys pass through as `undefined` rather than
 * throwing: this object is only ever a hook argument, never rendered, but
 * React's dev-mode effect logging still inspects arbitrary props objects.
 */
export function stubDictexApi(stubs: Partial<DictexApi>): DictexApi {
  const withOptionalDefaults: Partial<DictexApi> = { ...stubs };
  for (const key of OPTIONAL_KEYS) {
    if (!(key in withOptionalDefaults)) {
      withOptionalDefaults[key] = undefined;
    }
  }

  return new Proxy(withOptionalDefaults as DictexApi, {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`DictexApi.${String(property)} was called but is not stubbed in this test`);
    },
  });
}

/** A `RecentSegment` with plausible defaults; override only what a test is about. */
export function segmentFixture(overrides: Partial<RecentSegment> = {}): RecentSegment {
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
    ...overrides,
  };
}
