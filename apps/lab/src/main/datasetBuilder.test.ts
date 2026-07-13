import { test } from "node:test";
import assert from "node:assert/strict";

import { planDatasetBuilderSave } from "./datasetBuilder.js";

test("planDatasetBuilderSave: an acoustic-only segment does not write a math_transform correction", () => {
  const plan = planDatasetBuilderSave({
    source: {
      mode: "segment",
      sessionId: "session-1",
      segmentId: "segment-1",
      audioRef: "audio/segment-1.webm",
    },
    rawTranscript: "x au carré",
    literalTranscript: "x au carré",
    notationTranscript: "",
    split: "validation",
  });

  assert.equal(plan.saveAcoustic, true);
  assert.equal(plan.saveMathTransform, false);
});

test("planDatasetBuilderSave: a manual entry never writes an acoustic correction", () => {
  const plan = planDatasetBuilderSave({
    source: { mode: "paste" },
    rawTranscript: "x au carré",
    literalTranscript: "x au carré",
    notationTranscript: "$x^{2}$",
    split: "train_candidate_pool",
  });

  assert.equal(plan.saveAcoustic, false);
  assert.equal(plan.saveMathTransform, true);
});
