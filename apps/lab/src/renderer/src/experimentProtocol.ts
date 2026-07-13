import type { BenchmarkCandidateIdentity, SttBenchmarkSetPreview, SttBenchmarkSetSplit } from "@dictex/shared";

/**
 * The launch side of the Lab (issue #138). An experiment is announced before it
 * runs: which stage, what it consumes, what it targets, over which split, on how
 * many members, with which exact candidates. Nothing here reads a past result —
 * the launch form owns the protocol, the Results view owns the run.
 *
 * Only stages backed by an append-only writer are executable. A future stage is
 * announced as unavailable rather than given a control that would do nothing:
 * a form that offers a stage it cannot run is a lie the user only discovers
 * after clicking.
 */

export type ExperimentStageId = "stt" | "normalizer" | "end_to_end";

export type ExperimentStage = {
  id: ExperimentStageId;
  /** Append-only benchmark contract stage; null while no writer exists. */
  benchmarkStage: "stt" | "math_transform" | null;
  label: string;
  /** What the stage consumes. */
  input: string;
  /** What it is scored against. */
  target: string;
  /** The one line the launch form must state, e.g. `audio -> Layer 1`. */
  flow: string;
  available: boolean;
  /** Why it cannot run yet; null when it can. */
  unavailableReason: string | null;
};

export const EXPERIMENT_STAGES: ExperimentStage[] = [
  {
    id: "stt",
    benchmarkStage: "stt",
    label: "STT",
    input: "audio",
    target: "Layer 1 (acoustic)",
    flow: "audio -> Layer 1",
    available: true,
    unavailableReason: null,
  },
  {
    id: "normalizer",
    benchmarkStage: "math_transform",
    label: "Normalizer",
    input: "Layer 1",
    target: "Layer 2 (notation)",
    flow: "Layer 1 -> Normalizer -> Layer 2",
    available: true,
    unavailableReason: null,
  },
  {
    id: "end_to_end",
    benchmarkStage: null,
    label: "End to end",
    input: "audio",
    target: "Layer 2 (notation)",
    flow: "audio -> Layer 2",
    available: false,
    unavailableReason: "Not runnable yet — the Lab has no end-to-end benchmark.",
  },
];

export const MAX_EXPERIMENT_CANDIDATES = 3;

export function getExperimentStage(id: ExperimentStageId): ExperimentStage {
  return EXPERIMENT_STAGES.find((stage) => stage.id === id) ?? EXPERIMENT_STAGES[0];
}

export type ExperimentLaunchPlan = {
  canLaunch: boolean;
  /** Why the launch is refused; null when it is ready. */
  blockedReason: string | null;
  /** A launchable but degraded protocol, e.g. members with no acoustic reference. */
  warning: string | null;
};

export type ExperimentLaunchInput = {
  stage: ExperimentStage;
  /** The split the human currently selected in the launch form. */
  split: SttBenchmarkSetSplit;
  /** Null while the evaluable member count is still being read from the corpus. */
  preview: SttBenchmarkSetPreview | null;
  candidates: BenchmarkCandidateIdentity[];
  isRunning: boolean;
};

/**
 * Decides whether the announced protocol can actually run, and says why not in
 * the same terms the form displays. An empty snapshot is refused here rather
 * than logged as an empty run: a run with no member measures nothing but would
 * still appear in Results as a legitimate experiment.
 */
export function planExperimentLaunch({
  stage,
  split,
  preview,
  candidates,
  isRunning,
}: ExperimentLaunchInput): ExperimentLaunchPlan {
  // A preview is only authoritative for the split that produced it. In
  // particular, a split change must not leave the previous split launchable
  // while the new IPC read is still in flight.
  if (preview !== null && preview.split !== split) {
    return { canLaunch: false, blockedReason: "Reading the corpus…", warning: null };
  }

  const warning =
    stage.id === "stt" && preview !== null && preview.evaluableSegments > 0 && preview.scorableSegments === 0
      ? "No member of this split has a Layer 1 acoustic reference yet: the run will produce transcripts but no CER."
      : null;

  if (!stage.available) {
    return { canLaunch: false, blockedReason: stage.unavailableReason, warning: null };
  }
  if (isRunning) {
    return { canLaunch: false, blockedReason: null, warning };
  }
  if (candidates.length < 1) {
    return {
      canLaunch: false,
      blockedReason:
        stage.id === "normalizer"
          ? "Read the current deterministic pipeline before launching."
          : "Add at least one STT candidate to run.",
      warning,
    };
  }
  if (candidates.length > MAX_EXPERIMENT_CANDIDATES) {
    return {
      canLaunch: false,
      blockedReason: `A run compares at most ${MAX_EXPERIMENT_CANDIDATES} candidates.`,
      warning,
    };
  }
  if (preview === null) {
    return { canLaunch: false, blockedReason: "Reading the corpus…", warning: null };
  }
  if (preview.evaluableSegments === 0) {
    return {
      canLaunch: false,
      blockedReason:
        stage.id === "normalizer"
          ? "No evaluable math_transform pair in this split: qualify Layer 2 in Corpus and assign the segment first."
          : "No evaluable member in this split: qualify a segment's Layer 1 in Corpus and assign it to this split first.",
      warning: null,
    };
  }

  return { canLaunch: true, blockedReason: null, warning };
}

export type ExperimentLaunchNavigation =
  | { view: "results"; selectedRunKey: string }
  | { view: "experiments"; selectedRunKey: null };

/**
 * Where a finished launch lands. A successful run IS its result, so the Lab
 * follows it: the new run becomes the selected result and the view moves to it,
 * never leaving the human to hunt for the run they just started in a list. A
 * failed launch stays in the form, with its error, and selects nothing.
 */
export function planLaunchNavigation(runId: string | null): ExperimentLaunchNavigation {
  if (runId === null || runId.length === 0) {
    return { view: "experiments", selectedRunKey: null };
  }

  return { view: "results", selectedRunKey: runId };
}
