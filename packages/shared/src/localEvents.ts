import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type AudioSegmentRecord = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
};

export type AudioSegmentEvent = {
  event_type: "audio_segment";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref: string;
  audio_mime_type?: string;
  audio_size_bytes?: number;
};

export type SttResultEvent = {
  event_type: "stt_result";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string;
  stt_engine?: string;
  stt_model?: string;
  stt_language?: string;
  stt_output: string;
  corrected_transcript?: string | null;
  audio_duration_seconds?: number | null;
  transcription_duration_ms?: number;
  stt_worker_generation?: string;
  stt_ready_wait_ms?: number;
  stt_inference_duration_ms?: number | null;
};

/** Lifecycle measurement for one persistent DicTeX STT worker generation. */
export type SttEngineReadyEvent = {
  event_type: "stt_engine_ready";
  created_at?: string;
  worker_generation: string;
  stt_engine: string;
  stt_model: string;
  stt_device: string;
  stt_compute_type: string;
  worker_startup_ms: number;
  model_load_ms: number;
};

export type SttBenchmarkResultEvent = {
  event_type: "stt_benchmark_result";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string;
  stage?: string;
  provider?: string;
  model?: string;
  variant?: string | null;
  stt_engine?: string;
  stt_model?: string;
  stt_language?: string;
  transcript?: string;
  audio_duration_seconds?: number | null;
  transcription_duration_ms?: number;
  score_metric?: string | null;
  score_value?: number | null;
  score_reference_transcript?: string | null;
};

export type NormalizationLayerRecord = {
  layer: string;
  input: string;
  output: string;
  applied: boolean;
  diagnostics?: string[];
};

export type NormalizationResultEvent = {
  event_type: "normalization_result";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string | null;
  input_transcript: string;
  output_transcript: string;
  /** True only when DicTeX deliberately skipped the whole normalizer pipeline. */
  disabled?: true;
  passthrough?: boolean;
  layers?: NormalizationLayerRecord[];
  diagnostics?: string[];
};

export type CorrectionKind = "acoustic" | "math_transform" | "normalization" | "rephrasing";

/** Canonical, stable ordering for correction kinds in derived outputs. */
export const CORRECTION_KIND_ORDER: CorrectionKind[] = [
  "acoustic",
  "math_transform",
  "normalization",
  "rephrasing",
];

export type SttCorrectionEvent = {
  event_type: "stt_correction";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string | null;
  raw_transcript: string;
  corrected_transcript: string;
  correction_method?: string;
  correction_kind?: CorrectionKind;
};

export type SttBenchmarkSetSplit = "train_candidate_pool" | "validation" | "test_frozen";

export type SttBenchmarkSetMembershipEvent = {
  event_type: "stt_benchmark_set_membership";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string | null;
  split: SttBenchmarkSetSplit;
  reason?: string;
};

export type SttCandidateSelectionEvent = {
  event_type: "stt_candidate_selection";
  created_at?: string;
  stage: string;
  provider: string;
  model: string;
  variant?: string | null;
  selection_reason?: string | null;
};

export type UnknownLocalEvent = {
  event_type: string;
  [key: string]: unknown;
};

export type LocalEvent =
  | AudioSegmentEvent
  | SttResultEvent
  | SttEngineReadyEvent
  | SttBenchmarkResultEvent
  | SttCorrectionEvent
  | SttBenchmarkSetMembershipEvent
  | SttCandidateSelectionEvent
  | NormalizationResultEvent
  | UnknownLocalEvent;

export type ReconstructedSegment = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  transcript: string;
  normalizedTranscript: string | null;
  normalizationCreatedAt: string | null;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number | null;
  correctedTranscript: string | null;
  correctionCreatedAt: string | null;
  correctionMethod: string | null;
  correctionKind: CorrectionKind | null;
  benchmarkSetSplit: SttBenchmarkSetSplit | null;
  benchmarkSetCreatedAt: string | null;
};

