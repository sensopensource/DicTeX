import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./overlay.css";

import type { OverlayPreview, OverlayView } from "../../main/overlayState.js";
import { formatOverlayPreviewSummary, type OverlayPreviewVariant } from "./overlayPreview.js";

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

function Preview({ preview, variant }: { preview: OverlayPreview; variant: OverlayPreviewVariant }): React.ReactElement {
  if (preview.kind === "empty") {
    return <p className="hud-preview hud-preview-quiet">Nothing to insert</p>;
  }

  if (preview.kind === "summary") {
    // Long dictations degrade to a count: the notebook is where the text is read.
    return <p className="hud-preview hud-preview-quiet">{formatOverlayPreviewSummary(preview.characters, variant)}</p>;
  }

  return <p className="hud-preview">{preview.text}</p>;
}

type InsertedView = Extract<OverlayView, { phase: "inserted" }>;

/**
 * The result of the last dictation: what was inserted, how it got there, and —
 * when the normalizer actually changed something — a way to see what was said
 * before the rules ran.
 *
 * The toggle is the HUD's only interactive control. It is marked
 * `data-hud-interactive` so click-through is lifted while, and only while, the
 * pointer is genuinely over it (see `OverlayApp`).
 */
function InsertedCard({ view }: { view: InsertedView }): React.ReactElement {
  // Always opens on what actually reached the notebook; raw is the deliberate
  // second look. A new dictation remounts this card, so it resets on its own.
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="hud-card hud-card-inserted">
      <div className="hud-row">
        <span className={`hud-toast ${view.paste === "pasted" ? "hud-toast-pasted" : "hud-toast-clipboard"}`}>
          {view.paste === "pasted" ? "pasted" : "copied — press Ctrl+V to insert"}
        </span>

        {view.hasNormalized && (
          <div className="hud-toggle" data-hud-interactive>
            <button type="button" aria-pressed={!showRaw} onClick={() => setShowRaw(false)}>
              normalized
            </button>
            <button type="button" aria-pressed={showRaw} onClick={() => setShowRaw(true)}>
              raw
            </button>
          </div>
        )}
      </div>

      <Preview preview={showRaw ? view.raw : view.normalized} variant={showRaw ? "raw" : "inserted"} />

      {!view.normalizerEnabled && <p className="hud-preview hud-preview-quiet">Normalizer off — raw STT inserted</p>}
    </div>
  );
}

/**
 * Identifies a dictation's result, so a new one remounts the card with a fresh
 * toggle instead of showing the previous dictation's raw/normalized choice.
 */
function insertedKey(view: InsertedView): string {
  return JSON.stringify([view.raw, view.normalized]);
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
      return <InsertedCard key={insertedKey(view)} view={view} />;

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
  const interactiveRef = useRef(false);

  useEffect(() => window.dictexOverlay.onView(setView), []);

  /**
   * Lift or restore click-through. Click-through is the safe default in every
   * sense: the HUD sits over the notebook, so capturing a click it was not
   * offered would steal it from the text underneath.
   */
  function applyInteractive(next: boolean): void {
    if (interactiveRef.current === next) {
      return;
    }

    interactiveRef.current = next;
    try {
      window.dictexOverlay.setInteractive(next);
    } catch {
      // Failing to become clickable only costs the toggle; failing to give
      // click-through back would cost the notebook its clicks, which is why the
      // phase effect below always re-asserts it.
    }
  }

  // The window is click-through, so it receives mousemove (forwarded) but no
  // enter/leave on its contents. Hit-testing each move is what lets exactly the
  // toggle — and nothing else — opt into being clickable.
  useEffect(() => {
    function handleMouseMove(event: MouseEvent): void {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      applyInteractive(element instanceof Element && element.closest("[data-hud-interactive]") !== null);
    }

    function handleMouseLeave(): void {
      applyInteractive(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    // Leaving the window outright stops the moves above, so click-through has to
    // be handed back here or the HUD would stay clickable over the notebook.
    document.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      applyInteractive(false);
    };
  }, []);

  const hasInteractiveControl = view?.phase === "inserted" && view.hasNormalized;

  // A phase with nothing to click gives click-through straight back, so the HUD
  // can never keep capturing clicks after the control it captured them for is
  // gone — including when the card is dismissed with the pointer still on it.
  useEffect(() => {
    if (!hasInteractiveControl) {
      applyInteractive(false);
    }
  }, [hasInteractiveControl]);

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
