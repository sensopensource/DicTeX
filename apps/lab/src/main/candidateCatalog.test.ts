import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSttBenchmarkCandidateCatalog,
  buildSttConfigForCandidate,
  candidateIdentityKey,
  getSttBenchmarkRuntimes,
  parseSttBenchmarkRuntimes,
  toCandidateOption,
  validateRequestedCandidates,
  FASTER_WHISPER_PROVIDER,
  VOSK_PROVIDER,
} from "./candidateCatalog.js";

/**
 * Pure-logic coverage for issue #94 (compare STT context variants on
 * `validation`): construction of the candidate catalog, its renderer-facing
 * labels, and validation/filtering of a renderer-supplied selection. The
 * Electron IPC wiring in ./index.ts is exercised manually per
 * docs/development.md, not here.
 */

const RUNTIME = { device: "cpu", computeType: "int8", language: "fr" };

function withEnv(entries: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(entries)) {
    previous[key] = process.env[key];
    const value = entries[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("buildSttBenchmarkCandidateCatalog: no prompt variants configured yields only baselines", () => {
  withEnv({ DICTEX_STT_BENCHMARK_MODELS: "base", DICTEX_STT_PROMPT_VARIANTS: undefined, DICTEX_VOSK_BENCHMARK_MODELS: "" }, () => {
    const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME]);
    assert.deepEqual(catalog, [
      { stage: "stt", provider: FASTER_WHISPER_PROVIDER, model: "base", variant: "cpu-int8-fr", runtime: RUNTIME },
    ]);
  });
});

test("buildSttBenchmarkCandidateCatalog: baseline and multiple prompt variants of the same model can coexist", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: "base",
      DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "v-fr-math": "math", "v-fr-physics": "physics" }),
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME]);
      const keys = catalog.map((candidate) => candidateIdentityKey(candidate));
      assert.deepEqual(keys, [
        "stt/faster-whisper/base/cpu-int8-fr",
        "stt/faster-whisper/base/cpu-int8-fr+v-fr-math",
        "stt/faster-whisper/base/cpu-int8-fr+v-fr-physics",
      ]);
      // Three distinct candidates for the same model — the exact #94 acceptance
      // requirement (baseline + 2 variants of the same faster-whisper model).
      assert.equal(new Set(keys).size, 3);
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: a locally-defined prompt variant (issue #121) becomes a new candidate under every faster-whisper model, carrying its prompt text", () => {
  withEnv(
    { DICTEX_STT_BENCHMARK_MODELS: "base,small", DICTEX_STT_PROMPT_VARIANTS: undefined, DICTEX_VOSK_BENCHMARK_MODELS: "" },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME], [
        { name: "local-v1", displayName: "Local variant", promptText: "local prompt text", createdAt: null },
      ]);
      const localCandidates = catalog.filter((candidate) => candidate.promptVariant === "local-v1");
      assert.equal(localCandidates.length, 2); // one per faster-whisper model
      for (const candidate of localCandidates) {
        assert.equal(candidate.promptText, "local prompt text");
        assert.equal(candidate.promptDisplayName, "Local variant");
      }
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: a local variant whose id collides with an external one is excluded — the external definition keeps the identity", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: "base",
      DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ collide: "external text" }),
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME], [
        { name: "collide", displayName: "Local", promptText: "local text", createdAt: null },
      ]);
      const matching = catalog.filter((candidate) => candidate.promptVariant === "collide");
      assert.equal(matching.length, 1); // one candidate, not two
      assert.equal(matching[0].promptText, undefined); // the external definition, resolved by the sidecar's own env read
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: two additional faster-whisper models appear without renderer changes", () => {
  withEnv(
    { DICTEX_STT_BENCHMARK_MODELS: "base,small,large-v3-turbo", DICTEX_STT_PROMPT_VARIANTS: undefined, DICTEX_VOSK_BENCHMARK_MODELS: "" },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME]);
      assert.deepEqual(
        catalog.map((candidate) => candidate.model),
        ["base", "small", "large-v3-turbo"],
      );
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: Vosk never gets a prompt-variant candidate", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: "base",
      DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "v-fr-math": "math" }),
      DICTEX_VOSK_BENCHMARK_MODELS: "vosk-model-small-fr-0.22",
    },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([RUNTIME]);
      const voskCandidates = catalog.filter((candidate) => candidate.provider === VOSK_PROVIDER);
      assert.deepEqual(voskCandidates, [
        {
          stage: "stt",
          provider: VOSK_PROVIDER,
          model: "vosk-model-small-fr-0.22",
          variant: "cpu-fr",
          runtime: { device: "cpu", computeType: "int8", language: "fr" },
        },
      ]);
      assert.ok(voskCandidates.every((candidate) => candidate.promptVariant === undefined));
    },
  );
});

