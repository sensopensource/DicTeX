import { test } from "node:test";
import assert from "node:assert/strict";

import { planCorpusCorrection, type CorpusCorrectionLayer } from "./corpusCorrection.js";

const RAW_STT = "x au carre";
const LAYER_1 = "x au carré";
const LAYER_2 = "$x^{2}$";

function segment(
  corrections: Array<{ correctionKind: "acoustic" | "math_transform"; correctedTranscript: string }>,
) {
  return {
    transcript: RAW_STT,
    correctionsByKind: corrections.map((correction) => ({
      correctionKind: correction.correctionKind,
      rawTranscript: "",
      correctedTranscript: correction.correctedTranscript,
      correctionMethod: "keyboard",
      correctionCreatedAt: "2026-07-13T00:00:00.000Z",
    })),
  };
}

test("planCorpusCorrection: Layer 1 writes an acoustic correction over the raw STT output", () => {
  const plan = planCorpusCorrection(segment([]), "layer1");

  assert.notEqual(plan, null);
  assert.equal(plan?.correctionKind, "acoustic");
  assert.equal(plan?.rawTranscript, RAW_STT);
  assert.equal(plan?.draft, RAW_STT);
});

test("planCorpusCorrection: Layer 2 writes a math_transform correction over the latest Layer 1", () => {
  const plan = planCorpusCorrection(
    segment([{ correctionKind: "acoustic", correctedTranscript: LAYER_1 }]),
    "layer2",
  );

  assert.notEqual(plan, null);
  assert.equal(plan?.correctionKind, "math_transform");
  assert.equal(plan?.rawTranscript, LAYER_1);
  assert.equal(plan?.draft, LAYER_1);
});

test("planCorpusCorrection: Layer 2 without a Layer 1 is refused rather than chained on the raw STT", () => {
  assert.equal(planCorpusCorrection(segment([]), "layer2"), null);
});

test("planCorpusCorrection: re-editing a layer opens on that layer's own saved correction", () => {
  const qualified = segment([
    { correctionKind: "acoustic", correctedTranscript: LAYER_1 },
    { correctionKind: "math_transform", correctedTranscript: LAYER_2 },
  ]);

  assert.equal(planCorpusCorrection(qualified, "layer1")?.draft, LAYER_1);
  assert.equal(planCorpusCorrection(qualified, "layer2")?.draft, LAYER_2);
});

/**
 * The B1 regression of PR #143: the editor used to let the human re-pick the
 * correction kind after opening, while raw_transcript stayed frozen from the
 * clicked layer — so "Edit Layer 2" switched to `acoustic` wrote an acoustic
 * pair whose raw_transcript was already a literal Layer 1 (DEC-COUCHE1-001), and
 * "Edit Layer 1" switched to `math_transform` wrote a math_transform pair that
 * skipped Layer 1. The kind is now derived WITH its raw_transcript, so neither
 * incoherent pair is representable from this view.
 */
test("planCorpusCorrection: the kind and its raw_transcript can never be mismatched", () => {
  const qualified = segment([
    { correctionKind: "acoustic", correctedTranscript: LAYER_1 },
    { correctionKind: "math_transform", correctedTranscript: LAYER_2 },
  ]);

  for (const layer of ["layer1", "layer2"] satisfies CorpusCorrectionLayer[]) {
    const plan = planCorpusCorrection(qualified, layer);
    assert.notEqual(plan, null);

    if (plan?.correctionKind === "acoustic") {
      assert.equal(plan.rawTranscript, RAW_STT, "an acoustic correction always transcribes the raw STT output");
    } else {
      assert.equal(plan?.rawTranscript, LAYER_1, "a math_transform correction always transforms Layer 1");
    }
  }
});
