import React, { useState } from "react";
import type { CorrectionKind, ReconstructedSegment, SttBenchmarkSetSplit } from "@dictex/shared";
import {
  formatAudioDuration,
  formatBenchmarkSetSplit,
  formatCorrectionKind,
  formatLatency,
  formatTimestamp,
  getSegmentKey,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import type { DataFolderStatus, SourceFolderCheck } from "../api.js";
import type { CorpusCorrectionLayer } from "../corpusCorrection.js";
import { LabNavigation, type View } from "./LabNavigation.js";

/**
 * The correction kind travels WITH the raw transcript it was derived from (see
 * planCorpusCorrection): both are frozen when the human clicks Edit Layer 1 or
 * Edit Layer 2, and nothing between opening and saving can change one without
 * the other.
 */
export type HistoryCorrectionTarget = {
  sessionId: string;
  segmentId: string;
  audioRef: string;
  rawTranscript: string;
  correctionKind: CorrectionKind;
};

type SegmentsViewProps = {
  dataFolder: DataFolderStatus | null;
  sourceCheck: SourceFolderCheck | null;
  dataFolderDraft: string;
  setDataFolderDraft: (value: string) => void;
  isSavingDataFolder: boolean;
  pickDataFolder: () => void;
  applyDataFolderDraft: () => void;
  resetDataFolder: () => void;
  segments: ReconstructedSegment[];
  segmentsError: string;
  isLoadingSegments: boolean;
  loadSegments: () => void;
  audioError: string;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  playSegmentAudio: (segment: ReconstructedSegment) => void;
  benchmarkSetTargetKey: string | null;
  markSttBenchmarkSetMembership: (segment: ReconstructedSegment, split: SttBenchmarkSetSplit) => void;
  startSegmentCorrection: (segment: ReconstructedSegment, layer: CorpusCorrectionLayer) => void;
  isSavingCorrection: boolean;
  historyCorrectionTarget: HistoryCorrectionTarget | null;
  historyCorrectionDraft: string;
  setHistoryCorrectionDraft: (value: string) => void;
  saveSegmentCorrection: () => void;
  cancelSegmentCorrection: () => void;
  correctionNotice: string;
  notice: string;
  openLabDataFolder: () => void;
  openSourceDataFolder: () => void;
  openLabEventsLog: () => void;
  onNavigate: (view: View) => void;
};

export function SegmentsView({
  dataFolder,
  sourceCheck,
  dataFolderDraft,
  setDataFolderDraft,
  isSavingDataFolder,
  pickDataFolder,
  applyDataFolderDraft,
  resetDataFolder,
  segments,
  segmentsError,
  isLoadingSegments,
  loadSegments,
  audioError,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  playSegmentAudio,
  benchmarkSetTargetKey,
  markSttBenchmarkSetMembership,
  startSegmentCorrection,
  isSavingCorrection,
  historyCorrectionTarget,
  historyCorrectionDraft,
  setHistoryCorrectionDraft,
  saveSegmentCorrection,
  cancelSegmentCorrection,
  correctionNotice,
  notice,
  openLabDataFolder,
  openSourceDataFolder,
  openLabEventsLog,
  onNavigate,
}: SegmentsViewProps): React.ReactElement {
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  const selectedSegment =
    segments.find((segment) => getSegmentKey(segment) === selectedSegmentKey) ?? segments[0] ?? null;
  const acousticCorrection = selectedSegment?.correctionsByKind.find(
    (correction) => correction.correctionKind === "acoustic",
  );
  const mathTransformCorrection = selectedSegment?.correctionsByKind.find(
    (correction) => correction.correctionKind === "math_transform",
  );
  const qualificationState =
    acousticCorrection && mathTransformCorrection
      ? "Layers 1 and 2 qualified"
      : acousticCorrection
        ? "Layer 1 only"
        : "No human layers";

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Corpus</h1>
        </div>
        <div className={`status-pill ${sourceCheck?.eventsFound ? "status-copied" : "status-error"}`}>
          {sourceCheck === null ? "checking" : sourceCheck.eventsFound ? "data folder ok" : "no events found"}
        </div>
      </header>

      <LabNavigation activeView="corpus" onNavigate={onNavigate} />

      <section className="panel controls-panel">
        <h2>DicTeX data folder (read-only source)</h2>
        <p className="benchmark-models" title={dataFolder?.path ?? undefined}>
          {dataFolder ? dataFolder.path : "loading…"}
          {dataFolder?.isDefault ? " (default)" : ""}
        </p>
        {sourceCheck && !sourceCheck.exists && (
          <p className="error">The configured folder does not exist. Pick DicTeX's data folder.</p>
        )}
        {sourceCheck && sourceCheck.exists && !sourceCheck.eventsFound && (
          <p className="notice">Folder found, but no events.jsonl yet. Record a dictation in DicTeX first.</p>
        )}
        <div className="actions">
          <button className="secondary-button" disabled={isSavingDataFolder} onClick={pickDataFolder}>
            Choose folder…
          </button>
          <input
            aria-label="DicTeX data folder path"
            className="reason-input"
            placeholder="…or paste an absolute path"
            value={dataFolderDraft}
            onChange={(event) => setDataFolderDraft(event.target.value)}
          />
          <button
            className="secondary-button"
            disabled={isSavingDataFolder || dataFolderDraft.trim() === ""}
            onClick={applyDataFolderDraft}
          >
            Apply
          </button>
          <button
            className="secondary-button"
            disabled={isSavingDataFolder || dataFolder?.isDefault === true}
            onClick={resetDataFolder}
          >
            Reset to default
          </button>
          <button className="secondary-button" onClick={openSourceDataFolder}>
            Open source folder
          </button>
        </div>
        {notice && <p className="notice">{notice}</p>}
      </section>

      <section className="panel corpus-master-detail" aria-busy={isLoadingSegments}>
        <div className="corpus-segment-list">
        <div className="panel-header">
          <div>
            <h2>DicTeX segments</h2>
            <p>{segments.length > 0 ? `${segments.length} segments` : "Read from the DicTeX data folder"}</p>
          </div>
          <button className="secondary-button" disabled={isLoadingSegments} onClick={loadSegments}>
            {isLoadingSegments ? "Loading" : "Refresh"}
          </button>
        </div>

        {segmentsError && <pre className="error">{segmentsError}</pre>}
        {audioError && <pre className="error">{audioError}</pre>}

        {segments.length === 0 && !segmentsError ? (
          <p className="empty-state">
            No stored dictation segments found in the DicTeX data folder. Record a dictation in DicTeX, then click
            Refresh above.
          </p>
        ) : (
          <div className="history-list">
            {segments.map((segment) => (
              <article
                className={`history-item corpus-segment-item ${getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment) ? "corpus-segment-item-selected" : ""}`}
                key={getSegmentKey(segment)}
              >
                <div className="history-heading">
                  <span title={segment.createdAt ?? undefined}>{formatTimestamp(segment.createdAt)}</span>
                  <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
                    {segment.sessionId} / {segment.segmentId}
                  </strong>
                  <em className={segment.correctedTranscript ? "correction-state correction-state-done" : "correction-state"}>
                    {segment.correctedTranscript ? "corrected" : "raw"}
                  </em>
                </div>

                {segment.correctedTranscript ? (
                  <div className="history-transcripts">
                    <p className="history-transcript history-transcript-corrected">{segment.correctedTranscript}</p>
                    <p className="history-raw-transcript">Raw: {segment.transcript || "-"}</p>
                  </div>
                ) : (
                  <p className="history-transcript">{segment.transcript || "-"}</p>
                )}

                <div className="history-footer">
                  <div className="history-meta">
                    <span>{segment.sttModel}</span>
                    <span>{segment.sttLanguage}</span>
                    <span>{formatAudioDuration(segment.audioDurationSeconds)}</span>
                    <span>{formatLatency(segment.transcriptionDurationMs)}</span>
                    {segment.correctionKind && (
                      <span className="correction-kind-state" title={`Correction kind: ${formatCorrectionKind(segment.correctionKind)}`}>
                        {formatCorrectionKind(segment.correctionKind)}
                      </span>
                    )}
                    {segment.benchmarkSetSplit && (
                      <span className="benchmark-set-state" title={segment.benchmarkSetCreatedAt ?? undefined}>
                        {formatBenchmarkSetSplit(segment.benchmarkSetSplit)}
                      </span>
                    )}
                  </div>
                  <div className="history-actions">
                    <button
                      className="secondary-button"
                      aria-pressed={getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment)}
                      onClick={() => setSelectedSegmentKey(getSegmentKey(segment))}
                    >
                      {getSegmentKey(segment) === getSegmentKey(selectedSegment ?? segment) ? "Selected" : "Select"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        </div>

        <aside className="corpus-detail" aria-live="polite">
          {selectedSegment === null ? (
            <p className="empty-state">Select a DicTeX segment to inspect and qualify it.</p>
          ) : (
            <>
              <div className="panel-header">
                <div>
                  <h2>Selected segment</h2>
                  <p title={`${selectedSegment.sessionId} / ${selectedSegment.segmentId}`}>
                    {selectedSegment.sessionId} / {selectedSegment.segmentId}
                  </p>
                </div>
                <em className={`qualification-state ${acousticCorrection ? "qualification-state-partial" : ""} ${acousticCorrection && mathTransformCorrection ? "qualification-state-complete" : ""}`}>
                  {qualificationState}
                </em>
              </div>

              <dl className="corpus-provenance">
                <div><dt>Recorded</dt><dd>{formatTimestamp(selectedSegment.createdAt)}</dd></div>
                <div><dt>STT</dt><dd>{selectedSegment.sttEngine} / {selectedSegment.sttModel} · {selectedSegment.sttLanguage}</dd></div>
                <div><dt>Audio</dt><dd>{formatAudioDuration(selectedSegment.audioDurationSeconds)}</dd></div>
                <div><dt>Split</dt><dd>{selectedSegment.benchmarkSetSplit ? `${formatBenchmarkSetSplit(selectedSegment.benchmarkSetSplit)}${selectedSegment.benchmarkSetCreatedAt ? ` · ${formatTimestamp(selectedSegment.benchmarkSetCreatedAt)}` : ""}` : "Not assigned"}</dd></div>
              </dl>

              <section className="corpus-layer">
                <h3>Raw STT</h3>
                <p>{selectedSegment.transcript || "-"}</p>
              </section>
              <section className="corpus-layer">
                <h3>Layer 1 — acoustic</h3>
                <p>{acousticCorrection?.correctedTranscript ?? "Not qualified yet"}</p>
              </section>
              <section className="corpus-layer">
                <h3>Layer 2 — math transform</h3>
                <p>{mathTransformCorrection?.correctedTranscript ?? "Not qualified yet"}</p>
              </section>

              <div className="actions">
                <button
                  className="secondary-button"
                  disabled={!selectedSegment.audioRef || loadingAudioSegmentKey === getSegmentKey(selectedSegment)}
                  onClick={() => playSegmentAudio(selectedSegment)}
                >
                  {loadingAudioSegmentKey === getSegmentKey(selectedSegment)
                    ? "Loading"
                    : playingAudioSegmentKey === getSegmentKey(selectedSegment)
                      ? "Stop"
                      : "Play audio"}
                </button>
                <select
                  aria-label={`Benchmark set split for selected ${selectedSegment.sessionId} / ${selectedSegment.segmentId}`}
                  className="secondary-select"
                  disabled={!selectedSegment.correctedTranscript || benchmarkSetTargetKey === getSegmentKey(selectedSegment)}
                  value={selectedSegment.benchmarkSetSplit ?? ""}
                  onChange={(event) => {
                    const split = event.currentTarget.value;
                    if (isSttBenchmarkSetSplit(split)) {
                      markSttBenchmarkSetMembership(selectedSegment, split);
                    }
                  }}
                >
                  <option value="">Set split</option>
                  <option value="train_candidate_pool">Train pool</option>
                  <option value="validation">Validation</option>
                  <option value="test_frozen">Test frozen</option>
                </select>
                <button className="secondary-button" disabled={isSavingCorrection} onClick={() => startSegmentCorrection(selectedSegment, "layer1")}>
                  Edit Layer 1
                </button>
                <button
                  className="secondary-button"
                  disabled={isSavingCorrection || !acousticCorrection}
                  title={acousticCorrection ? undefined : "Save Layer 1 before adding Layer 2"}
                  onClick={() => startSegmentCorrection(selectedSegment, "layer2")}
                >
                  Edit Layer 2
                </button>
              </div>

              {historyCorrectionTarget && getSegmentKey(historyCorrectionTarget) === getSegmentKey(selectedSegment) && (
                <div className="corpus-correction-editor">
                  <p className="transcript-label">
                    {historyCorrectionTarget.correctionKind === "acoustic" ? "Layer 1" : "Layer 2"} —{" "}
                    {formatCorrectionKind(historyCorrectionTarget.correctionKind)}
                  </p>
                  <p className="corpus-correction-input" title={historyCorrectionTarget.rawTranscript}>
                    From: {historyCorrectionTarget.rawTranscript || "-"}
                  </p>
                  <textarea
                    value={historyCorrectionDraft}
                    onChange={(event) => setHistoryCorrectionDraft(event.target.value)}
                    aria-label={`Corrected transcript (${formatCorrectionKind(historyCorrectionTarget.correctionKind)})`}
                  />
                  <div className="actions">
                    <button
                      className="secondary-button"
                      disabled={isSavingCorrection || historyCorrectionDraft.length === 0}
                      onClick={saveSegmentCorrection}
                    >
                      {isSavingCorrection ? "Saving" : "Save correction"}
                    </button>
                    <button className="secondary-button" disabled={isSavingCorrection} onClick={cancelSegmentCorrection}>Cancel</button>
                  </div>
                  {correctionNotice && <p className="notice">{correctionNotice}</p>}
                </div>
              )}
            </>
          )}
        </aside>
      </section>

      <section className="panel transcript-panel">
        <div className="actions">
          <button className="secondary-button" onClick={openLabDataFolder}>
            Open Lab data folder
          </button>
          <button className="secondary-button" onClick={openLabEventsLog}>
            Open Lab events log
          </button>
        </div>
        <p className="empty-state">
          The Lab reads DicTeX's folder read-only and writes corrections, splits, benchmark results, selections, and
          exports only into its own store.
        </p>
      </section>
    </>
  );
}
