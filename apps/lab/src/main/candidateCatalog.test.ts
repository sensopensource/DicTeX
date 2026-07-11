import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSttBenchmarkCandidateCatalog,
  candidateIdentityKey,
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
    const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME);
    assert.deepEqual(catalog, [
      { stage: "stt", provider: FASTER_WHISPER_PROVIDER, model: "base", variant: "cpu-int8-fr" },
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
      const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME);
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
      const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME, [
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
      const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME, [
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
      const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME);
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
      const catalog = buildSttBenchmarkCandidateCatalog(RUNTIME);
      const voskCandidates = catalog.filter((candidate) => candidate.provider === VOSK_PROVIDER);
      assert.deepEqual(voskCandidates, [
        { stage: "stt", provider: VOSK_PROVIDER, model: "vosk-model-small-fr-0.22", variant: "cpu-fr" },
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
    promptVariant: "v-fr-math",
  });
  assert.equal(option.variantLabel, "v-fr-math");
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

function buildCatalogFor(models: string, promptVariants: Record<string, string> | undefined) {
  let catalog: ReturnType<typeof buildSttBenchmarkCandidateCatalog> = [];
  withEnv(
    {
      DICTEX_STT_BENCHMARK_MODELS: models,
      DICTEX_STT_PROMPT_VARIANTS: promptVariants ? JSON.stringify(promptVariants) : undefined,
      DICTEX_VOSK_BENCHMARK_MODELS: "",
    },
    () => {
      catalog = buildSttBenchmarkCandidateCatalog(RUNTIME);
    },
  );
  return catalog;
}
