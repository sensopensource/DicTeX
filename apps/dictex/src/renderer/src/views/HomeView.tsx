import React, { useState } from "react";
import { formatAudioDuration, formatLatency, formatTimestamp, getSegmentKey } from "@dictex/shared/formatting";

import type { RecentSegment, SttConfig, SttWorkerState, SttWorkerStatus } from "../api.js";
import type { Dictation, Status } from "../hooks/useDictation.js";

export type HomeViewProps = {
  dictation: Dictation;
  sttConfig: SttConfig | null;
  availableSttModels: string[];
  isSettingSttModel: boolean;
  canChangeSttModel: boolean;
  changeSttModel: (model: string) => Promise<void>;
  sttWorkerStatus: SttWorkerStatus | null;
  normalizerEnabled: boolean | null;
  isSettingNormalizer: boolean;
  canChangeNormalizerEnabled: boolean;
  changeNormalizerEnabled: (enabled: boolean) => Promise<void>;
  recentSegments: RecentSegment[];
  historyError: string;
  isLoadingHistory: boolean;
  loadRecentSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playHistoryAudio: (segment: RecentSegment) => void;
  copyHistoryTranscript: (segment: RecentSegment, mode: "raw" | "inserted") => void;
  isOpeningLab: boolean;
  openLab: () => void;
  openDataFolder: () => void;
  openEventsLog: () => void;
  openDictionaryFile: () => void;
  openRulesFile: () => void;
  notice: string;
};

/**
 * DicTeX's sole view: the compact utility UI assembled from the hooks in
 * `../hooks`. This component only renders — every piece of state and every
 * effect lives in its owning hook, wired here by the composition root
 * (`main.tsx`), the same split the Lab's renderer uses (`docs/development.md`
 * §"Structure du renderer du Lab").
 */
