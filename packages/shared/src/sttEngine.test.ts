import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSttVariantId, getSttPromptVariants, mergeLocalPromptVariantIntoEnvTable } from "./sttEngine.js";

/**
 * Pure-logic coverage for #93 (STT sidecar: expose faster-whisper
 * `initial_prompt` as a candidate variant). `transcribeWithPython` itself
 * spawns the Python sidecar and is exercised manually per
 * docs/development.md, not here; these tests cover the parsing/threading
 * logic that runs entirely in TypeScript.
 */

const ENV_KEY = "DICTEX_STT_PROMPT_VARIANTS";

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

test("getSttPromptVariants: unset env yields no variants", () => {
  withEnv(undefined, () => {
    assert.deepEqual(getSttPromptVariants(), {});
  });
});

test("getSttPromptVariants: parses a JSON object of name -> prompt text", () => {
  withEnv(
    JSON.stringify({
      "prompt-v3-fr-math": "Dictée mathématique en français : x carré, intégrale, dérivée.",
    }),
    () => {
      assert.deepEqual(getSttPromptVariants(), {
        "prompt-v3-fr-math": "Dictée mathématique en français : x carré, intégrale, dérivée.",
      });
    },
  );
});

test("getSttPromptVariants: prompt text may contain commas (why this is JSON, not CSV)", () => {
  withEnv(JSON.stringify({ v1: "a, b, c" }), () => {
    assert.deepEqual(getSttPromptVariants(), { v1: "a, b, c" });
  });
});

test("getSttPromptVariants: malformed JSON quietly yields no variants", () => {
  withEnv("not json {{{", () => {
    assert.deepEqual(getSttPromptVariants(), {});
  });
});

test("getSttPromptVariants: a JSON array or non-object quietly yields no variants", () => {
  withEnv(JSON.stringify(["a", "b"]), () => {
    assert.deepEqual(getSttPromptVariants(), {});
  });
  withEnv(JSON.stringify("just a string"), () => {
    assert.deepEqual(getSttPromptVariants(), {});
  });
});

test("getSttPromptVariants: drops entries with empty names or non-string/empty text", () => {
  withEnv(JSON.stringify({ "": "text", ok: "text", empty: "", numeric: 5 }), () => {
    assert.deepEqual(getSttPromptVariants(), { ok: "text" });
  });
});

test("buildSttVariantId: with no prompt variant, reproduces the existing device-computeType-language shape", () => {
  assert.equal(
    buildSttVariantId({ device: "cpu", computeType: "int8", language: "fr" }),
    "cpu-int8-fr",
  );
  assert.equal(
    buildSttVariantId({ device: "cpu", computeType: "int8", language: "fr" }, undefined),
    "cpu-int8-fr",
  );
});

test("buildSttVariantId: a requested prompt variant is appended to the runtime, not substituted for it", () => {
  assert.equal(
    buildSttVariantId({ device: "cuda", computeType: "float16", language: "fr" }, "prompt-v3-fr-math"),
    "cuda-float16-fr+prompt-v3-fr-math",
  );
});

test("mergeLocalPromptVariantIntoEnvTable: leaves the inherited table untouched when no local prompt text is given (external-variant path)", () => {
  assert.equal(mergeLocalPromptVariantIntoEnvTable(undefined, "v1", undefined), undefined);
  assert.equal(mergeLocalPromptVariantIntoEnvTable(JSON.stringify({ v1: "text" }), "v1", undefined), undefined);
});

test("mergeLocalPromptVariantIntoEnvTable: adds the local variant to an empty/absent inherited table", () => {
  assert.equal(
    mergeLocalPromptVariantIntoEnvTable(undefined, "local-1", "local prompt text"),
    JSON.stringify({ "local-1": "local prompt text" }),
  );
});

test("mergeLocalPromptVariantIntoEnvTable: merges on top of an inherited table without dropping existing entries", () => {
  const result = mergeLocalPromptVariantIntoEnvTable(
    JSON.stringify({ "ext-1": "external text" }),
    "local-1",
    "local prompt text",
  );
  assert.deepEqual(JSON.parse(result as string), { "ext-1": "external text", "local-1": "local prompt text" });
});

test("mergeLocalPromptVariantIntoEnvTable: malformed inherited JSON is treated as empty rather than thrown", () => {
  const result = mergeLocalPromptVariantIntoEnvTable("not json {{{", "local-1", "local prompt text");
  assert.deepEqual(JSON.parse(result as string), { "local-1": "local prompt text" });
});

test("buildSttVariantId: the same prompt on two runtimes keeps two distinct candidate identities", () => {
  // benchmarkSummary keys a candidate on `stage/provider/model/variant`. If the
  // variant collapsed to the prompt name, these two runs would merge into one
  // row: their CER would be averaged and their latency comparison destroyed.
  const onGpu = buildSttVariantId({ device: "cuda", computeType: "float16", language: "fr" }, "p1");
  const onCpu = buildSttVariantId({ device: "cpu", computeType: "int8", language: "fr" }, "p1");
  assert.notEqual(onGpu, onCpu);
});
