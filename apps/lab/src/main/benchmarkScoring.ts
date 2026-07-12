import {
  calculateCharacterErrorRate,
  getLatestSttCorrectionByKind,
  type LocalEvent,
} from "@dictex/shared";

export type SttBenchmarkReference = {
  referenceTranscript: string | null;
  correctionCreatedAt: string | null;
};

export type SttBenchmarkScore = {
  stage: "stt";
  metric: "cer";
  value: number;
  referenceTranscript: string;
  correctionCreatedAt: string | null;
};

/**
 * Scores one STT output against either a run's frozen reference or, for a
 * direct benchmark, the segment's latest acoustic correction. Passing a
 * frozen null reference deliberately disables scoring; it never falls back to
 * the current event log.
 */
export function scoreSttBenchmarkTranscript(
  transcript: string,
  events: LocalEvent[],
  sessionId: string,
  segmentId: string,
  frozenReference?: SttBenchmarkReference,
): SttBenchmarkScore | null {
  const acousticCorrection =
    frozenReference === undefined
      ? getLatestSttCorrectionByKind(events, sessionId, segmentId, "acoustic")
      : null;
  const reference =
    frozenReference ?? {
      referenceTranscript: acousticCorrection?.correctedTranscript ?? null,
      correctionCreatedAt: acousticCorrection?.correctionCreatedAt ?? null,
    };

  if (reference.referenceTranscript === null) {
    return null;
  }

  return {
    stage: "stt",
    metric: "cer",
    value: calculateCharacterErrorRate(transcript, reference.referenceTranscript),
    referenceTranscript: reference.referenceTranscript,
    correctionCreatedAt: reference.correctionCreatedAt,
  };
}
