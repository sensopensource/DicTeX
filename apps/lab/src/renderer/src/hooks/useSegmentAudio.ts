import { useEffect, useRef, useState } from "react";
import type { ReconstructedSegment } from "@dictex/shared";
import { getSegmentKey } from "@dictex/shared/formatting";
import type { LabApi } from "../api.js";

export type SegmentAudio = {
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playSegmentAudio: (segment: ReconstructedSegment) => Promise<void>;
  stopAudioPlayback: () => void;
};

/**
 * Plays one segment's audio at a time, read from the (read-only) DicTeX data
 * folder through the main process.
 *
 * The player and its object URL live in refs rather than state: they are not
 * rendered, and a re-render must never lose the handle needed to revoke the
 * URL. Every exit path — a second click on the playing segment, playback
 * ending, an error, unmount — goes through `stopAudioPlayback`, so a blob URL
 * is revoked exactly once and the Lab never holds a decoded segment alive after
 * it stops being heard.
 */
export function useSegmentAudio({ api }: { api: LabApi }): SegmentAudio {
  const [audioError, setAudioError] = useState("");
  const [loadingAudioSegmentKey, setLoadingAudioSegmentKey] = useState("");
  const [playingAudioSegmentKey, setPlayingAudioSegmentKey] = useState("");
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef("");

  function stopAudioPlayback(): void {
    audioPlayerRef.current?.pause();
    audioPlayerRef.current = null;
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = "";
    }
    setPlayingAudioSegmentKey("");
    setLoadingAudioSegmentKey("");
  }

  useEffect(() => {
    return () => {
      stopAudioPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function playSegmentAudio(segment: ReconstructedSegment): Promise<void> {
    const segmentKey = getSegmentKey(segment);
    if (playingAudioSegmentKey === segmentKey) {
      stopAudioPlayback();
      return;
    }

    stopAudioPlayback();
    setAudioError("");
    setLoadingAudioSegmentKey(segmentKey);

    try {
      const playback = await api.getSegmentAudio({
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        audioRef: segment.audioRef,
      });
      const audioBytes = new Uint8Array(playback.audioBytes);
      const audioBuffer = audioBytes.buffer.slice(
        audioBytes.byteOffset,
        audioBytes.byteOffset + audioBytes.byteLength,
      ) as ArrayBuffer;
      const audioUrl = URL.createObjectURL(new Blob([audioBuffer], { type: playback.mimeType }));
      const player = new Audio(audioUrl);

      audioPlayerRef.current = player;
      audioObjectUrlRef.current = audioUrl;
      player.onended = stopAudioPlayback;
      player.onerror = () => {
        setAudioError(`Could not play ${segment.sessionId} / ${segment.segmentId}`);
        stopAudioPlayback();
      };

      await player.play();
      setPlayingAudioSegmentKey(segmentKey);
    } catch (playError) {
      setAudioError(playError instanceof Error ? playError.message : "Could not play audio segment");
      stopAudioPlayback();
    } finally {
      setLoadingAudioSegmentKey("");
    }
  }

  return {
    audioError,
    loadingAudioSegmentKey,
    playingAudioSegmentKey,
    playSegmentAudio,
    stopAudioPlayback,
  };
}
