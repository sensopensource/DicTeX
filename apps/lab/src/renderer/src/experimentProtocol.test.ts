import { test } from "node:test";
import assert from "node:assert/strict";

import type { BenchmarkCandidateIdentity, SttBenchmarkSetPreview } from "@dictex/shared";
import {
  EXPERIMENT_STAGES,
  getExperimentStage,
  planExperimentLaunch,
  planLaunchNavigation,
} from "./experimentProtocol.js";

const STT = getExperimentStage("stt");
const NORMALIZER = getExperimentStage("normalizer");

function candidate(model: string): BenchmarkCandidateIdentity {
  return { stage: "stt", provider: "faster-whisper", model, variant: "cpu-int8-fr" };
}

function preview(evaluableSegments: number, scorableSegments = evaluableSegments): SttBenchmarkSetPreview {
  return { split: "validation", evaluableSegments, scorableSegments };
}

test("the STT protocol states audio -> Layer 1", () => {
  assert.equal(STT.flow, "audio -> Layer 1");
  assert.equal(STT.input, "audio");
  assert.equal(STT.target, "Layer 1 (acoustic)");
  assert.equal(STT.available, true);
});

test("a stage that cannot run announces itself as unavailable instead of offering a control", () => {
  const unavailable = EXPERIMENT_STAGES.filter((stage) => !stage.available);
  assert.ok(unavailable.length > 0, "future stages are announced, not hidden");

  for (const stage of unavailable) {
    assert.notEqual(stage.unavailableReason, null, `${stage.id} says why it cannot run`);
    const plan = planExperimentLaunch({
      stage,
      preview: preview(12),
      candidates: [candidate("base")],
      isRunning: false,
    });
    assert.equal(plan.canLaunch, false);
    assert.equal(plan.blockedReason, stage.unavailableReason);
  }
});

test("a complete STT protocol can be launched", () => {
  const plan = planExperimentLaunch({
    stage: STT,
    preview: preview(12),
    candidates: [candidate("base"), candidate("small")],
    isRunning: false,
  });

  assert.equal(plan.canLaunch, true);
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.warning, null);
});

test("a split with no evaluable member is refused rather than logged as an empty run", () => {
  const plan = planExperimentLaunch({
    stage: STT,
    preview: preview(0),
    candidates: [candidate("base")],
    isRunning: false,
  });

  assert.equal(plan.canLaunch, false);
  assert.match(plan.blockedReason ?? "", /No evaluable member/);
});

test("members without an acoustic reference warn, but do not block the launch", () => {
  const plan = planExperimentLaunch({
    stage: STT,
    preview: preview(4, 0),
    candidates: [candidate("base")],
    isRunning: false,
  });

  assert.equal(plan.canLaunch, true);
  assert.match(plan.warning ?? "", /no CER/);
});

test("the candidate count is bounded on both sides", () => {
  const none = planExperimentLaunch({ stage: STT, preview: preview(3), candidates: [], isRunning: false });
  assert.equal(none.canLaunch, false);
  assert.match(none.blockedReason ?? "", /at least one/);

  const tooMany = planExperimentLaunch({
    stage: STT,
    preview: preview(3),
    candidates: [candidate("tiny"), candidate("base"), candidate("small"), candidate("large-v3-turbo")],
    isRunning: false,
  });
  assert.equal(tooMany.canLaunch, false);
  assert.match(tooMany.blockedReason ?? "", /at most 3/);
});

test("a run in flight cannot be launched twice", () => {
  const plan = planExperimentLaunch({
    stage: STT,
    preview: preview(3),
    candidates: [candidate("base")],
    isRunning: true,
  });

  assert.equal(plan.canLaunch, false);
});

/**
 * The launch -> result transition (issue #138): the run a launch creates becomes
 * the selected result and the Lab follows it there. A failed launch stays in the
 * form, so an error is read where it happened.
 */
test("a successful launch selects the new run and moves to Results", () => {
  assert.deepEqual(planLaunchNavigation("run_20260713T100000000Z_ab12cd34"), {
    view: "results",
    selectedRunKey: "run_20260713T100000000Z_ab12cd34",
  });
});

test("a failed launch stays in Experiments and selects no result", () => {
  assert.deepEqual(planLaunchNavigation(null), { view: "experiments", selectedRunKey: null });
  assert.deepEqual(planLaunchNavigation(""), { view: "experiments", selectedRunKey: null });
});

test("the unavailable stages keep the STT protocol as the only executable one", () => {
  assert.equal(NORMALIZER.available, false);
  assert.deepEqual(
    EXPERIMENT_STAGES.filter((stage) => stage.available).map((stage) => stage.id),
    ["stt"],
  );
});
