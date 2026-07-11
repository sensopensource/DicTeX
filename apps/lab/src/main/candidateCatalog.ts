import {
  getSttBenchmarkModels,
  getSttPromptVariants,
  buildSttVariantId,
  type BenchmarkCandidate,
  type BenchmarkCandidateIdentity,
} from "@dictex/shared";

/**
 * Pure STT benchmark candidate catalog construction (issue #94), extracted
 * from apps/lab/src/main/index.ts so it can be unit-tested without importing
 * electron. Adding a future model, provider, or prompt variant only changes
 * what this module returns; the renderer never hardcodes a candidate list
 * (see docs/development.md "Variantes de contexte initial STT").
 */

export const FASTER_WHISPER_PROVIDER = "faster-whisper";
export const VOSK_PROVIDER = "vosk";
const DEFAULT_VOSK_BENCHMARK_MODELS = ["vosk-model-small-fr-0.22"];

export type SttRuntimeConfig = {
  device: string;
  computeType: string;
  language: string;
};

/**
 * One catalog entry: the public candidate identity plus the internal
 * `promptVariant` name needed to configure the sidecar call. Only a
 * faster-whisper candidate ever carries `promptVariant` — Vosk has no prompt
 * concept (docs/product-decisions.md "Second local STT provider (Vosk)").
 */
export type SttBenchmarkCandidateConfig = BenchmarkCandidate & {
  promptVariant?: string;
};

/**
 * Renderer-facing catalog entry: a friendly label per level instead of the
 * raw technical `variant` string (e.g. `cpu-int8-fr+prompt-v3-fr-math`), so
 * the UI can group by provider then model and distinguish the baseline from
 * a named prompt variant without ever displaying a technical identity as the
 * primary label.
 */
export type SttBenchmarkCandidateOption = {
  candidate: BenchmarkCandidateIdentity;
  providerLabel: string;
  modelLabel: string;
  variantLabel: string;
};

export function getVoskBenchmarkModels(): string[] {
  const envValue = process.env.DICTEX_VOSK_BENCHMARK_MODELS;
  if (envValue === undefined) {
    return DEFAULT_VOSK_BENCHMARK_MODELS;
  }

  const parsed = envValue
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  // An explicitly empty value disables Vosk candidates entirely; a set value
  // replaces the default list.
  return Array.from(new Set(parsed));
}

export function candidateIdentityKey(candidate: { stage: string; provider: string; model: string; variant?: string | null }): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

/**
 * Builds every STT benchmark candidate: faster-whisper's no-prompt baseline
 * plus one candidate per `DICTEX_STT_PROMPT_VARIANTS` entry for each
 * configured model, and Vosk's no-prompt candidates. Vosk never gets a
 * prompt-variant candidate (`SUPPORTS_INITIAL_PROMPT` is faster-whisper-only
 * in the sidecar, see docs/development.md).
 */
export function buildSttBenchmarkCandidateCatalog(runtime: SttRuntimeConfig): SttBenchmarkCandidateConfig[] {
  const promptVariantNames = Object.keys(getSttPromptVariants());
  const fasterWhisperModels = getSttBenchmarkModels();

  const fasterWhisper: SttBenchmarkCandidateConfig[] = [];
  for (const model of fasterWhisperModels) {
    fasterWhisper.push({
      stage: "stt",
      provider: FASTER_WHISPER_PROVIDER,
      model,
      variant: buildSttVariantId(runtime),
    });
    for (const promptVariant of promptVariantNames) {
      fasterWhisper.push({
        stage: "stt",
        provider: FASTER_WHISPER_PROVIDER,
        model,
        variant: buildSttVariantId(runtime, promptVariant),
        promptVariant,
      });
    }
  }

  // Vosk is CPU-only and has no compute-type dimension, so its variant only
  // carries the device and language — same shape as the pre-#94 baseline.
  const vosk: SttBenchmarkCandidateConfig[] = getVoskBenchmarkModels().map((model) => ({
    stage: "stt",
    provider: VOSK_PROVIDER,
    model,
    variant: `cpu-${runtime.language}`,
  }));

  return [...fasterWhisper, ...vosk];
}

export function toCandidateOption(candidate: SttBenchmarkCandidateConfig): SttBenchmarkCandidateOption {
  return {
    candidate: {
      stage: candidate.stage,
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant ?? null,
    },
    providerLabel: candidate.provider,
    modelLabel: candidate.model,
    variantLabel: candidate.promptVariant ?? "baseline",
  };
}

function isCandidateIdentityShape(
  value: unknown,
): value is { stage: string; provider: string; model: string; variant?: string | null } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.stage === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.model === "string" &&
    (candidate.variant === undefined || candidate.variant === null || typeof candidate.variant === "string")
  );
}

/**
 * Validates a renderer-supplied candidate selection (1 to 3 identities)
 * against the server-built catalog and returns the matching catalog entries
 * (with their internal `promptVariant`, if any). An identity must match a
 * catalog entry exactly (stage + provider + model + variant); a stale or
 * forged selection is rejected rather than silently run, and an invalid
 * combination (e.g. a Vosk candidate carrying a prompt variant) can never
 * reach the sidecar because it simply never appears in the catalog.
 */
export function validateRequestedCandidates(
  requested: unknown,
  catalog: SttBenchmarkCandidateConfig[],
): SttBenchmarkCandidateConfig[] {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 3) {
    throw new Error("Select 1 to 3 known STT benchmark candidates");
  }

  const catalogByKey = new Map(catalog.map((entry) => [candidateIdentityKey(entry), entry]));
  const matched: SttBenchmarkCandidateConfig[] = [];

  for (const item of requested) {
    if (!isCandidateIdentityShape(item)) {
      throw new Error("Select 1 to 3 known STT benchmark candidates");
    }
    const match = catalogByKey.get(candidateIdentityKey(item));
    if (!match) {
      throw new Error("Select 1 to 3 known STT benchmark candidates");
    }
    matched.push(match);
  }

  return matched;
}
