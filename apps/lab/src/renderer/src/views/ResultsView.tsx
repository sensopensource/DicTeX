import React from "react";
import type {
  BenchmarkCandidateIdentity,
  BenchmarkMathTransformRunProjection,
  BenchmarkRunListEntry,
  NormalizerBenchmarkRunExportSummary,
  SttBenchmarkRunExportSummary,
  SttBenchmarkSetSplit,
  SttCandidateSelectionResponse,
} from "@dictex/shared";
import {
  formatBenchmarkRunOption,
  formatBenchmarkSetSplit,
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  formatLatency,
  formatRatePercent,
  formatTimestamp,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import {
  ERROR_CATEGORY_LABELS,
  type CandidateErrorAnalysis,
  type SttErrorCategory,
} from "@dictex/shared/errorAnalysis";
import { diffWords } from "@dictex/shared/textDiff";
import {
  NORMALIZER_BENCHMARK_DISPLAY_NAME,
  parseNormalizerBenchmarkVariant,
  summarizeNormalizerBenchmarkRun,
} from "@dictex/shared/normalizerBenchmark";
import { LEGACY_RUN_KEY, type ResultsState } from "../resultsSelection.js";
import { CandidateSummaryTable } from "./CandidateSummaryTable.js";
import { LabNavigation, type View } from "./LabNavigation.js";
import { RunSegmentOutputs } from "./RunSegmentOutputs.js";

/** An LLM export summary, whichever stage's run produced it. */
export type BenchmarkRunExportSummary = SttBenchmarkRunExportSummary | NormalizerBenchmarkRunExportSummary;

function NormalizerRunResults({
  detail,
  runExportSummary,
  runExportError,
  isExportingRun,
  exportSelectedRun,
  openRunExportFolder,
}: {
  detail: BenchmarkMathTransformRunProjection;
  runExportSummary: BenchmarkRunExportSummary | null;
  runExportError: string;
  isExportingRun: boolean;
  exportSelectedRun: () => void;
  openRunExportFolder: () => void;
}): React.ReactElement {
  const summaries = summarizeNormalizerBenchmarkRun(detail);
  const version = parseNormalizerBenchmarkVariant(detail.candidates[0]?.variant ?? null);

  return (
    <>
      <section className="panel run-panel">
        <div className="panel-header">
          <div>
            <h2>Run {formatTimestamp(detail.createdAt)}</h2>
            <p className="benchmark-models" title={detail.runId ?? undefined}>{detail.runId}</p>
          </div>
          <em className={`run-status ${detail.terminal ? (detail.outcomeCounts.failed > 0 ? "run-status-failed" : "run-status-done") : "run-status-unfinished"}`}>
            {detail.terminal
              ? `${detail.outcomeCounts.done} done · ${detail.outcomeCounts.failed} failed · ${detail.outcomeCounts.missing} missing`
              : "unfinished"}
          </em>
        </div>

        <dl className="run-provenance">
          <div>
            <dt>Stage</dt>
            <dd>Normalizer · math_transform</dd>
          </div>
          <div>
            <dt>Transform</dt>
            <dd>Layer 1 -&gt; Normalizer -&gt; Layer 2</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{formatBenchmarkSetSplit(detail.split)}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>{detail.members.length} frozen pair{detail.members.length === 1 ? "" : "s"}</dd>
          </div>
        </dl>

        <section className="run-candidates">
          <h3>Candidate launched</h3>
          <div className="normalizer-candidate-card">
            <strong>{NORMALIZER_BENCHMARK_DISPLAY_NAME}</strong>
            <code>{detail.candidates[0] ? formatCandidateIdentity(detail.candidates[0]) : "-"}</code>
            {version && (
              <dl className="normalizer-version">
                <div>
                  <dt>Dictionary SHA-256</dt>
                  <dd><code>{version.dictionaryHash}</code></dd>
                </div>
                <div>
                  <dt>Effective rules SHA-256</dt>
                  <dd><code>{version.rulesHash}</code></dd>
                </div>
                {version.rulesMode && (
                  <div>
                    <dt>Rules source</dt>
                    <dd>{version.rulesMode === "legacy" ? "Legacy local file" : version.rulesMode === "overlay" ? "Current personal overlay" : "Bundled"}</dd>
                  </div>
                )}
                {version.bundledRulesVersion !== undefined && (
                  <div>
                    <dt>Bundled rules</dt>
                    <dd>v{version.bundledRulesVersion} · <code>{version.bundledRulesHash}</code></dd>
                  </div>
                )}
                {version.localRulesHash && (
                  <div>
                    <dt>Local rules SHA-256</dt>
                    <dd><code>{version.localRulesHash}</code></dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </section>

        <p className="batch-outcome-meta">
          {detail.pipelineSnapshot
            ? `The LLM export includes this run's personal dictionary (${detail.pipelineSnapshot.dictionary.source_content !== null || detail.pipelineSnapshot.dictionary.effective_entries.length ? "source included" : "default empty"}). DicTeX does not upload it.`
            : "This historical run has no complete pipeline provenance. Export will be refused; run the Normalizer benchmark again."}
        </p>
        <div className="actions">
          <button
            className="secondary-button"
            disabled={!detail.terminal || isExportingRun}
            title={detail.terminal ? undefined : "Only a finished run can be exported"}
            onClick={exportSelectedRun}
          >
            {isExportingRun ? "Exporting" : "Export for LLM"}
          </button>
        </div>

        {runExportError && <pre className="error">{runExportError}</pre>}

        {runExportSummary && "containsPersonalDictionary" in runExportSummary && (
          <div className="dataset-export-summary">
            <p>
              Exported {runExportSummary.segmentCount} math transform segment
              {runExportSummary.segmentCount === 1 ? "" : "s"} and {runExportSummary.candidateCount} candidate
              {runExportSummary.candidateCount === 1 ? "" : "s"}. Done: {runExportSummary.done}; failed:{" "}
              {runExportSummary.failed}; missing: {runExportSummary.missingOutputs}.
            </p>
            <p>
              Personal dictionary: {runExportSummary.containsPersonalDictionary ? "included — review before sharing" : "empty"}.
            </p>
            <p className="dataset-export-path" title={runExportSummary.exportDir}>{runExportSummary.exportDir}</p>
            <button className="secondary-button" onClick={openRunExportFolder}>Open export folder</button>
          </div>
        )}
      </section>

      <section className="panel summary-panel">
        <div className="panel-header">
          <div>
            <h2>Exact match summary</h2>
            <p>Output and Layer 2 target are canonicalized with the shared LaTeX convention before comparison.</p>
          </div>
        </div>
        <div className="summary-table-scroll">
          <table className="summary-table">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Exact matches</th>
                <th>Exact match</th>
                <th>Done</th>
                <th>Failed</th>
                <th>Missing</th>
                <th>Mean latency</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={formatCandidateIdentityKey(summary.candidate)}>
                  <td>{NORMALIZER_BENCHMARK_DISPLAY_NAME}</td>
                  <td>{summary.exactMatches} / {summary.total}</td>
                  <td>{formatRatePercent(summary.total === 0 ? null : summary.exactMatches / summary.total)}</td>
                  <td>{summary.done}</td>
                  <td>{summary.failed}</td>
                  <td>{summary.missing}</td>
                  <td>{formatLatency(summary.meanTransformationDurationMs === null ? null : Math.round(summary.meanTransformationDurationMs))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel benchmark-panel">
        <div className="panel-header">
          <div>
            <h2>Layer 1 -&gt; Normalizer -&gt; Layer 2</h2>
            <p>Frozen inputs and targets, canonical exact match, text diff and deterministic layer traces</p>
          </div>
        </div>
        <div className="batch-outcomes">
          {detail.members.map((member) => {
            const outcome = member.outcomes[0];
            const result = outcome?.result;
            const score = result?.score;
            const diff = score ? diffWords(score.canonicalOutput, score.canonicalTarget) : [];
            const failed = outcome?.status === "failed";
            return (
              <article
                className={failed ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
                key={`${member.sessionId}/${member.segmentId}`}
              >
                <div className="batch-outcome-heading">
                  <strong title={`${member.sessionId} / ${member.segmentId}`}>
                    {member.sessionId} / {member.segmentId}
                  </strong>
                  <em className={`batch-outcome-state ${failed ? "batch-outcome-state-failed" : outcome?.status === "missing" ? "batch-outcome-state-missing" : ""}`}>
                    {score ? (score.value ? "exact" : "different") : outcome?.status ?? "missing"}
                  </em>
                </div>
                <p className="run-reference"><strong>Layer 1:</strong> {member.layer1Input}</p>
                <p className="run-reference"><strong>Layer 2 target:</strong> {member.layer2Target}</p>
                <p className="batch-outcome-meta">
                  Correction frozen {member.mathTransformCorrectionCreatedAt
                    ? formatTimestamp(member.mathTransformCorrectionCreatedAt)
                    : "without a date"}
                </p>
                {outcome?.error && <p className="batch-outcome-error">{outcome.error}</p>}
                {result && score && (
                  <>
                    <p className="run-output-transcript"><strong>Output:</strong> {result.outputTranscript}</p>
                    <p className="batch-outcome-meta">Canonical output vs target · {formatLatency(result.transformationDurationMs)}</p>
                    <p className="prefill-diff normalizer-output-diff" aria-label="Canonical output compared with Layer 2 target">
                      {diff.map((segment, index) =>
                        segment.kind === "equal" ? (
                          <React.Fragment key={index}>{segment.text}</React.Fragment>
                        ) : (
                          <mark
                            className={segment.kind === "added" ? "prefill-diff-added" : "prefill-diff-removed"}
                            key={index}
                          >
                            {segment.text}
                          </mark>
                        ),
                      )}
                    </p>
                    <details className="normalizer-layer-traces">
                      <summary>Layer traces ({result.layers.length})</summary>
                      <ol>
                        {result.layers.map((layer, index) => (
                          <li key={`${layer.layer}/${index}`}>
                            <strong>{layer.layer}</strong> · {layer.applied ? "changed" : "unchanged"}
                            <span>{layer.input}</span>
                            <span>{layer.output}</span>
                            {(layer.diagnostics ?? []).length > 0 && <small>{(layer.diagnostics ?? []).join("; ")}</small>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

type ResultsViewProps = {
  split: SttBenchmarkSetSplit;
  setSplit: (split: SttBenchmarkSetSplit) => void;
  runList: BenchmarkRunListEntry[];
  results: ResultsState;
  selectResult: (key: string) => void;
  errorAnalysis: CandidateErrorAnalysis[];
  runExportSummary: BenchmarkRunExportSummary | null;
  runExportError: string;
  isExportingRun: boolean;
  exportSelectedRun: () => void;
  openRunExportFolder: () => void;
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
  onNavigate: (view: View) => void;
};

/**
 * The result side (issue #138): pick a run, read the run. Its status, its frozen
 * snapshot, the candidates it launched, their outputs, its errors, its summary
 * and its LLM export — all read from that one run's own events. There is no
 * launch control here: an experiment is announced and started in Experiments, so
 * a run can never be re-run from the page that displays it.
 */
export function ResultsView({
  split,
  setSplit,
  runList,
  results,
  selectResult,
  errorAnalysis,
  runExportSummary,
  runExportError,
  isExportingRun,
  exportSelectedRun,
  openRunExportFolder,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
  onNavigate,
}: ResultsViewProps): React.ReactElement {
  const detail = results.detail;
  const legacySummary = results.legacySummary;

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Results</h1>
        </div>
      </header>

      <LabNavigation activeView="results" onNavigate={onNavigate} />

      <section className="panel results-panel" aria-busy={results.isLoading}>
        <div className="panel-header">
          <div>
            <h2>Benchmark runs</h2>
            <p>
              Every tracked STT or Normalizer run over {formatBenchmarkSetSplit(split)}. A run keeps the snapshot it measured — reopening one
              shows exactly what it saw.
            </p>
          </div>
          <div className="batch-controls">
            <select
              aria-label="Split to browse"
              className="secondary-select"
              disabled={results.isLoading}
              value={split}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isSttBenchmarkSetSplit(value)) {
                  setSplit(value);
                }
              }}
            >
              <option value="validation">Validation</option>
              <option value="test_frozen">Test frozen</option>
            </select>
            <select
              aria-label="Benchmark run to read"
              className="secondary-select"
              disabled={results.isLoading}
              value={results.selectedKey ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value) {
                  selectResult(value);
                }
              }}
            >
              <option value="" disabled>
                {runList.length > 0 ? "Select a run…" : "No tracked run yet"}
              </option>
              {runList.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {formatBenchmarkRunOption(run)}
                </option>
              ))}
              <option value={LEGACY_RUN_KEY}>Legacy (pre-run results)</option>
            </select>
          </div>
        </div>

        {results.error && <pre className="error">{results.error}</pre>}
        {results.isLoading && <p className="empty-state">Reading the run…</p>}
        {!results.isLoading && results.selectedKey === null && (
          <p className="empty-state">
            {runList.length > 0
              ? "Pick a run to read its snapshot, its candidates and their outputs."
              : `No tracked run over ${formatBenchmarkSetSplit(split)} yet — announce and launch one in Experiments.`}
          </p>
        )}
      </section>

      {detail?.stage === "stt" && (
        <>
          <section className="panel run-panel">
            <div className="panel-header">
              <div>
                <h2>Run {formatTimestamp(detail.createdAt)}</h2>
                <p className="benchmark-models" title={detail.runId}>
                  {detail.runId}
                </p>
              </div>
              <em
                className={`run-status ${
                  detail.finished
                    ? (detail.failed ?? 0) > 0
                      ? "run-status-failed"
                      : "run-status-done"
                    : "run-status-unfinished"
                }`}
              >
                {detail.finished ? `${detail.done ?? 0} done · ${detail.failed ?? 0} failed` : "unfinished"}
              </em>
            </div>

            <dl className="run-provenance">
              <div>
                <dt>Stage</dt>
                <dd>
                  {detail.stage} · {detail.datasetKind}
                </dd>
              </div>
              <div>
                <dt>Dataset</dt>
                <dd>{formatBenchmarkSetSplit(detail.split)}</dd>
              </div>
              <div>
                <dt>Snapshot</dt>
                <dd>
                  {detail.segments.length} member{detail.segments.length === 1 ? "" : "s"}, frozen at launch
                </dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>{detail.finishedAt ? formatTimestamp(detail.finishedAt) : "-"}</dd>
              </div>
            </dl>

            <section className="run-candidates">
              <h3>Candidates launched</h3>
              <ul className="protocol-candidates">
                {detail.candidates.map((candidate) => (
                  <li className="protocol-candidate" key={formatCandidateIdentityKey(candidate)}>
                    <strong>{candidate.model}</strong>
                    <span className="protocol-candidate-meta">{candidate.promptVariant ?? "baseline — no prompt"}</span>
                    <code className="protocol-candidate-identity">{formatCandidateIdentity(candidate)}</code>
                  </li>
                ))}
              </ul>
            </section>

            <div className="actions">
              <button
                className="secondary-button"
                disabled={!detail.finished || isExportingRun}
                title={detail.finished ? undefined : "Only a finished run can be exported"}
                onClick={exportSelectedRun}
              >
                {isExportingRun ? "Exporting" : "Export for LLM"}
              </button>
            </div>

            {runExportError && <pre className="error">{runExportError}</pre>}

            {runExportSummary && (
              <div className="dataset-export-summary">
                <p>
                  Exported {runExportSummary.segmentCount} acoustic segment
                  {runExportSummary.segmentCount === 1 ? "" : "s"} and {runExportSummary.candidateCount} candidate
                  {runExportSummary.candidateCount === 1 ? "" : "s"} for run {runExportSummary.runId}. Missing outputs:{" "}
                  {runExportSummary.missingOutputs}.
                </p>
                <p className="dataset-export-path" title={runExportSummary.exportDir}>
                  {runExportSummary.exportDir}
                </p>
                <button className="secondary-button" onClick={openRunExportFolder}>
                  Open export folder
                </button>
              </div>
            )}
          </section>

          <section className="panel summary-panel">
            <div className="panel-header">
              <div>
                <h2>Candidate summary</h2>
                <p>
                  Scored against this run's frozen acoustic snapshot. Acoustic CER (the highlighted metric) ignores sentence
                  punctuation; strict CER counts it. CER/WER: lower is better.
                </p>
              </div>
            </div>

            {detail.summary.length === 0 ? (
              <p className="empty-state">No candidate logged an output in this run.</p>
            ) : (
              <CandidateSummaryTable
                candidates={detail.summary}
                currentSelection={currentSelection}
                selectionReasonDraft={selectionReasonDraft}
                setSelectionReasonDraft={setSelectionReasonDraft}
                selectionError={selectionError}
                isSelectingCandidateKey={isSelectingCandidateKey}
                selectCandidate={selectCandidate}
              />
            )}
          </section>

          <section className="panel benchmark-panel">
            <div className="panel-header">
              <div>
                <h2>Outputs</h2>
                <p>What each candidate answered for each member of this run's frozen snapshot</p>
              </div>
            </div>
            <RunSegmentOutputs segments={detail.segments} />
          </section>

          <section className="panel error-analysis-panel">
            <div className="panel-header">
              <div>
                <h2>Errors</h2>
                <p>This run's failures, plus heuristic diagnostics over its outputs — not a training signal</p>
              </div>
            </div>

            {detail.failures.length > 0 && (
              <ul className="run-failures">
                {detail.failures.map((failure) => (
                  <li className="batch-outcome-error" key={`${failure.sessionId}/${failure.segmentId}`}>
                    {failure.sessionId} / {failure.segmentId}: {failure.error}
                  </li>
                ))}
              </ul>
            )}

            {errorAnalysis.length === 0 ? (
              <p className="empty-state">
                {detail.failures.length > 0
                  ? "No heuristic diagnostic beyond the failures above."
                  : "No error flagged in this run's outputs."}
              </p>
            ) : (
              <div className="error-analysis-candidates">
                {errorAnalysis.map((analysis) => (
                  <article className="error-analysis-candidate" key={analysis.candidateKey}>
                    <strong title={analysis.candidateLabel}>{analysis.candidateLabel}</strong>
                    <div className="error-category-badges">
                      {(Object.keys(analysis.categoryCounts) as SttErrorCategory[])
                        .filter((category) => analysis.categoryCounts[category] > 0)
                        .map((category) => (
                          <span className="error-category-badge" key={category}>
                            {ERROR_CATEGORY_LABELS[category]} · {analysis.categoryCounts[category]}
                          </span>
                        ))}
                    </div>
                    <ul className="error-examples">
                      {analysis.examples.map((example, index) => (
                        <li
                          className="error-example"
                          key={`${example.sessionId}/${example.segmentId}/${example.category}/${index}`}
                        >
                          <span className="error-example-heading">
                            {ERROR_CATEGORY_LABELS[example.category]} · {example.sessionId} / {example.segmentId}
                          </span>
                          <span className="error-example-detail">{example.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {detail?.stage === "math_transform" && (
        <NormalizerRunResults
          detail={detail}
          runExportSummary={runExportSummary}
          runExportError={runExportError}
          isExportingRun={isExportingRun}
          exportSelectedRun={exportSelectedRun}
          openRunExportFolder={openRunExportFolder}
        />
      )}

      {legacySummary && (
        <section className="panel summary-panel">
          <div className="panel-header">
            <div>
              <h2>Legacy results</h2>
              <p>
                Results recorded before run tracking (no run id, no snapshot). Kept readable, never attached to a run and
                never re-scored.
              </p>
            </div>
          </div>

          {legacySummary.candidates.length === 0 ? (
            <p className="empty-state">No legacy result in {formatBenchmarkSetSplit(legacySummary.split)}.</p>
          ) : (
            <CandidateSummaryTable
              candidates={legacySummary.candidates}
              currentSelection={currentSelection}
              selectionReasonDraft={selectionReasonDraft}
              setSelectionReasonDraft={setSelectionReasonDraft}
              selectionError={selectionError}
              isSelectingCandidateKey={isSelectingCandidateKey}
              selectCandidate={selectCandidate}
            />
          )}
        </section>
      )}
    </>
  );
}