export function HomeView({
  dictation,
  sttConfig,
  availableSttModels,
  isSettingSttModel,
  canChangeSttModel,
  changeSttModel,
  sttWorkerStatus,
  normalizerEnabled,
  isSettingNormalizer,
  canChangeNormalizerEnabled,
  changeNormalizerEnabled,
  recentSegments,
  historyError,
  isLoadingHistory,
  loadRecentSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playHistoryAudio,
  copyHistoryTranscript,
  isOpeningLab,
  openLab,
  openDataFolder,
  openEventsLog,
  openDictionaryFile,
  openRulesFile,
  notice,
}: HomeViewProps): React.ReactElement {
  const { status, transcript, error, hotkeyStatus, lastResult, lastPasteState, diagnostics, toggleDictation, copyLastInserted } =
    dictation;

  // Idle Home hides empty diagnostics: each metric appears only once a dictation
  // has given it a value (never seeded from config, never a "-" placeholder). The
  // grid grows from the first dictation and then only updates in place.
  const metrics: { label: string; value: string }[] = [];
  if (diagnostics) {
    const { result, paste } = diagnostics;
    metrics.push({ label: "Engine", value: result.sttEngine });
    metrics.push({ label: "Model", value: result.sttModel });
    metrics.push({ label: "Language", value: result.sttLanguage });
    metrics.push({ label: "Latency", value: `${result.transcriptionDurationMs} ms` });
    metrics.push({ label: "Session", value: result.sessionId });
    metrics.push({ label: "Segment", value: result.segmentId });
    if (result.audioDurationSeconds !== null) {
      metrics.push({ label: "Audio", value: `${result.audioDurationSeconds.toFixed(2)} s` });
    }
    metrics.push({ label: "Output", value: paste === "pasted" ? "pasted" : "clipboard" });
  }

  const statusLabel =
    status === "done" && lastPasteState === "pasted"
      ? "pasted"
      : status === "done" && lastPasteState === "clipboard-only"
        ? "copied"
        : status;

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX</p>
          <h1>Local dictation</h1>
        </div>
        <div className={`status-pill status-${statusLabel}`}>{statusLabel}</div>
      </header>

      <section className="panel nav-panel">
        <button className="nav-button" disabled={isOpeningLab} onClick={openLab}>
          {isOpeningLab ? "Opening Lab…" : "Open Lab"}
        </button>
      </section>

      <section className="panel controls-panel">
        <button className="record-button" disabled={status === "transcribing"} onClick={() => toggleDictation("manual")}>
          {status === "recording" ? "Arrêter" : "Démarrer"}
        </button>

        <div className="shortcut-row">
          <span>Shortcut</span>
          <strong>Win+Alt+Space</strong>
          <span className={hotkeyStatus === null ? "signal-muted" : hotkeyStatus.registered ? "signal-good" : "signal-bad"}>
            {hotkeyStatus === null ? "checking" : hotkeyStatus.registered ? "registered" : "not registered"}
          </span>
        </div>

        <div className="shortcut-row">
          <span>STT model</span>
          <select
            aria-label="Active STT model"
            className="secondary-select"
            disabled={!canChangeSttModel || isSettingSttModel || isSettingNormalizer || status === "recording" || status === "transcribing"}
            value={sttConfig?.model ?? ""}
            onChange={(event) => void changeSttModel(event.currentTarget.value)}
          >
            {sttConfig?.model && !availableSttModels.includes(sttConfig.model) && (
              <option value={sttConfig.model}>{sttConfig.model}</option>
            )}
            {availableSttModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <span className="signal-muted">{isSettingSttModel ? "saving" : "next dictation"}</span>
        </div>

        <div className="shortcut-row">
          <span>Normalizer</span>
          <label className="normalizer-switch">
            <input
              aria-label="Enable normalizer"
              type="checkbox"
              checked={normalizerEnabled ?? true}
              disabled={
                normalizerEnabled === null ||
                !canChangeNormalizerEnabled ||
                isSettingNormalizer ||
                isSettingSttModel ||
                status === "recording" ||
                status === "transcribing"
              }
              onChange={(event) => void changeNormalizerEnabled(event.currentTarget.checked)}
            />
            <span className="normalizer-switch-track" aria-hidden="true">
              <span className="normalizer-switch-thumb" />
            </span>
            <strong>{normalizerEnabled === null ? "…" : normalizerEnabled ? "On" : "Off"}</strong>
          </label>
          <span className="signal-muted normalizer-hint">
            {isSettingNormalizer
              ? "saving"
              : normalizerEnabled === null
                ? "loading"
                : normalizerEnabled
                  ? "math + commands"
                  : "raw STT; commands stay literal"}
          </span>
        </div>

        <div className="shortcut-row">
          <span>STT engine</span>
          <strong>{formatSttWorkerState(sttWorkerStatus?.state)}</strong>
          <span className={sttWorkerStatus?.state === "error" ? "signal-bad" : "signal-muted"}>
            {sttWorkerStatus?.workerGeneration ?? "starting"}
          </span>
        </div>

        {sttWorkerStatus?.workerStartupMs !== null && sttWorkerStatus?.workerStartupMs !== undefined && (
          <div className="shortcut-row">
            <span>Preparation</span>
            <strong>{formatLatency(sttWorkerStatus.workerStartupMs, { rejectNonFinite: true, round: true })}</strong>
            <span className="signal-muted">
              model load {formatLatency(sttWorkerStatus.modelLoadMs, { rejectNonFinite: true, round: true })}
            </span>
          </div>
        )}

        {sttWorkerStatus?.lastInferenceDurationMs !== null && sttWorkerStatus?.lastInferenceDurationMs !== undefined && (
          <div className="shortcut-row">
            <span>Warm inference</span>
            <strong>{formatLatency(sttWorkerStatus.lastInferenceDurationMs, { rejectNonFinite: true, round: true })}</strong>
            <span className="signal-muted">worker request</span>
          </div>
        )}
      </section>

      {metrics.length > 0 && (
        <section className="panel diagnostics-grid">
          {metrics.map((metric) => (
            <Metric key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </section>
      )}

      <HistoryPanel
        recentSegments={recentSegments}
        historyError={historyError}
        isLoadingHistory={isLoadingHistory}
        loadRecentSegments={loadRecentSegments}
        audioError={audioError}
        loadingAudioSegmentKey={loadingAudioSegmentKey}
        playingAudioSegmentKey={playingAudioSegmentKey}
        playHistoryAudio={playHistoryAudio}
        copyHistoryTranscript={copyHistoryTranscript}
        status={status}
      />

      <section className="panel last-transcript-panel">
        <div className="panel-header">
          <div>
            <h2>Last transcript</h2>
            <p>Raw STT output. Inserted text may differ after normalization.</p>
          </div>
          <button
            className="secondary-button"
            disabled={!transcript && !lastResult?.normalizedTranscript}
            onClick={() => void copyLastInserted()}
          >
            Copy
          </button>
        </div>
        {lastResult?.normalizedTranscript && lastResult.normalizedTranscript !== lastResult.transcript && (
          <p className="history-normalized-transcript" title="Text inserted after normalization">
            Inserted: {lastResult.normalizedTranscript}
          </p>
        )}
        <pre className="transcript">{transcript || "Waiting for dictation…"}</pre>
      </section>

      <section className="panel footer-panel">
        <button className="secondary-button" onClick={openDataFolder}>
          Open data folder
        </button>
        <button className="secondary-button" onClick={openEventsLog}>
          Open events log
        </button>
        <button className="secondary-button" onClick={openDictionaryFile}>
          Open dictionary
        </button>
        <button className="secondary-button" onClick={openRulesFile}>
          Open rule overlay
        </button>
      </section>

      {notice && <pre className="notice">{notice}</pre>}
      {error && <pre className="error">{error}</pre>}
    </main>
  );
}

type HistoryPanelProps = {
  recentSegments: RecentSegment[];
  historyError: string;
  isLoadingHistory: boolean;
  loadRecentSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playHistoryAudio: (segment: RecentSegment) => void;
  copyHistoryTranscript: (segment: RecentSegment, mode: "raw" | "inserted") => void;
  status: Status;
};

function HistoryPanel({
  recentSegments,
  historyError,
  isLoadingHistory,
  loadRecentSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playHistoryAudio,
  copyHistoryTranscript,
  status,
}: HistoryPanelProps): React.ReactElement {
  const [historyExpanded, setHistoryExpanded] = useState(false);

  return (
    <section className="panel history-panel" aria-busy={isLoadingHistory}>
      <div className="panel-header">
        <button
          className="history-toggle"
          aria-expanded={historyExpanded}
          onClick={() => setHistoryExpanded((expanded) => !expanded)}
        >
          <span className={`history-chevron ${historyExpanded ? "history-chevron-open" : ""}`} aria-hidden="true">
            ▸
          </span>
          <div>
            <h2>Recent segments</h2>
            <p>{recentSegments.length > 0 ? `${recentSegments.length} local dictations` : "Local segment history"}</p>
          </div>
        </button>
        <button
          className="secondary-button"
          disabled={isLoadingHistory || status === "recording" || status === "transcribing"}
          onClick={() => loadRecentSegments()}
        >
          {isLoadingHistory ? "Loading" : "Refresh"}
        </button>
      </div>

      {historyError && <pre className="error">{historyError}</pre>}
      {audioError && <pre className="error">{audioError}</pre>}

      {historyExpanded &&
        (recentSegments.length === 0 && !historyError ? (
          <p className="empty-state">No stored dictation segments found.</p>
        ) : (
          <div className="history-list">
            {recentSegments.map((segment) => (
              <article className="history-item" key={getSegmentKey(segment, { separator: "::" })}>
                <div className="history-heading">
                  <span title={segment.createdAt ?? undefined}>
                    {formatTimestamp(segment.createdAt, { missingLabel: "unknown time", style: "full" })}
                  </span>
                  <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
                    {segment.sessionId} / {segment.segmentId}
                  </strong>
                </div>

                <p className="history-transcript">{segment.transcript || "-"}</p>

                {segment.normalizedTranscript !== null && segment.normalizedTranscript !== segment.transcript && (
                  <p className="history-normalized-transcript" title="Text inserted after normalization">
                    Inserted: {segment.normalizedTranscript || "-"}
                  </p>
                )}

                <div className="history-footer">
                  <div className="history-meta">
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds, { rejectNonFinite: true })}</span>
                    <span>{formatLatency(segment.transcriptionDurationMs, { rejectNonFinite: true, round: true })}</span>
                  </div>
                  <div className="history-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        !segment.audioRef ||
                        loadingAudioSegmentKey === getSegmentKey(segment, { separator: "::" }) ||
                        status === "recording" ||
                        status === "transcribing"
                      }
                      onClick={() => playHistoryAudio(segment)}
                    >
                      {loadingAudioSegmentKey === getSegmentKey(segment, { separator: "::" })
                        ? "Loading"
                        : playingAudioSegmentKey === getSegmentKey(segment, { separator: "::" })
                          ? "Stop"
                          : "Play"}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!segment.transcript && !segment.normalizedTranscript}
                      onClick={() => copyHistoryTranscript(segment, "inserted")}
                    >
                      Copy
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!segment.transcript}
                      onClick={() => copyHistoryTranscript(segment, "raw")}
                    >
                      Copy raw
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ))}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function formatSttWorkerState(state: SttWorkerState | undefined): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "busy":
      return "Busy";
    case "restarting":
      return "Restarting";
    case "error":
      return "Error";
    case "starting":
    case "stopped":
    default:
      return "Preparing";
  }
}