test("toCandidateOption: baseline gets a friendly 'baseline' label, not a technical variant string", () => {
  const option = toCandidateOption({
    stage: "stt",
    provider: FASTER_WHISPER_PROVIDER,
    model: "base",
    variant: "cpu-int8-fr",
    runtime: RUNTIME,
  });
  assert.equal(option.providerLabel, FASTER_WHISPER_PROVIDER);
  assert.equal(option.modelLabel, "base");
  assert.equal(option.variantLabel, "baseline");
});

test("toCandidateOption: a prompt variant is labelled by its name, not the raw runtime+prompt string", () => {
  const option = toCandidateOption({
    stage: "stt",
    provider: FASTER_WHISPER_PROVIDER,
    model: "base",
    variant: "cpu-int8-fr+v-fr-math",
    runtime: RUNTIME,
    promptVariant: "v-fr-math",
  });
  assert.equal(option.variantLabel, "v-fr-math");
});

test("toCandidateOption (issue #126): a baseline exposes its runtime, no prompt text, and prompt support", () => {
  const option = toCandidateOption({
    stage: "stt",
    provider: FASTER_WHISPER_PROVIDER,
    model: "base",
    variant: "cpu-int8-fr",
    runtime: RUNTIME,
  });
  assert.equal(option.runtimeLabel, "cpu-int8-fr");
  assert.equal(option.promptText, null);
  assert.equal(option.supportsPrompt, true);
});

test("toCandidateOption (issue #126): a prompt variant strips the prompt suffix off the runtime and carries its display text", () => {
  const option = toCandidateOption({
    stage: "stt",
    provider: FASTER_WHISPER_PROVIDER,
    model: "base",
    variant: "cpu-int8-fr+v-fr-math",
    runtime: RUNTIME,
    promptVariant: "v-fr-math",
    displayPromptText: "Dictée mathématique",
  });
  assert.equal(option.runtimeLabel, "cpu-int8-fr");
  assert.equal(option.promptText, "Dictée mathématique");
  assert.equal(option.supportsPrompt, true);
});

test("toCandidateOption (issue #126): a Vosk candidate never supports a prompt", () => {
  const option = toCandidateOption({
    stage: "stt",
    provider: VOSK_PROVIDER,
    model: "vosk-model-small-fr-0.22",
    variant: "cpu-fr",
    runtime: { device: "cpu", computeType: "int8", language: "fr" },
  });
  assert.equal(option.runtimeLabel, "cpu-fr");
  assert.equal(option.promptText, null);
  assert.equal(option.supportsPrompt, false);
});

test("buildSttBenchmarkCandidateCatalog + toCandidateOption (issue #126): an external prompt variant carries display text for read-only view without a local promptText", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: "base",
      DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "v-fr-math": "external math prompt" }),
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      const config = buildSttBenchmarkCandidateCatalog([RUNTIME]).find(
        (candidate) => candidate.promptVariant === "v-fr-math",
      );
      assert.ok(config);
      // Display text is present, but promptText (which would change the sidecar's
      // inherited env path) stays absent for an external variant.
      assert.equal(config.displayPromptText, "external math prompt");
      assert.equal(config.promptText, undefined);
      assert.equal(toCandidateOption(config).promptText, "external math prompt");
    },
  );
});

test("validateRequestedCandidates: accepts 1 to 3 identities that match the catalog exactly", () => {
  const catalog = buildCatalogFor("base,small", { "v-fr-math": "math" });
  const requested = [
    { stage: "stt", provider: FASTER_WHISPER_PROVIDER, model: "base", variant: "cpu-int8-fr" },
    { stage: "stt", provider: FASTER_WHISPER_PROVIDER, model: "base", variant: "cpu-int8-fr+v-fr-math" },
  ];
  const matched = validateRequestedCandidates(requested, catalog);
  assert.equal(matched.length, 2);
  assert.equal(matched[1].promptVariant, "v-fr-math");
});

test("validateRequestedCandidates: rejects 0 or more than 3 candidates", () => {
  const catalog = buildCatalogFor("base", undefined);
  assert.throws(() => validateRequestedCandidates([], catalog));
  const four = catalog.length > 0 ? [catalog[0], catalog[0], catalog[0], catalog[0]] : [];
  assert.throws(() => validateRequestedCandidates(four, catalog));
});

test("validateRequestedCandidates: rejects a candidate identity absent from the catalog", () => {
  const catalog = buildCatalogFor("base", undefined);
  assert.throws(() =>
    validateRequestedCandidates(
      [{ stage: "stt", provider: FASTER_WHISPER_PROVIDER, model: "unknown-model", variant: "cpu-int8-fr" }],
      catalog,
    ),
  );
});

