import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

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

export type UnknownLocalEvent = {
  event_type?: string;
  [key: string]: unknown;
};

export type LocalEvent = AudioSegmentEvent | SttResultEvent | SttBenchmarkResultEvent | UnknownLocalEvent;

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
};

type AudioSegmentState = {
  createdAt: string | null;
  audioRef: string;
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
      events.push(JSON.parse(line) as LocalEvent);
    } catch {
      continue;
    }
  }

  return events;
}

export function reconstructSegments(events: LocalEvent[], limit?: number): ReconstructedSegment[] {
  const audioSegments = new Map<string, AudioSegmentState>();
  const reconstructedSegments: ReconstructedSegment[] = [];

  for (const event of events) {
    if (isAudioSegmentEvent(event)) {
      audioSegments.set(getSegmentKey(event.session_id, event.segment_id), {
        createdAt: typeof event.created_at === "string" ? event.created_at : null,
        audioRef: event.audio_ref,
      });
      continue;
    }

    if (isSttResultEvent(event)) {
      const audioSegment = audioSegments.get(getSegmentKey(event.session_id, event.segment_id));
      const audioRef = typeof event.audio_ref === "string" ? event.audio_ref : audioSegment?.audioRef;

      if (!audioRef) {
        continue;
      }

      reconstructedSegments.push({
        createdAt:
          typeof event.created_at === "string"
            ? event.created_at
            : audioSegment?.createdAt ?? null,
        sessionId: event.session_id,
        segmentId: event.segment_id,
        audioRef,
        transcript: event.stt_output,
        sttEngine: typeof event.stt_engine === "string" ? event.stt_engine : "unknown",
        sttModel: typeof event.stt_model === "string" ? event.stt_model : "unknown",
        sttLanguage: typeof event.stt_language === "string" ? event.stt_language : "unknown",
        audioDurationSeconds: typeof event.audio_duration_seconds === "number" ? event.audio_duration_seconds : null,
        transcriptionDurationMs:
          typeof event.transcription_duration_ms === "number" ? event.transcription_duration_ms : null,
      });
    }
  }

  const recentSegments = reconstructedSegments.reverse();
  return typeof limit === "number" ? recentSegments.slice(0, limit) : recentSegments;
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

function getSegmentKey(sessionId: string, segmentId: string): string {
  return `${sessionId}:${segmentId}`;
}
