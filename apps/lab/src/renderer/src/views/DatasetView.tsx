import React, { useMemo } from "react";
import type { ReconstructedSegment, SttBenchmarkSetSplit, SttDatasetExportSummary } from "@dictex/shared";
import {
  formatBenchmarkSetSplit,
  formatCandidateIdentity,
  formatDatasetCorrectionKind,
  getSegmentKey,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import { diffWords, type DiffSegment } from "@dictex/shared/textDiff";

type DatasetViewProps = {
  embedded?: boolean;
  segments: ReconstructedSegment[];
  loadSegments: () => void;
  isLoadingSegments: boolean;
  playSegmentAudio: (segment: ReconstructedSegment) => void;
  loadingAudioSegmentKey: string;
  playingAudioSegmentKey: string;
  audioError: string;
  builderMode: "paste" | "segment";
  setBuilderMode: (mode: "paste" | "segment") => void;
  builderSegmentKey: string;
  setBuilderSegmentKey: (key: string) => void;
  builderRawTranscript: string;
  setBuilderRawTranscript: (value: string) => void;
  builderLiteral: string;
  setBuilderLiteral: (value: string) => void;
  builderNotation: string;
  setBuilderNotation: (value: string) => void;
  /** Latest pipeline output over Layer 1 (command words spelled out, never a
   * sentinel), used to render the "what the pipeline changed" diff (#101). */
  builderNotationPrefill: string;
  isPrefillingLayer2: boolean;
  builderPrefillError: string;
  builderSplit: SttBenchmarkSetSplit;
  setBuilderSplit: (split: SttBenchmarkSetSplit) => void;
  isSavingBuilderEntry: boolean;
  builderNotice: string;
  builderError: string;
  saveDatasetBuilderEntry: () => void;
  exportSttDataset: () => void;
  openExportFolder: () => void;
  isExportingDataset: boolean;
  datasetExportSummary: SttDatasetExportSummary | null;
  datasetExportError: string;
};

export function DatasetView({
  embedded = false,
  segments,
  loadSegments,
  isLoadingSegments,
  playSegmentAudio,
  loadingAudioSegmentKey,
  playingAudioSegmentKey,
  audioError,
  builderMode,
  setBuilderMode,
  builderSegmentKey,
  setBuilderSegmentKey,
  builderRawTranscript,
  setBuilderRawTranscript,
  builderLiteral,
  setBuilderLiteral,
  builderNotation,
  setBuilderNotation,
  builderNotationPrefill,
  isPrefillingLayer2,
  builderPrefillError,
  builderSplit,
  setBuilderSplit,
  isSavingBuilderEntry,
  builderNotice,
  builderError,
  saveDatasetBuilderEntry,
  exportSttDataset,
  openExportFolder,
  isExportingDataset,
  datasetExportSummary,
  datasetExportError,
}: DatasetViewProps): React.ReactElement {
  const summary = datasetExportSummary;
  const selectedBuilderSegment = segments.find((segment) => getSegmentKey(segment) === builderSegmentKey) ?? null;

  // Mirrors planDatasetBuilderSave's own rule (apps/lab/src/main/datasetBuilder.ts):
  // a "paste" source has no audio and can therefore NEVER save an acoustic
  // pair — only a picked segment's raw transcript can. Kept in sync with the
  // identical computation in saveDatasetBuilderEntry (App) so the disabled
  // state and the inline hint below never contradict the real save.
  const trimmedLiteral = builderLiteral.trim();

  // Diff between Layer 1 and the pipeline's prefill (#101): recomputed from
  // the two final, sentinel-free strings, so it never shows a sentinel or a
  // command effect — only the words a human would see. Shown regardless of
  // whether the human has since edited Layer 2, since its purpose is to
  // surface what the PIPELINE changed, not to track the human's own edits.
  const prefillDiff: DiffSegment[] = useMemo(
    () => (trimmedLiteral.length > 0 && builderNotationPrefill.length > 0 ? diffWords(trimmedLiteral, builderNotationPrefill) : []),
    [trimmedLiteral, builderNotationPrefill],
  );
  const prefillChanged = prefillDiff.some((segment) => segment.kind !== "equal");

  const effectiveRawTranscript =
    builderMode === "segment" ? (selectedBuilderSegment?.transcript.trim() ?? "") : builderRawTranscript.trim();
  const willSaveAcoustic = builderMode === "segment" && effectiveRawTranscript.length > 0;
  const willSaveMathTransform = builderNotation.trim().length > 0;
  const hasBuilderSource = builderMode !== "segment" || selectedBuilderSegment !== null;
  const canSaveBuilderEntry =
    !isSavingBuilderEntry && trimmedLiteral.length > 0 && hasBuilderSource && (willSaveAcoustic || willSaveMathTransform);

  // Live "what will this save" preview, using the exact same wording
  // planDatasetBuilderSave throws for its "nothing to save" case, so the
  // inline guidance and the real validation error never disagree.
  let builderPlanHint: string;
  if (trimmedLiteral.length === 0) {
    builderPlanHint = "Layer 1 (literal transcript) is required before anything can be saved.";
  } else if (!hasBuilderSource) {
    builderPlanHint = "Pick a DicTeX segment first.";
  } else if (!willSaveAcoustic && !willSaveMathTransform) {
    builderPlanHint =
      builderMode === "segment"
        ? "Nothing to save: the picked segment has no raw transcript for the acoustic layer, and Layer 2 (notation) is empty."
        : "Nothing to save: a pasted (no-audio) entry needs Layer 2 (notation) to build a math_transform pair. Pick a recorded segment if you want an acoustic (audio -> literal) pair.";
  } else {
    const planParts = [
      willSaveAcoustic ? formatDatasetCorrectionKind("acoustic") : null,
      willSaveMathTransform ? formatDatasetCorrectionKind("math_transform") : null,
    ].filter((part): part is string => part !== null);
    builderPlanHint = `Will save ${planParts.join(" + ")} -> ${formatBenchmarkSetSplit(builderSplit)} on Save entry.`;
  }

  return (
    <>
      {!embedded && <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Corpus</h1>
        </div>
      </header>}

      <details className="panel manual-entry" aria-busy={isSavingBuilderEntry}>
        <summary>New manual entry</summary>
        <div className="manual-entry-content">
        <div className="panel-header">
          <div>
            <h2>New manual entry</h2>
            <p>No microphone: paste a transcription or pick a DicTeX segment, then type the two layers by hand</p>
          </div>
        </div>

        <div className="actions" role="group" aria-label="Transcription source">
          <label className="candidate-checkbox">
            <input
              type="radio"
              name="builder-source"
              checked={builderMode === "paste"}
              onChange={() => setBuilderMode("paste")}
            />
            Paste a transcription (no audio)
          </label>
          <label className="candidate-checkbox">
            <input
              type="radio"
              name="builder-source"
              checked={builderMode === "segment"}
              onChange={() => setBuilderMode("segment")}
            />
            Pick a DicTeX segment (has audio)
          </label>
        </div>
        <p className="builder-hint">
          {builderMode === "paste"
            ? 'No audio: this source can only ever save a math_transform entry (Layer 1 -> Layer 2). Switch to "Pick a DicTeX segment" for an acoustic entry.'
            : "Real recorded audio: Layer 1 alone saves an acoustic entry (audio -> literal); adding Layer 2 also saves a math_transform entry."}
        </p>

        {builderMode === "paste" ? (
          <>
            <p className="transcript-label">Pasted transcription (raw STT, optional — never used for acoustic)</p>
            <textarea
              aria-label="Pasted transcription"
              placeholder="Paste DicTeX's raw transcript here for reference, or leave empty for a notation-only entry"
              value={builderRawTranscript}
              onChange={(event) => setBuilderRawTranscript(event.target.value)}
            />
          </>
        ) : (
          <>
            <div className="segment-picker-controls">
              <div>
                <select
                  aria-label="DicTeX segment"
                  className="secondary-select"
                  value={builderSegmentKey}
                  onChange={(event) => setBuilderSegmentKey(event.target.value)}
                >
                  <option value="">Choose a segment…</option>
                  {segments.map((segment) => (
                    <option key={getSegmentKey(segment)} value={getSegmentKey(segment)}>
                      {segment.sessionId} / {segment.segmentId} — {segment.transcript.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <button className="secondary-button" disabled={isLoadingSegments} onClick={loadSegments}>
                {isLoadingSegments ? "Loading" : "Refresh"}
              </button>
            </div>
            {segments.length === 0 && (
              <p className="empty-state">
                No DicTeX segments found yet. Record a dictation in DicTeX, then click Refresh.
              </p>
            )}
            {selectedBuilderSegment && (
              <>
                <p className="correction-raw">Raw: {selectedBuilderSegment.transcript || "-"}</p>
                <div className="segment-audio-controls">
                  <button
                    className="secondary-button"
                    disabled={!selectedBuilderSegment.audioRef || loadingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)}
                    onClick={() => playSegmentAudio(selectedBuilderSegment)}
                  >
                    {loadingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)
                      ? "Loading"
                      : playingAudioSegmentKey === getSegmentKey(selectedBuilderSegment)
                        ? "Stop"
                        : "Play"}
                  </button>
                </div>
              </>
            )}
            {audioError && <pre className="error">{audioError}</pre>}
          </>
        )}

        <p className="transcript-label">Layer 1 — literal-correct transcript (verbal)</p>
        <p className="builder-hint">Required to save anything; also the input to Layer 2.</p>
        <textarea
          aria-label="Layer 1: literal transcript"
          placeholder="e.g. x au carré plus deux"
          value={builderLiteral}
          onChange={(event) => setBuilderLiteral(event.target.value)}
        />

        <p className="transcript-label">Layer 2 — normalized notation (LaTeX/KaTeX-compatible)</p>
        <p className="builder-hint">
          Requires Layer 1. Builds the math_transform pair (literal -&gt; notation) — the only pair a paste source can
          ever produce.
        </p>
        <textarea
          aria-label="Layer 2: normalized notation"
          placeholder="e.g. x^2 + 2"
          disabled={builderLiteral.trim().length === 0}
          value={builderNotation}
          onChange={(event) => setBuilderNotation(event.target.value)}
        />

        {trimmedLiteral.length > 0 &&
          (isPrefillingLayer2 && builderNotationPrefill.length === 0 ? (
            <p className="builder-hint">Prefilling Layer 2 from the pipeline…</p>
          ) : builderPrefillError ? (
            <p className="builder-hint">Prefill unavailable ({builderPrefillError}); type Layer 2 by hand.</p>
          ) : builderNotationPrefill.length > 0 ? (
            <>
              <p className="transcript-label">
                Pipeline prefill vs Layer 1 (dictionary + regex, command words spelled out — a starting point, always
                editable)
              </p>
              <p className="prefill-diff" aria-label="What the pipeline changed">
                {prefillChanged
                  ? prefillDiff.map((segment, index) =>
                      segment.kind === "equal" ? (
                        <React.Fragment key={index}>{segment.text}</React.Fragment>
                      ) : (
                        <mark
                          key={index}
                          className={segment.kind === "added" ? "prefill-diff-added" : "prefill-diff-removed"}
                        >
                          {segment.text}
                        </mark>
                      ),
                    )
                  : "No change from Layer 1 — dictionary and regex left it as-is."}
              </p>
            </>
          ) : null)}

        <div className="actions">
          <select
            aria-label="Benchmark set split for this entry"
            className="secondary-select"
            value={builderSplit}
            onChange={(event) => {
              const split = event.currentTarget.value;
              if (isSttBenchmarkSetSplit(split)) {
                setBuilderSplit(split);
              }
            }}
          >
            <option value="train_candidate_pool">Train pool</option>
            <option value="validation">Validation</option>
            <option value="test_frozen">Test frozen</option>
          </select>
          <button className="secondary-button" disabled={!canSaveBuilderEntry} onClick={saveDatasetBuilderEntry}>
            {isSavingBuilderEntry ? "Saving" : "Save entry"}
          </button>
        </div>

        {builderError && <pre className="error">{builderError}</pre>}
        {builderNotice && <p className="notice">{builderNotice}</p>}
        {!builderError && !builderNotice && <p className="builder-hint">{builderPlanHint}</p>}
        </div>
      </details>

      <section className="panel" aria-busy={isExportingDataset}>
        <div className="panel-header">
          <div>
            <h2>Export corrected STT dataset</h2>
            <p>
              Writes test_frozen-compatible JSONL into the Lab's own store, split by train pool / validation / test frozen
              and by correction kind. Reads events only — DicTeX's data folder is never rewritten, nothing is uploaded.
            </p>
          </div>
          <button className="secondary-button" disabled={isExportingDataset} onClick={exportSttDataset}>
            {isExportingDataset ? "Exporting" : "Export dataset"}
          </button>
        </div>

        {datasetExportError && <pre className="error">{datasetExportError}</pre>}

        {summary && (
          <div className="dataset-export-summary">
            {summary.exportDir === null ? (
              <p className="empty-state">
                No corrected segments in any benchmark split yet. Correct segments and add them to a split first.
              </p>
            ) : (
              <>
                <p className="dataset-export-path" title={summary.exportDir}>
                  {summary.exportDir}
                </p>
                <div className="benchmark-meta">
                  <span>{summary.totalRecords} records</span>
                  <span>
                    Base: {summary.selectedCandidate ? formatCandidateIdentity(summary.selectedCandidate) : "none selected"}
                  </span>
                  {summary.skippedUntypedCorrections > 0 && (
                    <span title="Legacy corrections without a correction kind cannot be routed into the dataset">
                      {summary.skippedUntypedCorrections} untyped skipped
                    </span>
                  )}
                </div>

                {summary.splits.length === 0 ? (
                  <p className="empty-state">No records were written.</p>
                ) : (
                  <ul className="dataset-export-splits">
                    {summary.splits.map((splitSummary) => (
                      <li key={splitSummary.split}>
                        <strong>{formatBenchmarkSetSplit(splitSummary.split)}</strong>{" "}
                        <span>
                          {splitSummary.recordCount} records · {splitSummary.correctedSegmentCount}/
                          {splitSummary.segmentCount} corrected segments
                        </span>
                        <ul>
                          {splitSummary.files.map((file) => (
                            <li key={file.file} title={file.file}>
                              {formatDatasetCorrectionKind(file.correctionKind)}: {file.recordCount} · {file.file}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}

                <button className="secondary-button" onClick={openExportFolder}>
                  Open export folder
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
