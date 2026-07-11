import assert from "node:assert/strict";
import { test } from "node:test";

import type { NormalizationResult } from "@dictex/shared";
import { COMMANDS } from "@dictex/shared/commands";

import { prepareNormalization } from "./normalizationPolicy.js";

test("disabled policy keeps raw STT byte-identical and never calls the normalizer", async () => {
  const rawTranscript = "retour à la ligne x au carré  \n";
  let normalizerCalled = false;

  const prepared = await prepareNormalization(rawTranscript, false, async () => {
    normalizerCalled = true;
    throw new Error("normalizer must not run while disabled");
  });

  assert.equal(normalizerCalled, false);
  assert.equal(prepared.insertedTranscript, rawTranscript);
  assert.equal(prepared.inputTranscript, rawTranscript);
  assert.equal(prepared.outputTranscript, rawTranscript);
  assert.equal(prepared.normalizationApplied, false);
  assert.deepEqual(prepared.normalizationDiagnostics, []);
  assert.deepEqual(prepared.layers, []);
  assert.deepEqual(prepared.eventState, { disabled: true });
  assert.equal("passthrough" in prepared.eventState, false);
});

test("enabled policy expands command sentinels before insertion and event storage", async () => {
  const rawTranscript = "retour à la ligne x au carré";
  const sentinelOutput = `${COMMANDS[0].sentinel} $x^{2}$`;
  const normalization: NormalizationResult = {
    input: rawTranscript,
    output: sentinelOutput,
    passthrough: false,
    layers: [
      {
        layer: "command_extraction",
        input: rawTranscript,
        output: sentinelOutput,
        applied: true,
        diagnostics: [],
      },
    ],
    diagnostics: ["example diagnostic"],
  };

  const prepared = await prepareNormalization(rawTranscript, true, async () => normalization);

  assert.equal(prepared.insertedTranscript, "\n $x^{2}$");
  assert.equal(prepared.outputTranscript, "\n $x^{2}$");
  assert.equal(prepared.normalizationApplied, true);
  assert.deepEqual(prepared.normalizationDiagnostics, ["example diagnostic"]);
  assert.deepEqual(prepared.eventState, { passthrough: false });
  assert.equal("disabled" in prepared.eventState, false);
  assert.deepEqual(prepared.layers, [
    {
      layer: "command_extraction",
      input: rawTranscript,
      output: "\n $x^{2}$",
      applied: true,
      diagnostics: [],
    },
  ]);
});

test("enabled no-op policy records passthrough instead of disabled", async () => {
  const rawTranscript = "ordinary prose";
  const normalization: NormalizationResult = {
    input: rawTranscript,
    output: rawTranscript,
    passthrough: true,
    layers: [],
    diagnostics: [],
  };

  const prepared = await prepareNormalization(rawTranscript, true, async () => normalization);

  assert.equal(prepared.insertedTranscript, rawTranscript);
  assert.equal(prepared.normalizationApplied, false);
  assert.deepEqual(prepared.eventState, { passthrough: true });
  assert.equal("disabled" in prepared.eventState, false);
});
