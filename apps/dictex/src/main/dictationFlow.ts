import type { NormalizationResult } from "@dictex/shared";

import { prepareNormalization } from "./normalizationPolicy.js";
import type { WorkerTranscription } from "./sttWorkerClient.js";

/**
 * The dictation orchestration, factored out of the Electron IPC handler so it
 * can be exercised end-to-end with a fake worker: store audio, then transcribe
 * through the persistent worker, then apply the normalizer policy, writing
 * append-only events in the order the data invariants require.
 *
 * Invariants enforced here:
 * - the audio file and its `audio_segment` event are written BEFORE any
 *   transcription attempt, so a failed transcription still leaves the audio and
 *   its segment record on disk for manual retry;
 * - `stt_result` and `normalization_result` are written ONLY after a successful
 *   transcription, so the worker's own restart+replay on a crash can never
 *   duplicate them (this function sees a single resolved result or a throw);
 * - the raw `stt_result.stt_output` mirrors the worker's raw transcript, and the
 *   normalizer policy runs afterwards in-process (worker returns raw STT only);
 * - with the normalizer Off the inserted text is byte-identical to the raw STT
 *   and the `normalization_result` carries `disabled: true`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type StoredAudio = {
  audioPath: string;
  audioRef: string;
};

export type DictationFlowDeps = {
  now: () => number;
  isoNow: () => string;
  storeAudio: (segmentId: string, mimeType: string, audioBytes: Uint8Array) => Promise<StoredAudio>;
  appendEvent: (event: Record<string, JsonValue>) => Promise<void>;
  /** Transcribe a stored audio file through the persistent worker (with its own
   * restart+replay recovery). Rejecting leaves the audio and `audio_segment`
   * intact and writes no STT/normalization events. */
  transcribe: (audioPath: string) => Promise<WorkerTranscription>;
  normalize: (rawTranscript: string) => Promise<NormalizationResult>;
  writeClipboard: (text: string) => void;
  pasteActiveApp: () => Promise<boolean>;
};

export type DictationFlowInput = {
  sessionId: string;
  segmentId: string;
  createdAt: string;
  mimeType: string;
  audioBytes: Uint8Array;
  normalizerEnabled: boolean;
  autoPaste: boolean;
};

export type TranscriptionResult = {
  /** Raw STT output. Kept as the correction base; `stt_result.stt_output` mirrors it. */
  transcript: string;
  /** Inserted text — normalized when enabled, raw otherwise. */
  normalizedTranscript: string;
  /** True when normalization changed the text (normalized differs from raw). */
  normalizationApplied: boolean;
  /** Quiet diagnostics from the normalizer (e.g. malformed dictionary). */
  normalizationDiagnostics: string[];
  copiedToClipboard: boolean;
  pastedToActiveApp: boolean;
  sessionId: string;
  segmentId: string;
  audioRef: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
  transcriptionDurationMs: number;
};

export async function runDictationTranscription(
  deps: DictationFlowDeps,
  input: DictationFlowInput,
): Promise<TranscriptionResult> {
  const { sessionId, segmentId } = input;

  // 1. Persist the audio and its segment record before transcribing, so a
  //    failed transcription never loses the audio.
  const { audioPath, audioRef } = await deps.storeAudio(segmentId, input.mimeType, input.audioBytes);
  await deps.appendEvent({
    event_type: "audio_segment",
    session_id: sessionId,
    segment_id: segmentId,
    created_at: input.createdAt,
    audio_ref: audioRef,
    audio_mime_type: input.mimeType || "unknown",
    audio_size_bytes: input.audioBytes.byteLength,
  });

  // 2. Transcribe through the persistent worker. A rejection here (a second
  //    crash, or a recoverable worker error) propagates without writing any
  //    stt_result / normalization_result — the audio and audio_segment stay.
  const transcriptionStartedAt = deps.now();
  const worker = await deps.transcribe(audioPath);
  const transcriptionDurationMs = deps.now() - transcriptionStartedAt;

  // 3. Exactly one stt_result per successful transcription; the raw output is
  //    left untouched by the normalizer.
  await deps.appendEvent({
    event_type: "stt_result",
    session_id: sessionId,
    segment_id: segmentId,
    created_at: deps.isoNow(),
    audio_ref: audioRef,
    stt_engine: worker.sttEngine,
    stt_model: worker.sttModel,
    stt_language: worker.sttLanguage,
    stt_output: worker.transcript,
    corrected_transcript: null,
    audio_duration_seconds: worker.audioDurationSeconds,
    transcription_duration_ms: transcriptionDurationMs,
  });

  // 4. Apply the normalizer policy in-process (unchanged by the worker switch):
  //    On runs the pipeline; Off keeps the STT output byte-identical.
  const preparedNormalization = await prepareNormalization(worker.transcript, input.normalizerEnabled, () =>
    deps.normalize(worker.transcript),
  );

  await deps.appendEvent({
    event_type: "normalization_result",
    session_id: sessionId,
    segment_id: segmentId,
    created_at: deps.isoNow(),
    audio_ref: audioRef,
    input_transcript: preparedNormalization.inputTranscript,
    output_transcript: preparedNormalization.outputTranscript,
    ...preparedNormalization.eventState,
    layers: preparedNormalization.layers,
    diagnostics: preparedNormalization.normalizationDiagnostics,
  });

  const { insertedTranscript, normalizationApplied, normalizationDiagnostics } = preparedNormalization;

  deps.writeClipboard(insertedTranscript);
  const pastedToActiveApp =
    input.autoPaste && insertedTranscript.trim().length > 0 ? await deps.pasteActiveApp() : false;

  return {
    transcript: worker.transcript,
    normalizedTranscript: insertedTranscript,
    normalizationApplied,
    normalizationDiagnostics,
    copiedToClipboard: true,
    pastedToActiveApp,
    sessionId,
    segmentId,
    audioRef,
    sttEngine: worker.sttEngine,
    sttModel: worker.sttModel,
    sttLanguage: worker.sttLanguage,
    audioDurationSeconds: worker.audioDurationSeconds,
    transcriptionDurationMs,
  };
}
