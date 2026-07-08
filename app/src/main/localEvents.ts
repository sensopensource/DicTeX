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
};

export type SttBenchmarkResultEvent = {
  event_type: "stt_benchmark_result";
  session_id: string;
  segment_id: string;
  created_at?: string;
  audio_ref?: string;
  stt_engine?: string;
  stt_model?: string;
  stt_language?: string;
  transcript?: string;
  audio_duration_seconds?: number | null;
  transcription_duration_ms?: number;
};

export type CorrectionKind = "acoustic" | "math_transform" | "normalization" | "rephrasing";

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

export type UnknownLocalEvent = {
  event_type: string;
  [key: string]: unknown;
};

export type LocalEvent =
  | AudioSegmentEvent
  | SttResultEvent
  | SttBenchmarkResultEvent
  | SttCorrectionEvent
  | SttBenchmarkSetMembershipEvent
  | UnknownLocalEvent;

export type ReconstructedSegment = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  transcript: string;
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

type SegmentDraft = {
  createdAt: string | null;
  sessionId: string;
  segmentId: string;
  audioRef: string | null;
  transcript: string | null;
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

export function reconstructRecentSegments(events: LocalEvent[], limit = 20): ReconstructedSegment[] {
  const segments = new Map<string, SegmentDraft>();

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

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}
