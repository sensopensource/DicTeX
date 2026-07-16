import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  BenchmarkCandidateIdentity,
  SttBenchmarkSetPreview,
  SttBenchmarkSetSplit,
} from "@dictex/shared";
import { useExperiments } from "./useExperiments.js";
import { stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import type { LabApi } from "../api.js";
import type { View } from "../views/LabNavigation.js";
import type { SttBenchmarkCandidateOption } from "../../../main/candidateCatalog.js";
import type { NormalizerBenchmarkSetPreview } from "../../../main/normalizerBenchmark.js";
import type { ExperimentPreview } from "../views/ExperimentsView.js";

function identity(model: string, variant = "cpu-int8-fr"): BenchmarkCandidateIdentity {
  return { stage: "stt", provider: "faster-whisper", model, variant };
}

function catalogOption(model: string): SttBenchmarkCandidateOption {
  return {
    candidate: identity(model),
    providerLabel: "faster-whisper",
    modelLabel: model,
    runtimeLabel: "cpu-int8-fr",
    variantLabel: "baseline",
    promptText: null,
    supportsPrompt: true,
  };
}

/** `evaluableSegments` is what the launch plan gates on, so it is typed, not cast. */
function sttPreview(split: SttBenchmarkSetSplit, evaluableSegments = 3): SttBenchmarkSetPreview {
  return { split, evaluableSegments, scorableSegments: evaluableSegments };
}

function normalizerPreview(split: SttBenchmarkSetSplit, evaluableSegments = 2): NormalizerBenchmarkSetPreview {
  return {
    stage: "math_transform",
    split,
    evaluableSegments,
    scorableSegments: evaluableSegments,
    candidate: {
      candidate: { stage: "math_transform", provider: "dictex", model: "normalizer", variant: "v3" },
    },
    // Only the view renders the rules configuration; the hook never reads it.
    rulesConfiguration: { state: "current_overlay" },
  } as unknown as NormalizerBenchmarkSetPreview;
}

type ShownRun = { split: SttBenchmarkSetSplit; runKey: string };

async function mountExperiments(api: LabApi, view: View = "experiments") {
  const shownRuns: ShownRun[] = [];
  const navigations: View[] = [];
  const hook = await renderHook(useExperiments, {
    api,
    view,
    showRun: async (split, runKey) => {
      shownRuns.push({ split, runKey });
    },
    onNavigate: (next: View) => {
      navigations.push(next);
    },
  });
  // Read through a call: `assert.equal(x, null)` narrows `x` for the rest of the
  // test, so a test that asserts "no preview yet" and later reads the preview
  // again needs a fresh read that type narrowing cannot follow.
  const previewNow = (): ExperimentPreview | null => hook.current.experimentPreview;
  return { hook, shownRuns, navigations, previewNow };
}

/** The reads every mount makes on the Experiments view. */
function experimentsApi(stubs: Partial<LabApi> = {}): LabApi {
  return stubLabApi({
    onBatchBenchmarkProgress: () => () => {},
    getSttBenchmarkCandidates: async () => [catalogOption("base"), catalogOption("small")],
    previewSttBenchmarkSet: async (split) => sttPreview(split),
    ...stubs,
  });
}

test("mounting loads the catalog and preselects up to three candidates", async () => {
  const api = experimentsApi({
    getSttBenchmarkCandidates: async () => ["a", "b", "c", "d"].map(catalogOption),
  });
  const { hook } = await mountExperiments(api);

  assert.equal(hook.current.candidateCatalog.length, 4);
  assert.deepEqual(
    hook.current.experimentCandidates.map((candidate) => candidate.model),
    ["a", "b", "c"],
  );

  await hook.unmount();
});

test("an unreadable catalog leaves the selector empty rather than failing", async () => {
  const api = experimentsApi({
    getSttBenchmarkCandidates: async () => {
      throw new Error("Catalog could not be built");
    },
  });
  const { hook } = await mountExperiments(api);

  assert.deepEqual(hook.current.candidateCatalog, []);
  assert.deepEqual(hook.current.experimentCandidates, []);

  await hook.unmount();
});

test("the protocol opens on validation and announces its evaluable member count", async () => {
  const { hook } = await mountExperiments(experimentsApi());

  assert.equal(hook.current.experimentSplit, "validation");
  assert.equal(hook.current.experimentPreview?.split, "validation");
  assert.equal(hook.current.experimentPreview?.stage, "stt");
  assert.equal(hook.current.launchPlan.canLaunch, true);

  await hook.unmount();
});

test("no preview is read while the Lab is on another view", async () => {
  let previews = 0;
  const api = experimentsApi({
    previewSttBenchmarkSet: async (split) => {
      previews += 1;
      return sttPreview(split);
    },
  });
  const { hook, previewNow } = await mountExperiments(api, "corpus");

  assert.equal(previews, 0);
  assert.equal(previewNow(), null);

  // Coming back to Experiments re-reads it, since a split may have been
  // assigned over in Corpus meanwhile.
  await hook.rerender({
    api,
    view: "experiments",
    showRun: async () => {},
    onNavigate: () => {},
  });

  assert.equal(previews, 1);
  assert.equal(previewNow()?.split, "validation");

  await hook.unmount();
});

test("changing split re-reads the preview and never announces the old split's count", async () => {
  const asked: SttBenchmarkSetSplit[] = [];
  const api = experimentsApi({
    previewSttBenchmarkSet: async (split) => {
      asked.push(split);
      return sttPreview(split, split === "test_frozen" ? 9 : 3);
    },
  });
  const { hook } = await mountExperiments(api);
  assert.equal(hook.current.experimentPreview?.evaluableSegments, 3);

  await flush(() => hook.current.selectExperimentSplit("test_frozen"));

  assert.deepEqual(asked, ["validation", "test_frozen"]);
  assert.equal(hook.current.experimentSplit, "test_frozen");
  assert.equal(hook.current.experimentPreview?.split, "test_frozen");
  assert.equal(hook.current.experimentPreview?.evaluableSegments, 9);

  await hook.unmount();
});

test("a preview fetched for another split is never rendered", async () => {
  // The validation preview never resolves, so if the stale guard were missing
  // the test_frozen selection would keep showing validation's answer.
  const api = experimentsApi({
    previewSttBenchmarkSet: async (split) =>
      split === "validation" ? new Promise<SttBenchmarkSetPreview>(() => {}) : sttPreview(split, 9),
  });
  const { hook, previewNow } = await mountExperiments(api);
  assert.equal(previewNow(), null);

  await flush(() => hook.current.selectExperimentSplit("test_frozen"));

  assert.equal(previewNow()?.split, "test_frozen");

  await hook.unmount();
});

test("an unreadable corpus is reported and blocks the launch", async () => {
  const api = experimentsApi({
    previewSttBenchmarkSet: async () => {
      throw new Error("Events log is unreadable");
    },
  });
  const { hook } = await mountExperiments(api);

  assert.equal(hook.current.previewError, "Events log is unreadable");
  assert.equal(hook.current.experimentPreview, null);
  assert.equal(hook.current.launchPlan.canLaunch, false);

  await hook.unmount();
});

test("switching to the Normalizer stage reads that stage's own preview and candidate", async () => {
  const api = experimentsApi({
    previewNormalizerBenchmarkSet: async (split) => normalizerPreview(split),
  });
  const { hook } = await mountExperiments(api);
  assert.equal(hook.current.stage.id, "stt");

  await flush(() => hook.current.selectExperimentStage("normalizer"));

  assert.equal(hook.current.stage.id, "normalizer");
  assert.equal(hook.current.experimentPreview?.stage, "math_transform");
  assert.deepEqual(
    hook.current.experimentCandidates.map((candidate) => candidate.stage),
    ["math_transform"],
    "the Normalizer stage runs the current pipeline, never the STT selection",
  );

  await hook.unmount();
});

test("selecting the stage already shown changes nothing", async () => {
  let previews = 0;
  const api = experimentsApi({
    previewSttBenchmarkSet: async (split) => {
      previews += 1;
      return sttPreview(split);
    },
  });
  const { hook } = await mountExperiments(api);

  await flush(() => hook.current.selectExperimentStage("stt"));

  assert.equal(previews, 1, "no needless re-read");

  await hook.unmount();
});

test("launching STT runs the selected candidates and follows the run it created", async () => {
  let ranWith: { split: SttBenchmarkSetSplit; candidates: BenchmarkCandidateIdentity[] } | null = null;
  const api = experimentsApi({
    runSetSttBenchmark: async (split, candidates) => {
      ranWith = { split, candidates };
      return { runId: "run_new" } as never;
    },
  });
  const { hook, shownRuns, navigations } = await mountExperiments(api);

  await flush(() => hook.current.launchExperiment());

  assert.equal(ranWith!.split, "validation");
  assert.deepEqual(
    ranWith!.candidates.map((candidate) => candidate.model),
    ["base", "small"],
  );
  assert.deepEqual(shownRuns, [{ split: "validation", runKey: "run_new" }]);
  assert.deepEqual(navigations, ["results"]);
  assert.equal(hook.current.launchError, "");
  assert.equal(hook.current.isRunningExperiment, false);
  assert.equal(hook.current.launchProgress, null);

  await hook.unmount();
});

test("launching Normalizer runs the pipeline candidate of its own preview", async () => {
  let ranCandidate: BenchmarkCandidateIdentity | null = null;
  const api = experimentsApi({
    previewNormalizerBenchmarkSet: async (split) => normalizerPreview(split),
    runSetNormalizerBenchmark: async (_split, candidate) => {
      ranCandidate = candidate;
      return { runId: "run_norm" } as never;
    },
  });
  const { hook, shownRuns } = await mountExperiments(api);

  await flush(() => hook.current.selectExperimentStage("normalizer"));
  await flush(() => hook.current.launchExperiment());

  assert.equal(ranCandidate!.stage, "math_transform");
  assert.deepEqual(shownRuns, [{ split: "validation", runKey: "run_norm" }]);

  await hook.unmount();
});

test("a launch the plan refuses never reaches the main process", async () => {
  // `runSetSttBenchmark` is left unstubbed: reaching it would throw.
  const api = experimentsApi({ previewSttBenchmarkSet: async (split) => sttPreview(split, 0) });
  const { hook, shownRuns } = await mountExperiments(api);
  assert.equal(hook.current.launchPlan.canLaunch, false);

  await flush(() => hook.current.launchExperiment());

  assert.deepEqual(shownRuns, []);

  await hook.unmount();
});

test("a failed run is reported and the Lab stays on the launch form", async () => {
  const api = experimentsApi({
    runSetSttBenchmark: async () => {
      throw new Error("Python venv is missing");
    },
  });
  const { hook, shownRuns, navigations } = await mountExperiments(api);

  await flush(() => hook.current.launchExperiment());

  assert.equal(hook.current.launchError, "Python venv is missing");
  assert.equal(hook.current.isRunningExperiment, false);
  assert.deepEqual(shownRuns, [], "no run to show");
  assert.deepEqual(navigations, []);

  await hook.unmount();
});

test("changing stage clears the previous stage's launch error", async () => {
  const api = experimentsApi({
    previewNormalizerBenchmarkSet: async (split) => normalizerPreview(split),
    runSetSttBenchmark: async () => {
      throw new Error("Python venv is missing");
    },
  });
  const { hook } = await mountExperiments(api);

  await flush(() => hook.current.launchExperiment());
  assert.equal(hook.current.launchError, "Python venv is missing");

  await flush(() => hook.current.selectExperimentStage("normalizer"));

  assert.equal(hook.current.launchError, "");

  await hook.unmount();
});

test("creating a prompt variant clears the form and refreshes the catalog", async () => {
  let created: unknown = null;
  let catalogReads = 0;
  const api = experimentsApi({
    getSttBenchmarkCandidates: async () => {
      catalogReads += 1;
      return [catalogOption("base")];
    },
    createSttPromptVariant: async (request) => {
      created = request;
      return request as never;
    },
  });
  const { hook } = await mountExperiments(api);

  await flush(() => hook.current.setNewPromptVariantName("  prompt-lab-fr-math  "));
  await flush(() => hook.current.setNewPromptVariantDisplayName("  Lab math (FR)  "));
  await flush(() => hook.current.setNewPromptVariantText("  Dictée mathématique.  "));

  let succeeded: boolean | undefined;
  await flush(async () => {
    succeeded = await hook.current.createPromptVariant();
  });

  assert.equal(succeeded, true);
  assert.deepEqual(created, {
    name: "prompt-lab-fr-math",
    displayName: "Lab math (FR)",
    promptText: "Dictée mathématique.",
  });
  assert.equal(hook.current.newPromptVariantName, "");
  assert.equal(hook.current.newPromptVariantDisplayName, "");
  assert.equal(hook.current.newPromptVariantText, "");
  assert.equal(catalogReads, 2, "a new variant becomes a new candidate right away");
  assert.equal(hook.current.isCreatingPromptVariant, false);

  await hook.unmount();
});

test("a rejected prompt variant keeps its typed values and reports why", async () => {
  const api = experimentsApi({
    createSttPromptVariant: async () => {
      throw new Error("A variant with this id already exists");
    },
  });
  const { hook } = await mountExperiments(api);

  await flush(() => hook.current.setNewPromptVariantName("prompt-lab-fr-math"));
  await flush(() => hook.current.setNewPromptVariantText("Dictée mathématique."));

  let succeeded: boolean | undefined;
  await flush(async () => {
    succeeded = await hook.current.createPromptVariant();
  });

  assert.equal(succeeded, false, "the caller keeps its form open");
  assert.equal(hook.current.createPromptVariantError, "A variant with this id already exists");
  assert.equal(hook.current.newPromptVariantName, "prompt-lab-fr-math");
  assert.equal(hook.current.newPromptVariantText, "Dictée mathématique.");
  assert.equal(hook.current.isCreatingPromptVariant, false);

  await hook.unmount();
});

test("refreshing the Normalizer preview reads the current split and surfaces its failure", async () => {
  const api = experimentsApi({
    previewNormalizerBenchmarkSet: async (split) => {
      if (split === "test_frozen") {
        throw new Error("Could not read the corpus for this split");
      }
      return normalizerPreview(split, 7);
    },
  });
  const { hook } = await mountExperiments(api);

  await flush(() => hook.current.selectExperimentStage("normalizer"));
  await flush(() => hook.current.refreshNormalizerPreview());
  assert.equal(hook.current.experimentPreview?.evaluableSegments, 7);

  await flush(() => hook.current.selectExperimentSplit("test_frozen"));
  await assert.rejects(() => hook.current.refreshNormalizerPreview(), /Could not read the corpus/);

  await hook.unmount();
});
