import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  BenchmarkCandidateIdentity,
  SttBenchmarkSetProgress,
  SttBenchmarkSetRunResponse,
  SttBenchmarkSetSplit,
} from "@dictex/shared";
import {
  getExperimentStage,
  planExperimentLaunch,
  planLaunchNavigation,
  type ExperimentLaunchPlan,
  type ExperimentStage,
  type ExperimentStageId,
} from "../experimentProtocol.js";
import type { LabApi } from "../api.js";
import type { ExperimentPreview } from "../views/ExperimentsView.js";
import type { View } from "../views/LabNavigation.js";
import type { SttBenchmarkCandidateOption } from "../../../main/candidateCatalog.js";
import type { NormalizerBenchmarkRunResponse } from "../../../main/normalizerBenchmark.js";

export type Experiments = {
  candidateCatalog: SttBenchmarkCandidateOption[];
  stageId: ExperimentStageId;
  stage: ExperimentStage;
  selectExperimentStage: (stageId: ExperimentStageId) => void;
  experimentSplit: SttBenchmarkSetSplit;
  selectExperimentSplit: (split: SttBenchmarkSetSplit) => void;

  /** The snapshot a launch would freeze right now — never one fetched for another split or stage. */
  experimentPreview: ExperimentPreview | null;
  previewError: string;
  /** Re-reads the Normalizer preview for the current split; throws so the caller can report it. */
  refreshNormalizerPreview: () => Promise<void>;

  experimentCandidates: BenchmarkCandidateIdentity[];
  /** The candidate selector edits the list from its current value, so it needs the real setter. */
  setSelectedCandidates: Dispatch<SetStateAction<BenchmarkCandidateIdentity[]>>;

  newPromptVariantName: string;
  setNewPromptVariantName: (name: string) => void;
  newPromptVariantDisplayName: string;
  setNewPromptVariantDisplayName: (displayName: string) => void;
  newPromptVariantText: string;
  setNewPromptVariantText: (text: string) => void;
  isCreatingPromptVariant: boolean;
  createPromptVariantError: string;
  createPromptVariant: () => Promise<boolean>;

  launchPlan: ExperimentLaunchPlan;
  isRunningExperiment: boolean;
  launchProgress: SttBenchmarkSetProgress | null;
  launchError: string;
  launchExperiment: () => Promise<void>;
};

/**
 * The protocol to launch — never a past result (issue #138).
 *
 * @param view drives the preview refresh: the announced evaluable member count
 *   is re-read whenever the Lab comes back to Experiments, since qualifying a
 *   Layer 1 or assigning a split happens over in Corpus.
 * @param showRun follows the run a launch created, so it becomes the selected
 *   result. A launch's result lives with its run, never in the form that
 *   started it.
 */
