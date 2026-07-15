import assert from "node:assert/strict";
import test from "node:test";

import { requireNonEmptySttBenchmarkSnapshot, requireSttBenchmarkOutput } from "./benchmarkExecution.js";

test("an empty STT snapshot is rejected before a run can be recorded", () => {
  assert.throws(() => requireNonEmptySttBenchmarkSnapshot([]), /no evaluable audio segment/);
});

test("a Vosk-only unavailable segment fails instead of completing without output", () => {
  assert.throws(
    () => requireSttBenchmarkOutput([], ["vosk/vosk-model-small-fr unavailable: model files missing"]),
    /No STT candidate produced an output.*vosk\/vosk-model-small-fr unavailable/,
  );
});
