import React from "react";
import type { SttBenchmarkRunDetail } from "@dictex/shared";
import { formatLatency, formatScore } from "@dictex/shared/formatting";
import { formatBenchmarkCandidate, formatBenchmarkCandidateKey } from "@dictex/shared/errorAnalysis";

/** One card per snapshot member: what the run measured, and what each candidate answered. */
export function RunSegmentOutputs({
  segments,
}: {
  segments: SttBenchmarkRunDetail["segments"];
}): React.ReactElement {
  if (segments.length === 0) {
    return <p className="empty-state">This run's snapshot is empty.</p>;
  }

  return (
    <div className="batch-outcomes">
      {segments.map((segment) => (
        <article
          className={segment.status === "failed" ? "batch-outcome batch-outcome-failed" : "batch-outcome"}
          key={`${segment.sessionId}/${segment.segmentId}`}
        >
          <div className="batch-outcome-heading">
            <strong title={`${segment.sessionId} / ${segment.segmentId}`}>
              {segment.sessionId} / {segment.segmentId}
            </strong>
            <em
              className={`batch-outcome-state ${
                segment.status === "failed"
                  ? "batch-outcome-state-failed"
                  : segment.status === "missing" || segment.status === "completed_without_output"
                    ? "batch-outcome-state-missing"
                    : ""
              }`}
            >
              {segment.status === "completed_without_output" ? "completed without output" : segment.status}
            </em>
          </div>

          <p className="run-reference" title={segment.referenceTranscript ?? undefined}>
            Layer 1 reference: {segment.referenceTranscript ?? "none — this member is not scored"}
          </p>

          {segment.error && <p className="batch-outcome-error">{segment.error}</p>}
          {segment.status === "missing" && (
            <p className="batch-outcome-meta">Never executed in this run — no output was logged for it.</p>
          )}
          {segment.status === "completed_without_output" && (
            <p className="batch-outcome-meta">
              This historical run finished as done but logged no output — it is not treated as never executed.
            </p>
          )}

          {segment.results.length > 0 && (
            <ul className="run-outputs">
              {segment.results.map((result) => (
                <li className="run-output" key={formatBenchmarkCandidateKey(result)}>
                  <span className="run-output-candidate" title={formatBenchmarkCandidate(result)}>
                    {formatBenchmarkCandidate(result)}
                  </span>
                  <p className="run-output-transcript">{result.transcript || "-"}</p>
                  <span className="run-output-meta">
                    {formatLatency(result.transcriptionDurationMs)}
                    {result.score ? ` · ${formatScore(result.score)}` : " · no reference, no score"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}