export function useExperiments({
  api,
  view,
  showRun,
  onNavigate,
}: {
  api: LabApi;
  view: View;
  showRun: (split: SttBenchmarkSetSplit, runKey: string) => Promise<void>;
  onNavigate: (view: View) => void;
}): Experiments {
  const [candidateCatalog, setCandidateCatalog] = useState<SttBenchmarkCandidateOption[]>([]);
  const [experimentStageId, setExperimentStageId] = useState<ExperimentStageId>("stt");
  const [experimentSplit, setExperimentSplit] = useState<SttBenchmarkSetSplit>("validation");
  // What a run over the experiment's split would freeze right now: read from the
  // same snapshot builder the launch uses, so the announced member count is the
  // one that will actually run.
  const [setPreview, setSetPreview] = useState<ExperimentPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  // STT prompt variant creation (issue #121): a valid new variant becomes a new
  // faster-whisper benchmark candidate. The candidate selector (issue #126)
  // surfaces this as a secondary "New prompt" action beside the prompt choice,
  // rather than a permanent list panel, so existing variants are discovered by
  // opening the prompt selector (the catalog already carries them).
  const [newPromptVariantName, setNewPromptVariantName] = useState("");
  const [newPromptVariantDisplayName, setNewPromptVariantDisplayName] = useState("");
  const [newPromptVariantText, setNewPromptVariantText] = useState("");
  const [isCreatingPromptVariant, setIsCreatingPromptVariant] = useState(false);
  const [createPromptVariantError, setCreatePromptVariantError] = useState("");
  const [selectedCandidates, setSelectedCandidates] = useState<BenchmarkCandidateIdentity[]>([]);
  const [launchProgress, setLaunchProgress] = useState<SttBenchmarkSetProgress | null>(null);
  const [launchError, setLaunchError] = useState("");
  const [isRunningExperiment, setIsRunningExperiment] = useState(false);

  const experimentStage = getExperimentStage(experimentStageId);
  // Never render or launch from a count fetched for a previous split. The
  // handler below clears it eagerly; this check also protects the small window
  // before React has run the next effect's cleanup.
  const experimentPreview =
    setPreview?.split === experimentSplit && setPreview.stage === experimentStage.benchmarkStage ? setPreview : null;
  const experimentCandidates =
    experimentStage.id === "normalizer"
      ? experimentPreview?.stage === "math_transform"
        ? [experimentPreview.candidate.candidate]
        : []
      : selectedCandidates;
  const launchPlan = planExperimentLaunch({
    stage: experimentStage,
    split: experimentSplit,
    preview: experimentPreview,
    candidates: experimentCandidates,
    isRunning: isRunningExperiment,
  });

  useEffect(() => {
    const removeBatchProgressListener = api.onBatchBenchmarkProgress(setLaunchProgress);
    void api
      .getSttBenchmarkCandidates()
      .then((catalog) => {
        setCandidateCatalog(catalog);
        setSelectedCandidates(catalog.slice(0, 3).map((option) => option.candidate));
      })
      .catch(() => {
        // Non-fatal; the batch selector just shows no candidates.
      });

    return () => {
      removeBatchProgressListener();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The evaluable member count a launch would freeze. Refreshed when the
  // experiment's split changes and whenever the view comes back to Experiments,
  // since qualifying a Layer 1 or assigning a split happens over in Corpus.
  useEffect(() => {
    if (view !== "experiments") {
      return;
    }

    setSetPreview(null);
    setPreviewError("");
    let cancelled = false;
    const previewPromise: Promise<ExperimentPreview> =
      experimentStage.benchmarkStage === "math_transform"
        ? api.previewNormalizerBenchmarkSet(experimentSplit)
        : api.previewSttBenchmarkSet(experimentSplit).then((preview) => ({ ...preview, stage: "stt" as const }));
    previewPromise
      .then((preview) => {
        if (!cancelled) {
          setSetPreview(preview);
          setPreviewError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSetPreview(null);
          setPreviewError(error instanceof Error ? error.message : "Could not read the corpus for this split");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, experimentSplit, experimentStage.benchmarkStage, api]);

  function selectExperimentStage(stageId: ExperimentStageId): void {
    if (stageId === experimentStageId) {
      return;
    }
    setExperimentStageId(stageId);
    setSetPreview(null);
    setPreviewError("");
    setLaunchError("");
    setLaunchProgress(null);
  }

  function selectExperimentSplit(split: SttBenchmarkSetSplit): void {
    if (split === experimentSplit) {
      return;
    }

    // The next preview is asynchronous, so remove the old split's count in
    // the same event that changes the selection.
    setExperimentSplit(split);
    setSetPreview(null);
    setPreviewError("");
  }

  async function refreshNormalizerPreview(): Promise<void> {
    setSetPreview(await api.previewNormalizerBenchmarkSet(experimentSplit));
  }

  async function refreshCandidateCatalog(): Promise<void> {
    try {
      const catalog = await api.getSttBenchmarkCandidates();
      setCandidateCatalog(catalog);
    } catch {
      // Non-fatal; the batch selector keeps its previous catalog.
    }
  }

  // Creating a variant (issue #121) immediately refreshes the candidate catalog,
  // since a newly-defined variant becomes a new faster-whisper benchmark
  // candidate for every configured model — the prompt selector (issue #126)
  // then offers it right away. Returns whether creation succeeded so the caller
  // can collapse its inline form only on success (a rejected id keeps its
  // values and error visible, immutability rules unchanged).
  async function createPromptVariant(): Promise<boolean> {
    setCreatePromptVariantError("");
    setIsCreatingPromptVariant(true);
    try {
      await api.createSttPromptVariant({
        name: newPromptVariantName.trim(),
        displayName: newPromptVariantDisplayName.trim(),
        promptText: newPromptVariantText.trim(),
      });
      setNewPromptVariantName("");
      setNewPromptVariantDisplayName("");
      setNewPromptVariantText("");
      await refreshCandidateCatalog();
      return true;
    } catch (createError) {
      setCreatePromptVariantError(
        createError instanceof Error ? createError.message : "Could not create the STT prompt variant",
      );
      return false;
    } finally {
      setIsCreatingPromptVariant(false);
    }
  }

  /**
   * Launches the announced protocol, then follows the run it created: the new
   * run becomes the selected result and the Lab moves to Results. The launch
   * form keeps no trace of it — a result lives with its run, never in the form
   * that started it.
   */
  async function launchExperiment(): Promise<void> {
    if (!launchPlan.canLaunch) {
      return;
    }

    const split = experimentSplit;
    setLaunchError("");
    setLaunchProgress(null);
    setIsRunningExperiment(true);

    let response: SttBenchmarkSetRunResponse | NormalizerBenchmarkRunResponse | null = null;
    try {
      if (experimentStage.id === "normalizer") {
        const candidate = experimentPreview?.stage === "math_transform" ? experimentPreview.candidate.candidate : null;
        if (!candidate) {
          throw new Error("Read the current deterministic pipeline before launching");
        }
        response = await api.runSetNormalizerBenchmark(split, candidate);
      } else {
        response = await api.runSetSttBenchmark(split, selectedCandidates);
      }
    } catch (runError) {
      setLaunchError(runError instanceof Error ? runError.message : "The experiment failed to run");
    } finally {
      setIsRunningExperiment(false);
    }

    const navigation = planLaunchNavigation(response?.runId ?? null);
    if (navigation.view !== "results") {
      return;
    }

    await showRun(split, navigation.selectedRunKey);
    setLaunchProgress(null);
    onNavigate("results");
  }

  return {
    candidateCatalog,
    stageId: experimentStageId,
    stage: experimentStage,
    selectExperimentStage,
    experimentSplit,
    selectExperimentSplit,

    experimentPreview,
    previewError,
    refreshNormalizerPreview,

    experimentCandidates,
    setSelectedCandidates,

    newPromptVariantName,
    setNewPromptVariantName,
    newPromptVariantDisplayName,
    setNewPromptVariantDisplayName,
    newPromptVariantText,
    setNewPromptVariantText,
    isCreatingPromptVariant,
    createPromptVariantError,
    createPromptVariant,

    launchPlan,
    isRunningExperiment,
    launchProgress,
    launchError,
    launchExperiment,
  };
}
