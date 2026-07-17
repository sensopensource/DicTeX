import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./overlay.css";

import type { OverlayPreview, OverlayView } from "../../main/overlayState.js";

/**
 * The floating HUD's renderer (#166).
 *
 * A dumb view by construction: it receives an already-derived `OverlayView` and
 * draws it. It reads nothing, decides nothing, and holds no dictation state — so
 * it cannot disagree with Home about what DicTeX is doing, and a bug here can
 * never reach the transcript, the clipboard or the event log.
 *
 * The only local state is presentational: the recording chronometer ticks from
 * the timestamp it was given, rather than the main process pushing one message
 * per frame.
 *
 * `OverlayView` is imported as a type only (erased at build time) from the
 * module that derives it, so the two ends cannot drift.
 */

declare global {
  interface Window {
    dictexOverlay: {
      onView: (callback: (view: OverlayView) => void) => () => void;
      setInteractive: (interactive: boolean) => void;
    };
  }
}

const VU_SEGMENTS = 16;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Tick locally from the recording's start timestamp. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return Math.max(0, now - startedAt);
}

function VuMeter({ level }: { level: number }): React.ReactElement {
  const lit = Math.round(level * VU_SEGMENTS);

  return (
    <div className="hud-vu" aria-hidden="true">
      {Array.from({ length: VU_SEGMENTS }, (_, index) => (
        <span key={index} className={`hud-vu-segment${index < lit ? " hud-vu-segment-lit" : ""}`} />
      ))}
    </div>
  );
}

function Preview({ preview }: { preview: OverlayPreview }): React.ReactElement {
  if (preview.kind === "empty") {
    return <p className="hud-preview hud-preview-quiet">Nothing to insert</p>;
  }

  if (preview.kind === "summary") {
    // Long dictations degrade to a count: the notebook is where the text is read.
    return <p className="hud-preview hud-preview-quiet">{preview.characters} characters inserted</p>;
  }

  return <p className="hud-preview">{preview.text}</p>;
}

function RecordingCard({ startedAt, level }: { startedAt: number; level: number }): React.ReactElement {
  const elapsed = useElapsed(startedAt);

  return (
    <div className="hud-card hud-card-recording">
      <div className="hud-row">
        <span className="hud-dot hud-dot-recording" aria-hidden="true" />
        <span className="hud-label">Recording</span>
        <span className="hud-timer">{formatElapsed(elapsed)}</span>
      </div>
      <VuMeter level={level} />
    </div>
  );
}

function Hud({ view }: { view: OverlayView }): React.ReactElement {
  switch (view.phase) {
    case "ready":
      return (
        <div className="hud-pill">
          <span className="hud-dot hud-dot-ready" aria-hidden="true" />
          <span className="hud-label">Ready</span>
        </div>
      );

    case "warming":
      return (
        <div className="hud-pill">
          <span className="hud-dot hud-dot-warming" aria-hidden="true" />
          <span className="hud-label">Preparing</span>
        </div>
      );

    case "recording":
      return <RecordingCard startedAt={view.startedAt} level={view.level} />;

    case "transcribing":
      return (
        <div className="hud-card">
          <div className="hud-row">
            <span className="hud-dot hud-dot-transcribing" aria-hidden="true" />
            <span className="hud-label">Transcribing</span>
          </div>
        </div>
      );

    case "inserted":
      return (
        <div className="hud-card hud-card-inserted">
          <div className="hud-row">
            <span
              className={`hud-toast ${view.paste === "pasted" ? "hud-toast-pasted" : "hud-toast-clipboard"}`}
            >
              {view.paste === "pasted" ? "pasted" : "copied — press Ctrl+V to insert"}
            </span>
          </div>
          <Preview preview={view.normalized} />
        </div>
      );

    case "error":
      return (
        <div className="hud-card hud-card-error">
          <div className="hud-row">
            <span className="hud-dot hud-dot-error" aria-hidden="true" />
            <span className="hud-label">Error</span>
          </div>
          <p className="hud-preview hud-error-message">{view.message}</p>
          {view.audioKept && <p className="hud-preview hud-preview-quiet">Audio kept — retry from the notebook</p>}
        </div>
      );

    default:
      return <div className="hud-pill" />;
  }
}

function OverlayApp(): React.ReactElement | null {
  const [view, setView] = useState<OverlayView | null>(null);

  useEffect(() => window.dictexOverlay.onView(setView), []);

  // Until the first view arrives there is nothing honest to show, and a HUD that
  // guessed would be worse than one that waits.
  if (view === null) {
    return null;
  }

  return (
    <div className="hud" role="status" aria-live="polite">
      <Hud view={view} />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <OverlayApp />
    </React.StrictMode>,
  );
}