export type SegmentSttCorrection = {
  correctedTranscript: string;
  correctionCreatedAt: string | null;
  correctionMethod: string | null;
  correctionKind: CorrectionKind | null;
};

export type SttBenchmarkSetSegment = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  split: SttBenchmarkSetSplit;
  benchmarkSetCreatedAt: string | null;
  hasCorrection: boolean;
};

export type BenchmarkCandidateIdentity = {
  stage: string;
  provider: string;
  model: string;
  variant: string | null;
};

export type SttScoredBenchmarkResult = {
  sessionId: string;
  segmentId: string;
  candidate: BenchmarkCandidateIdentity;
  transcript: string;
  transcriptionDurationMs: number | null;
  scoreMetric: string | null;
  scoreValue: number | null;
  referenceTranscript: string | null;
};

export type SttCandidateSelection = {
  createdAt: string | null;
  candidate: BenchmarkCandidateIdentity;
  selectionReason: string | null;
};

type SegmentDraft = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  transcript: string | null;
  normalizedTranscript: string | null;
  normalizationCreatedAt: string | null;
  sttEngine: string | null;
  sttModel: string | null;
  sttLanguage: string | null;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number | null;
  correctedTranscript: string | null;
  correctionCreatedAt: string | null;
  correctionMethod: string | null;
  correctionKind: CorrectionKind | null;
  benchmarkSetSplit: SttBenchmarkSetSplit | null;
  benchmarkSetCreatedAt: string | null;
  lastEventIndex: number;
  lastCorrectionEventIndex: number | null;
  lastBenchmarkSetEventIndex: number | null;
  lastNormalizationEventIndex: number | null;
};

export async function readLocalEvents(eventsPath: string): Promise<LocalEvent[]> {
  if (!existsSync(eventsPath)) {
    return [];
  }

  const contents = await readFile(eventsPath, { encoding: "utf8" });
  const events: LocalEvent[] = [];

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && typeof parsed.event_type === "string") {
        events.push(parsed as LocalEvent);
      }
    } catch {
      continue;
    }
  }

  return events;
}

export function getLatestAudioSegment(events: LocalEvent[]): AudioSegmentRecord | null {
  let latestAudioSegment: AudioSegmentRecord | null = null;

  for (const event of events) {
    if (isAudioSegmentEvent(event)) {
      latestAudioSegment = {
        sessionId: event.session_id,
        segmentId: event.segment_id,
        audioRef: event.audio_ref,
      };
    }
  }

  return latestAudioSegment;
}

export function getLatestSttCorrection(
  events: LocalEvent[],
  sessionId: string,
  segmentId: string,
): SegmentSttCorrection | null {
  let latestCorrection: SegmentSttCorrection | null = null;

  for (const event of events) {
    if (isSttCorrectionEvent(event) && event.session_id === sessionId && event.segment_id === segmentId) {
      latestCorrection = {
        correctedTranscript: event.corrected_transcript,
        correctionCreatedAt: getString(event.created_at),
        correctionMethod: getString(event.correction_method),
        correctionKind: getCorrectionKind(event.correction_kind),
      };
    }
  }

  return latestCorrection;
}

export type SegmentCorrectionByKind = {
  correctionKind: CorrectionKind;
  rawTranscript: string;
  correctedTranscript: string;
  correctionMethod: string | null;
  correctionCreatedAt: string | null;
};

/**
 * Returns the latest stt_correction of one segment for EACH correction kind
 * (deterministic acoustic -> math_transform -> normalization -> rephrasing
 * order). Unlike getLatestSttCorrection (a single latest across all kinds, for
 * history display), dataset export must keep every kind: the enrichment tool
 * (#66) writes chained acoustic + math_transform corrections for one segment, so
 * collapsing to the single latest event would silently drop the acoustic pair.
 * Within one kind, latest-event-wins still applies so a re-correction supersedes
 * its predecessor. Untyped legacy corrections (null kind) are excluded here —
 * they cannot be routed into a kind-partitioned dataset; countUntypedSttCorrections
 * reports how many were skipped so the loss is never silent.
 */