test("validateRequestedCandidates: rejects a malformed request shape", () => {
  const catalog = buildCatalogFor("base", undefined);
  assert.throws(() => validateRequestedCandidates("not-an-array", catalog));
  assert.throws(() => validateRequestedCandidates([{ provider: FASTER_WHISPER_PROVIDER }], catalog));
});

// ---- issue #131: multiple runtimes per model ----

test("parseSttBenchmarkRuntimes: parses a list of device:compute_type pairs, normalizing whitespace", () => {
  assert.deepEqual(parseSttBenchmarkRuntimes(" cpu:int8 , cpu:int16 ,cuda:float16, cuda:int8_float16 "), [
    { device: "cpu", computeType: "int8" },
    { device: "cpu", computeType: "int16" },
    { device: "cuda", computeType: "float16" },
    { device: "cuda", computeType: "int8_float16" },
  ]);
});

test("parseSttBenchmarkRuntimes: drops exact duplicates and tolerates stray separators", () => {
  assert.deepEqual(parseSttBenchmarkRuntimes("cpu:int8,cpu:int8, ,cuda:float16,"), [
    { device: "cpu", computeType: "int8" },
    { device: "cuda", computeType: "float16" },
  ]);
});

test("parseSttBenchmarkRuntimes: a malformed entry throws with an actionable diagnostic, never silently skipped", () => {
  assert.throws(() => parseSttBenchmarkRuntimes("cpu:int8,cudafloat16"), /device:compute_type/);
  assert.throws(() => parseSttBenchmarkRuntimes("cpu:"), /non-empty/);
  assert.throws(() => parseSttBenchmarkRuntimes(":int8"), /non-empty/);
  assert.throws(() => parseSttBenchmarkRuntimes("cpu:int8:extra"), /device:compute_type/);
  // A value made only of separators has no runtime at all.
  assert.throws(() => parseSttBenchmarkRuntimes(", ,"), /no runtime found/);
});

test("parseSttBenchmarkRuntimes: rejects auto/default as a benchmark identity", () => {
  assert.throws(() => parseSttBenchmarkRuntimes("cuda:auto"), /not allowed/);
  assert.throws(() => parseSttBenchmarkRuntimes("auto:int8"), /not allowed/);
  assert.throws(() => parseSttBenchmarkRuntimes("cpu:DEFAULT"), /not allowed/);
});

test("getSttBenchmarkRuntimes: an absent variable reproduces the historical single runtime from DICTEX_STT_DEVICE/COMPUTE_TYPE", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_RUNTIMES: undefined,
      DICTEX_STT_DEVICE: "cuda",
      DICTEX_STT_COMPUTE_TYPE: "float16",
      DICTEX_STT_LANGUAGE: "fr",
    },
    () => {
      assert.deepEqual(getSttBenchmarkRuntimes(), [{ device: "cuda", computeType: "float16", language: "fr" }]);
    },
  );
});

test("getSttBenchmarkRuntimes: a blank variable also falls back to the single historical runtime", () => {
  withEnv(
    { DICTEX_STT_BENCHMARK_RUNTIMES: "   ", DICTEX_STT_DEVICE: undefined, DICTEX_STT_COMPUTE_TYPE: undefined, DICTEX_STT_LANGUAGE: undefined },
    () => {
      assert.deepEqual(getSttBenchmarkRuntimes(), [{ device: "cpu", computeType: "int8", language: "fr" }]);
    },
  );
});

test("getSttBenchmarkRuntimes: the configured runtimes each carry the single global language", () => {
  withEnv(
    { DICTEX_STT_BENCHMARK_RUNTIMES: "cpu:int8,cuda:float16", DICTEX_STT_LANGUAGE: "en" },
    () => {
      assert.deepEqual(getSttBenchmarkRuntimes(), [
        { device: "cpu", computeType: "int8", language: "en" },
        { device: "cuda", computeType: "float16", language: "en" },
      ]);
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: builds the cartesian product model × runtime × (baseline + prompt variants)", () => {
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: "large-v3-turbo",
      DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "v-fr-math": "math" }),
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      const runtimes = [
        { device: "cpu", computeType: "int8", language: "fr" },
        { device: "cuda", computeType: "float16", language: "fr" },
        { device: "cuda", computeType: "int8_float16", language: "fr" },
      ];
      const catalog = buildSttBenchmarkCandidateCatalog(runtimes);
      // Three baselines + three prompt declensions for the one model.
      assert.deepEqual(
        catalog.map((candidate) => candidate.variant),
        [
          "cpu-int8-fr",
          "cpu-int8-fr+v-fr-math",
          "cuda-float16-fr",
          "cuda-float16-fr+v-fr-math",
          "cuda-int8_float16-fr",
          "cuda-int8_float16-fr+v-fr-math",
        ],
      );
      // Each candidate carries its own structured runtime, matching its identity.
      for (const candidate of catalog) {
        assert.equal(candidate.variant?.startsWith(`${candidate.runtime.device}-${candidate.runtime.computeType}-`), true);
      }
      // A baseline and a prompt variant of the same runtime share the runtime and
      // differ only by the prompt.
      const cpuBaseline = catalog.find((c) => c.variant === "cpu-int8-fr");
      const cpuPrompt = catalog.find((c) => c.variant === "cpu-int8-fr+v-fr-math");
      assert.deepEqual(cpuBaseline?.runtime, cpuPrompt?.runtime);
      assert.equal(cpuPrompt?.promptVariant, "v-fr-math");
    },
  );
});

