import { test } from "node:test";
import assert from "node:assert/strict";

import type { SttBenchmarkCandidateSummaryResponse, SttBenchmarkRunDetail } from "@dictex/shared";
import {
  applyLegacySummary,
  applyResultsError,
  applyRunDetail,
  emptyResultsState,
  LEGACY_RUN_KEY,
  startResultsSelection,
} from "./resultsSelection.js";

function detail(runId: string, segmentId: string): SttBenchmarkRunDetail {
  return {
    runId,
    createdAt: "2026-07-13T10:00:00.000Z",
    finishedAt: "2026-07-13T10:05:00.000Z",
    stage: "stt",
    datasetKind: "acoustic",
    split: "validation",
    finished: true,
    done: 1,
    failed: 0,
    candidates: [
      { stage: "stt", provider: "faster-whisper", model: "base", variant: "cpu-int8-fr", promptVariant: null },
    ],
    promptDefinitions: [],
    failures: [],
    segments: [
      {
        sessionId: "session_1",
        segmentId,
        audioRef: `audio/session_1/${segmentId}.webm`,
        referenceTranscript: "x au carré",
        correctionCreatedAt: "2026-07-13T09:00:00.000Z",
        status: "done",
        error: null,
        results: [],
      },
    ],
    summary: [],
  };
}

const LEGACY_SUMMARY: SttBenchmarkCandidateSummaryResponse = {
  split: "validation",
  totalSegments: 2,
  candidates: [],
};

test("selecting a run drops the previous run's data before the new one arrives", () => {
  const showingRunA = applyRunDetail(startResultsSelection("run_a"), "run_a", detail("run_a", "seg_0001"));
  assert.equal(showingRunA.detail?.runId, "run_a");

  const selectingRunB = startResultsSelection("run_b");

  assert.equal(selectingRunB.detail, null, "run A's snapshot never survives into run B's selection");
  assert.equal(selectingRunB.legacySummary, null);
  assert.equal(selectingRunB.isLoading, true);
  assert.equal(selectingRunB.error, "");
});

/**
 * The real hazard of a per-run view: two selections in flight, the slower
 * response landing last, and run A's snapshot rendered under run B's header.
 */
test("a response for a run that is no longer selected is ignored", () => {
  const selectingRunB = startResultsSelection("run_b");

  const lateRunA = applyRunDetail(selectingRunB, "run_a", detail("run_a", "seg_0001"));
  assert.equal(lateRunA.detail, null, "run A's late detail is dropped");
  assert.equal(lateRunA.selectedKey, "run_b");
  assert.equal(lateRunA.isLoading, true, "the pending run B selection is untouched");

  const runB = applyRunDetail(lateRunA, "run_b", detail("run_b", "seg_0002"));
  assert.equal(runB.detail?.runId, "run_b");
  assert.equal(runB.detail?.segments[0].segmentId, "seg_0002");
  assert.equal(runB.isLoading, false);
});

test("a late error from a previous selection cannot poison the current one", () => {
  const runB = applyRunDetail(startResultsSelection("run_b"), "run_b", detail("run_b", "seg_0002"));
  const lateFailure = applyResultsError(runB, "run_a", "Benchmark run detail failed");

  assert.equal(lateFailure.error, "");
  assert.equal(lateFailure.detail?.runId, "run_b");
});

test("a run that no longer exists reports it instead of showing another run", () => {
  const missing = applyRunDetail(startResultsSelection("run_gone"), "run_gone", null);

  assert.equal(missing.detail, null);
  assert.match(missing.error, /no longer exists/);
  assert.equal(missing.isLoading, false);
});

test("the legacy bucket and a tracked run never coexist", () => {
  const runA = applyRunDetail(startResultsSelection("run_a"), "run_a", detail("run_a", "seg_0001"));
  const legacy = applyLegacySummary(startResultsSelection(LEGACY_RUN_KEY), LEGACY_RUN_KEY, LEGACY_SUMMARY);

  assert.equal(runA.legacySummary, null);
  assert.equal(legacy.detail, null, "legacy results have no snapshot; no run detail is shown for them");
  assert.equal(legacy.legacySummary?.totalSegments, 2);

  const backToRun = applyRunDetail(startResultsSelection("run_a"), "run_a", detail("run_a", "seg_0001"));
  assert.equal(backToRun.legacySummary, null);
});

test("an empty Results view selects nothing", () => {
  const state = emptyResultsState();

  assert.equal(state.selectedKey, null);
  assert.equal(state.detail, null);
  assert.equal(state.legacySummary, null);
  assert.equal(state.isLoading, false);
});