export function getSttCorrectionsByKind(
  events: LocalEvent[],
  sessionId: string,
  segmentId: string,
): SegmentCorrectionByKind[] {
  const latestByKind = new Map<CorrectionKind, { eventIndex: number; correction: SegmentCorrectionByKind }>();

  events.forEach((event, eventIndex) => {
    if (!isSttCorrectionEvent(event) || event.session_id !== sessionId || event.segment_id !== segmentId) {
      return;
    }

    const kind = getCorrectionKind(event.correction_kind);
    if (kind === null) {
      return;
    }

    const existing = latestByKind.get(kind);
    if (existing && existing.eventIndex > eventIndex) {
      return;
    }

    latestByKind.set(kind, {
      eventIndex,
      correction: {
        correctionKind: kind,
        rawTranscript: event.raw_transcript,
        correctedTranscript: event.corrected_transcript,
        correctionMethod: getString(event.correction_method),
        correctionCreatedAt: getString(event.created_at),
      },
    });
  });

  return CORRECTION_KIND_ORDER.map((kind) => latestByKind.get(kind)?.correction).filter(
    (correction): correction is SegmentCorrectionByKind => correction !== undefined,
  );
}

/**
 * Counts stt_correction events of a segment that carry no (or an invalid)
 * correction_kind. Used by dataset export to surface how many corrections could
 * not be routed by kind instead of dropping them silently.
 */
export function countUntypedSttCorrections(events: LocalEvent[], sessionId: string, segmentId: string): number {
  let count = 0;
  for (const event of events) {
    if (
      isSttCorrectionEvent(event) &&
      event.session_id === sessionId &&
      event.segment_id === segmentId &&
      getCorrectionKind(event.correction_kind) === null
    ) {
      count += 1;
    }
  }
  return count;
}

export type SegmentSttInfo = {
  sttOutput: string | null;
  sttLanguage: string | null;
  sttEngine: string | null;
  sttModel: string | null;
};

/**
 * Returns the latest stt_result for one segment: the original raw STT output and
 * its engine/model/language. Dataset export pairs this with each correction so a
 * record stays traceable to the transcription that produced it.
 */
export function getSegmentSttInfo(events: LocalEvent[], sessionId: string, segmentId: string): SegmentSttInfo {
  let info: SegmentSttInfo = { sttOutput: null, sttLanguage: null, sttEngine: null, sttModel: null };

  for (const event of events) {
    if (isSttResultEvent(event) && event.session_id === sessionId && event.segment_id === segmentId) {
      info = {
        sttOutput: event.stt_output,
        sttLanguage: getString(event.stt_language),
        sttEngine: getString(event.stt_engine),
        sttModel: getString(event.stt_model),
      };
    }
  }

  return info;
}

type BenchmarkSetSegmentDraft = {
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  split: SttBenchmarkSetSplit | null;
  benchmarkSetCreatedAt: string | null;
  lastMembershipEventIndex: number;
  hasCorrection: boolean;
};

/**
 * Returns every segment whose latest benchmark-set membership resolves to `split`,
 * with a resolvable audio reference, in a deterministic order (session id then
 * segment id). Membership is latest-event-wins, matching reconstructRecentSegments,
 * so a segment moved between splits only appears under its current split.
 */
