import type { SttBenchmarkCandidateSummaryResponse, SttBenchmarkRunDetail } from "@dictex/shared";

/**
 * The Results view shows exactly ONE run at a time (issue #138), and every
 * number it shows must belong to that run.
 *
 * The dangerous state is not a wrong click, it is a stale one: two selections in
 * flight, the slower response landing last, and a run rendered against another
 * run's snapshot — an analysis silently invalidated with no visible symptom.
 * So selection is a small state machine: choosing a run drops the previous run's
 * data immediately, and a response is only applied if it still answers the
 * current selection.
 */

/** Selector value for the pre-#122 results that carry no run_id; never a run id (always `run_…`). */
export const LEGACY_RUN_KEY = "legacy";

export type ResultsState = {
  /** A run id, LEGACY_RUN_KEY, or null when nothing is selected. */
  selectedKey: string | null;
  /** The selected run's own projection; null for the legacy bucket or while loading. */
  detail: SttBenchmarkRunDetail | null;
  /** The legacy (no run_id) summary; null unless the legacy bucket is selected. */
  legacySummary: SttBenchmarkCandidateSummaryResponse | null;
  isLoading: boolean;
  error: string;
};

export function emptyResultsState(): ResultsState {
  return { selectedKey: null, detail: null, legacySummary: null, isLoading: false, error: "" };
}

/**
 * Starts a selection. Everything the previous selection had shown is dropped
 * here, before the new data arrives, so no snapshot, output or summary of the
 * previous run can survive into the next one — not even for one frame.
 */
export function startResultsSelection(key: string): ResultsState {
  return { selectedKey: key, detail: null, legacySummary: null, isLoading: true, error: "" };
}

function isStale(state: ResultsState, key: string): boolean {
  return state.selectedKey !== key;
}

export function applyRunDetail(state: ResultsState, key: string, detail: SttBenchmarkRunDetail | null): ResultsState {
  if (isStale(state, key)) {
    return state;
  }
  if (detail === null) {
    return {
      ...state,
      detail: null,
      legacySummary: null,
      isLoading: false,
      error: "This run no longer exists in the Lab event log.",
    };
  }

  return { ...state, detail, legacySummary: null, isLoading: false, error: "" };
}

export function applyLegacySummary(
  state: ResultsState,
  key: string,
  summary: SttBenchmarkCandidateSummaryResponse,
): ResultsState {
  if (isStale(state, key)) {
    return state;
  }

  return { ...state, detail: null, legacySummary: summary, isLoading: false, error: "" };
}

export function applyResultsError(state: ResultsState, key: string, message: string): ResultsState {
  if (isStale(state, key)) {
    return state;
  }

  return { ...state, detail: null, legacySummary: null, isLoading: false, error: message };
}
