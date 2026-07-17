import { useEffect, useState } from "react";
import type { DictexApi, RecentSegment } from "../api.js";

export type History = {
  recentSegments: RecentSegment[];
  historyError: string;
  isLoadingHistory: boolean;
  loadRecentSegments: () => Promise<void>;
  copyHistoryTranscript: (segment: RecentSegment, mode: "raw" | "inserted") => Promise<void>;
};

/**
 * The collapsible recent-segments panel: loads on mount and again whenever a
 * new dictation completes (wired from `useDictation` in the composition root,
 * same `onSaved`-style callback the Lab's hooks use).
 */
export function useHistory({ api, onNotice }: { api: DictexApi; onNotice: (message: string) => void }): History {
  const [recentSegments, setRecentSegments] = useState<RecentSegment[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  async function loadRecentSegments(): Promise<void> {
    if (typeof api.getRecentSegments !== "function") {
      setHistoryError("Restart DicTeX to load the history preload API");
      return;
    }

    setHistoryError("");
    setIsLoadingHistory(true);

    try {
      setRecentSegments(await api.getRecentSegments(20));
    } catch (historyLoadError) {
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Could not load recent segments");
    } finally {
      setIsLoadingHistory(false);
    }
  }

  useEffect(() => {
    void loadRecentSegments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyHistoryTranscript(segment: RecentSegment, mode: "raw" | "inserted"): Promise<void> {
    const text =
      mode === "inserted"
        ? segment.normalizedTranscript && segment.normalizedTranscript.length > 0
          ? segment.normalizedTranscript
          : segment.transcript
        : segment.transcript;
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    onNotice(`Copied ${mode === "inserted" ? "inserted" : "raw"} transcript for ${segment.sessionId} / ${segment.segmentId}`);
  }

  return { recentSegments, historyError, isLoadingHistory, loadRecentSegments, copyHistoryTranscript };
}