export function getSttBenchmarkSetSegments(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): SttBenchmarkSetSegment[] {
  const drafts = new Map<string, BenchmarkSetSegmentDraft>();

  events.forEach((event, eventIndex) => {
    if (
      !isAudioSegmentEvent(event) &&
      !isSttResultEvent(event) &&
      !isSttCorrectionEvent(event) &&
      !isSttBenchmarkSetMembershipEvent(event)
    ) {
      return;
    }

    const key = getSegmentKey(event.session_id, event.segment_id);
    const draft =
      drafts.get(key) ??
      ({
        sessionId: event.session_id,
        segmentId: event.segment_id,
        audioRef: null,
        split: null,
        benchmarkSetCreatedAt: null,
        lastMembershipEventIndex: -1,
        hasCorrection: false,
      } satisfies BenchmarkSetSegmentDraft);

    if (isAudioSegmentEvent(event)) {
      draft.audioRef = event.audio_ref;
    }

    if (isSttResultEvent(event)) {
      draft.audioRef = getString(event.audio_ref) ?? draft.audioRef;
    }

    if (isSttCorrectionEvent(event)) {
      draft.hasCorrection = true;
    }

    if (isSttBenchmarkSetMembershipEvent(event) && eventIndex > draft.lastMembershipEventIndex) {
      draft.split = event.split;
      draft.benchmarkSetCreatedAt = getString(event.created_at);
      draft.audioRef = getString(event.audio_ref) ?? draft.audioRef;
      draft.lastMembershipEventIndex = eventIndex;
    }

    drafts.set(key, draft);
  });

  return Array.from(drafts.values())
    .filter((draft): draft is BenchmarkSetSegmentDraft & { audioRef: string; split: SttBenchmarkSetSplit } => {
      return draft.split === split && typeof draft.audioRef === "string";
    })
    .sort((left, right) => {
      if (left.sessionId !== right.sessionId) {
        return left.sessionId < right.sessionId ? -1 : 1;
      }
      if (left.segmentId === right.segmentId) {
        return 0;
      }
      return left.segmentId < right.segmentId ? -1 : 1;
    })
    .map((draft) => ({
      sessionId: draft.sessionId,
      segmentId: draft.segmentId,
      audioRef: draft.audioRef,
      split: draft.split,
      benchmarkSetCreatedAt: draft.benchmarkSetCreatedAt,
      hasCorrection: draft.hasCorrection,
    }));
}

/**
 * Returns the latest stt_benchmark_result per (segment, candidate) pair for
 * segments currently in `split`, matching the latest-event-wins rule used
 * elsewhere so a re-run of a candidate replaces its prior result.
 */
