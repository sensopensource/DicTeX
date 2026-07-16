import React from "react";
import type {
  BenchmarkCandidateIdentity,
  SttBenchmarkCandidateSummary,
  SttCandidateSelectionResponse,
} from "@dictex/shared";
import {
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  formatLatency,
  formatRatePercent,
  formatTimestamp,
} from "@dictex/shared/formatting";

type CandidateSummaryTableProps = {
  candidates: SttBenchmarkCandidateSummary[];
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  setSelectionReasonDraft: (value: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => void;
};

/**
 * The per-candidate table, shared by a tracked run and the legacy bucket. It is
 * read-only about the measurement itself; the only thing it writes is the human
 * choice of a base candidate (`stt_candidate_selection`), which is a reading of
 * results, not a launch.
 */
export function CandidateSummaryTable({
  candidates,
  currentSelection,
  selectionReasonDraft,
  setSelectionReasonDraft,
  selectionError,
  isSelectingCandidateKey,
  selectCandidate,
}: CandidateSummaryTableProps): React.ReactElement {
  return (
    <>
      <p className="empty-state">
        {currentSelection
          ? `Selected base candidate: ${formatCandidateIdentity(currentSelection.candidate)} — ${currentSelection.selectionReason}${
              currentSelection.createdAt ? ` (${formatTimestamp(currentSelection.createdAt)})` : ""
            }. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting.`
          : "No base STT candidate selected yet. The highest-quality candidate is not always best if latency is poor — compare mean latency before selecting."}
      </p>

      <div className="actions">
        <input
          aria-label="Candidate selection reason"
          className="reason-input"
          placeholder="Selection reason (e.g. best quality/latency tradeoff on validation)"
          value={selectionReasonDraft}
          onChange={(event) => setSelectionReasonDraft(event.target.value)}
        />
      </div>

      {selectionError && <pre className="error">{selectionError}</pre>}

      <div className="summary-table-scroll">
        <table className="summary-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Segments</th>
              <th className="metric-primary">Mean acoustic CER</th>
              <th className="metric-primary">Median acoustic CER</th>
              <th>Mean strict CER</th>
              <th>Median strict CER</th>
              <th>Mean WER</th>
              <th>Median WER</th>
              <th>Mean latency</th>
              <th>Missing</th>
              <th>Selection</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((summary) => {
              const candidateKey = formatCandidateIdentityKey(summary.candidate);
              const isSelected =
                currentSelection !== null && formatCandidateIdentityKey(currentSelection.candidate) === candidateKey;

              return (
                <tr key={candidateKey}>
                  <td title={candidateKey}>
                    {formatCandidateIdentity(summary.candidate)}
                    {isSelected && <span className="selected-badge">Selected</span>}
                  </td>
                  <td>{summary.resultCount}</td>
                  <td className="metric-primary">{formatRatePercent(summary.meanAcousticCer)}</td>
                  <td className="metric-primary">{formatRatePercent(summary.medianAcousticCer)}</td>
                  <td>{formatRatePercent(summary.meanCer)}</td>
                  <td>{formatRatePercent(summary.medianCer)}</td>
                  <td>{formatRatePercent(summary.meanWer)}</td>
                  <td>{formatRatePercent(summary.medianWer)}</td>
                  <td>{formatLatency(summary.meanLatencyMs === null ? null : Math.round(summary.meanLatencyMs))}</td>
                  <td>{summary.missingCount}</td>
                  <td>
                    <button
                      className="secondary-button"
                      disabled={isSelectingCandidateKey === candidateKey}
                      onClick={() => selectCandidate(summary.candidate)}
                    >
                      {isSelectingCandidateKey === candidateKey ? "Saving" : isSelected ? "Reselect" : "Select"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