test("buildSttBenchmarkCandidateCatalog: two runtimes of the same model are distinct, selectable candidates", () => {
  withEnv({ DICTEX_STT_BENCHMARK_MODELS: "large-v3-turbo", DICTEX_STT_PROMPT_VARIANTS: undefined, DICTEX_VOSK_BENCHMARK_MODELS: "" }, () => {
    const catalog = buildSttBenchmarkCandidateCatalog([
      { device: "cpu", computeType: "int8", language: "fr" },
      { device: "cuda", computeType: "float16", language: "fr" },
    ]);
    const keys = catalog.map(candidateIdentityKey);
    assert.deepEqual(keys, [
      "stt/faster-whisper/large-v3-turbo/cpu-int8-fr",
      "stt/faster-whisper/large-v3-turbo/cuda-float16-fr",
    ]);
    // Both can be validated together in the same run (the #131 acceptance).
    const matched = validateRequestedCandidates(
      catalog.map((c) => ({ stage: c.stage, provider: c.provider, model: c.model, variant: c.variant })),
      catalog,
    );
    assert.equal(matched.length, 2);
  });
});

test("buildSttBenchmarkCandidateCatalog: Vosk keeps a single CPU identity, not multiplied by the runtimes", () => {
  withEnv(
    { DICTEX_STT_BENCHMARK_MODELS: "base", DICTEX_STT_PROMPT_VARIANTS: undefined, DICTEX_VOSK_BENCHMARK_MODELS: "vosk-model-small-fr-0.22" },
    () => {
      const catalog = buildSttBenchmarkCandidateCatalog([
        { device: "cpu", computeType: "int8", language: "fr" },
        { device: "cuda", computeType: "float16", language: "fr" },
      ]);
      const vosk = catalog.filter((c) => c.provider === VOSK_PROVIDER);
      assert.equal(vosk.length, 1);
      assert.equal(vosk[0].variant, "cpu-fr");
      assert.equal(vosk[0].promptVariant, undefined);
      assert.deepEqual(vosk[0].runtime, { device: "cpu", computeType: "int8", language: "fr" });
    },
  );
});

test("buildSttConfigForCandidate: the sidecar config comes from the candidate's runtime, not a global one", () => {
  const candidate = {
    stage: "stt" as const,
    provider: FASTER_WHISPER_PROVIDER,
    model: "large-v3-turbo",
    variant: "cuda-float16-fr",
    runtime: { device: "cuda", computeType: "float16", language: "fr" },
  };
  // A different ambient global must not leak into the built config.
  withEnv({ DICTEX_STT_DEVICE: "cpu", DICTEX_STT_COMPUTE_TYPE: "int8", DICTEX_STT_LANGUAGE: "en" }, () => {
    const config = buildSttConfigForCandidate(candidate);
    assert.equal(config.engine, FASTER_WHISPER_PROVIDER);
    assert.equal(config.model, "large-v3-turbo");
    assert.equal(config.device, "cuda");
    assert.equal(config.computeType, "float16");
    assert.equal(config.language, "fr");
    assert.equal(config.promptVariant, undefined);
  });
});

test("buildSttConfigForCandidate: a prompt variant threads its name and local text through unchanged", () => {
  const config = buildSttConfigForCandidate({
    stage: "stt",
    provider: FASTER_WHISPER_PROVIDER,
    model: "base",
    variant: "cpu-int8-fr+v-fr-math",
    runtime: { device: "cpu", computeType: "int8", language: "fr" },
    promptVariant: "v-fr-math",
    promptText: "local prompt",
  });
  assert.equal(config.promptVariant, "v-fr-math");
  assert.equal(config.promptText, "local prompt");
});

function buildCatalogFor(models: string, promptVariants: Record<string, string> | undefined) {
  let catalog: ReturnType<typeof buildSttBenchmarkCandidateCatalog> = [];
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: models,
      DICTEX_STT_PROMPT_VARIANTS: promptVariants ? JSON.stringify(promptVariants) : undefined,
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      catalog = buildSttBenchmarkCandidateCatalog([RUNTIME]);
    },
  );
  return catalog;
}