export function getSttBenchmarkResultsForSplit(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): SttScoredBenchmarkResult[] {
  const splitSegmentKeys = new Set(
    getSttBenchmarkSetSegments(events, split).map((segment) => getSegmentKey(segment.sessionId, segment.segmentId)),
  );

  const latestByKey = new Map<string, { eventIndex: number; result: SttScoredBenchmarkResult }>();

  events.forEach((event, eventIndex) => {
    if (!isSttBenchmarkResultEvent(event)) {
      return;
    }

    const segmentKey = getSegmentKey(event.session_id, event.segment_id);
    if (!splitSegmentKeys.has(segmentKey)) {
      return;
    }

    const candidate = getBenchmarkCandidateIdentity(event);
    if (!candidate) {
      return;
    }

    const candidateKey = `${segmentKey}::${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
    const existing = latestByKey.get(candidateKey);
    if (existing && existing.eventIndex > eventIndex) {
      return;
    }

    latestByKey.set(candidateKey, {
      eventIndex,
      result: {
        sessionId: event.session_id,
        segmentId: event.segment_id,
        candidate,
        transcript: event.transcript ?? "",
        transcriptionDurationMs: getNumber(event.transcription_duration_ms),
        scoreMetric: getString(event.score_metric),
        scoreValue: getNumber(event.score_value),
        referenceTranscript: getString(event.score_reference_transcript),
      },
    });
  });

  return Array.from(latestByKey.values()).map((entry) => entry.result);
}

function getBenchmarkCandidateIdentity(event: SttBenchmarkResultEvent): BenchmarkCandidateIdentity | null {
  const stage = getString(event.stage);
  const provider = getString(event.provider);
  const model = getString(event.model);
  if (!stage || !provider || !model) {
    return null;
  }

  return { stage, provider, model, variant: getString(event.variant) };
}

/**
 * Returns the currently selected base STT candidate: the latest
 * stt_candidate_selection event, latest-event-wins like every other append-only
 * marker in this file. Returns null when no selection has ever been recorded.
 */
export function getLatestSttCandidateSelection(events: LocalEvent[]): SttCandidateSelection | null {
  let latestSelection: SttCandidateSelection | null = null;

  for (const event of events) {
    if (!isSttCandidateSelectionEvent(event)) {
      continue;
    }

    latestSelection = {
      createdAt: getString(event.created_at),
      candidate: { stage: event.stage, provider: event.provider, model: event.model, variant: getString(event.variant) },
      selectionReason: getString(event.selection_reason),
    };
  }

  return latestSelection;
}

export function reconstructRecentSegments(events: LocalEvent[], limit = 20): ReconstructedSegment[] {
  const segments = new Map<string, SegmentDraft>();

  events.forEach((event, eventIndex) => {
    if (
      !isAudioSegmentEvent(event) &&
      !isSttResultEvent(event) &&
      !isSttCorrectionEvent(event) &&
      !isSttBenchmarkSetMembershipEvent(event) &&
      !isNormalizationResultEvent(event)
    ) {
      return;
    }

    const key = getSegmentKey(event.session_id, event.segment_id);
    const draft =
      segments.get(key) ??
      createSegmentDraft(event.session_id, event.segment_id, eventIndex);

    if (isAudioSegmentEvent(event)) {
      draft.audioRef = event.audio_ref;
      draft.createdAt = getString(event.created_at) ?? draft.createdAt;
      draft.lastEventIndex = eventIndex;
    }

    if (isSttResultEvent(event)) {
      draft.audioRef = getString(event.audio_ref) ?? draft.audioRef;
      draft.transcript = event.stt_output;
      draft.sttEngine = getString(event.stt_engine);
      draft.sttModel = getString(event.stt_model);
      draft.sttLanguage = getString(event.stt_language);
      draft.audioDurationSeconds = getNumber(event.audio_duration_seconds);
      draft.transcriptionDurationMs = getNumber(event.transcription_duration_ms);
      draft.createdAt = getString(event.created_at) ?? draft.createdAt;
      draft.lastEventIndex = eventIndex;
    }

    if (isSttCorrectionEvent(event)) {
      if (draft.lastCorrectionEventIndex === null || eventIndex > draft.lastCorrectionEventIndex) {
        draft.correctedTranscript = event.corrected_transcript;
        draft.correctionCreatedAt = getString(event.created_at);
        draft.correctionMethod = getString(event.correction_method) ?? "unknown";
        draft.correctionKind = getCorrectionKind(event.correction_kind);
        draft.lastCorrectionEventIndex = eventIndex;
      }
    }

    if (isSttBenchmarkSetMembershipEvent(event)) {
      if (draft.lastBenchmarkSetEventIndex === null || eventIndex > draft.lastBenchmarkSetEventIndex) {
        draft.audioRef = getString(event.audio_ref) ?? draft.audioRef;
        draft.benchmarkSetSplit = event.split;
        draft.benchmarkSetCreatedAt = getString(event.created_at);
        draft.lastBenchmarkSetEventIndex = eventIndex;
      }
    }

    if (isNormalizationResultEvent(event)) {
      if (draft.lastNormalizationEventIndex === null || eventIndex > draft.lastNormalizationEventIndex) {
        draft.audioRef = getString(event.audio_ref) ?? draft.audioRef;
        draft.normalizedTranscript = event.output_transcript;
        draft.normalizationCreatedAt = getString(event.created_at);
        draft.lastNormalizationEventIndex = eventIndex;
      }
    }

    segments.set(key, draft);
  });

  return Array.from(segments.values())
    .filter((segment): segment is SegmentDraft & { audioRef: string; transcript: string } => {
      return typeof segment.audioRef === "string" && typeof segment.transcript === "string";
    })
    .sort((left, right) => right.lastEventIndex - left.lastEventIndex)
    .slice(0, limit)
    .map((segment) => ({
      createdAt: segment.createdAt,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      transcript: segment.transcript,
      normalizedTranscript: segment.normalizedTranscript,
      normalizationCreatedAt: segment.normalizationCreatedAt,
      sttEngine: segment.sttEngine ?? "unknown",
      sttModel: segment.sttModel ?? "unknown",
      sttLanguage: segment.sttLanguage ?? "unknown",
      audioDurationSeconds: segment.audioDurationSeconds,
      transcriptionDurationMs: segment.transcriptionDurationMs,
      correctedTranscript: segment.correctedTranscript,
      correctionCreatedAt: segment.correctionCreatedAt,
      correctionMethod: segment.correctionMethod,
      correctionKind: segment.correctionKind,
      benchmarkSetSplit: segment.benchmarkSetSplit,
      benchmarkSetCreatedAt: segment.benchmarkSetCreatedAt,
    }));
}

function createSegmentDraft(sessionId: string, segmentId: string, eventIndex: number): SegmentDraft {
  return {
    createdAt: null,
    sessionId,
    segmentId,
    audioRef: null,
    transcript: null,
    normalizedTranscript: null,
    normalizationCreatedAt: null,
    sttEngine: null,
    sttModel: null,
    sttLanguage: null,
    audioDurationSeconds: null,
    transcriptionDurationMs: null,
    correctedTranscript: null,
    correctionCreatedAt: null,
    correctionMethod: null,
    correctionKind: null,
    benchmarkSetSplit: null,
    benchmarkSetCreatedAt: null,
    lastEventIndex: eventIndex,
    lastCorrectionEventIndex: null,
    lastBenchmarkSetEventIndex: null,
    lastNormalizationEventIndex: null,
  };
}

function getSegmentKey(sessionId: string, segmentId: string): string {
  return `${sessionId}/${segmentId}`;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isCorrectionKind(value: unknown): value is CorrectionKind {
  return (
    value === "acoustic" ||
    value === "math_transform" ||
    value === "normalization" ||
    value === "rephrasing"
  );
}

function getCorrectionKind(value: unknown): CorrectionKind | null {
  return isCorrectionKind(value) ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAudioSegmentEvent(event: LocalEvent): event is AudioSegmentEvent {
  return (
    event.event_type === "audio_segment" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string" &&
    typeof event.audio_ref === "string"
  );
}

function isSttResultEvent(event: LocalEvent): event is SttResultEvent {
  return (
    event.event_type === "stt_result" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string" &&
    typeof event.stt_output === "string"
  );
}

function isSttBenchmarkResultEvent(event: LocalEvent): event is SttBenchmarkResultEvent {
  return (
    event.event_type === "stt_benchmark_result" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string"
  );
}

function isSttCorrectionEvent(event: LocalEvent): event is SttCorrectionEvent {
  return (
    event.event_type === "stt_correction" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string" &&
    typeof event.raw_transcript === "string" &&
    typeof event.corrected_transcript === "string"
  );
}

function isSttBenchmarkSetMembershipEvent(event: LocalEvent): event is SttBenchmarkSetMembershipEvent {
  return (
    event.event_type === "stt_benchmark_set_membership" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string" &&
    isSttBenchmarkSetSplit(event.split)
  );
}

function isSttCandidateSelectionEvent(event: LocalEvent): event is SttCandidateSelectionEvent {
  return (
    event.event_type === "stt_candidate_selection" &&
    typeof event.stage === "string" &&
    typeof event.provider === "string" &&
    typeof event.model === "string"
  );
}

function isNormalizationResultEvent(event: LocalEvent): event is NormalizationResultEvent {
  return (
    event.event_type === "normalization_result" &&
    typeof event.session_id === "string" &&
    typeof event.segment_id === "string" &&
    typeof (event as NormalizationResultEvent).output_transcript === "string"
  );
}

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}
