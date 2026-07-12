import {
  getSttBenchmarkModels,
  getSttPromptVariants,
  buildSttVariantId,
  type BenchmarkCandidate,
  type BenchmarkCandidateIdentity,
  type SttConfig,
  type SttPromptVariantDefinition,
} from "@dictex/shared";
import { usableLocalPromptVariants } from "./promptVariants.js";

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

const DEFAULT_DEVICE = "cpu";
const DEFAULT_COMPUTE_TYPE = "int8";
const DEFAULT_LANGUAGE = "fr";

// `auto`/`default` are refused as a benchmark runtime (issue #131): a
// reproducible candidate must announce an explicit device and compute type,
// never let CTranslate2 pick or implicitly convert one behind its identity —
// a candidate labelled `cuda-float16-fr` must actually run float16.
const FORBIDDEN_RUNTIME_TOKENS = new Set(["auto", "default"]);

export type SttRuntimeConfig = {
  device: string;
  computeType: string;
  language: string;
};

/** A device/compute-type pair parsed from `DICTEX_STT_BENCHMARK_RUNTIMES`. */
export type SttBenchmarkRuntimePair = {
  device: string;
  computeType: string;
};

/**
 * Parses `DICTEX_STT_BENCHMARK_RUNTIMES` — a comma-separated list of
 * `device:compute_type` pairs, e.g.
 * `cpu:int8,cpu:int16,cuda:float16,cuda:int8_float16`. Whitespace around
 * separators and inside pairs is normalized and exact duplicates are dropped,
 * but a non-empty malformed entry throws with an actionable message rather than
 * being silently skipped or guessed (issue #131 acceptance). Pure: it takes the
 * raw string and never reads the environment, so it is directly unit-testable.
 */
export function parseSttBenchmarkRuntimes(raw: string): SttBenchmarkRuntimePair[] {
  const pairs: SttBenchmarkRuntimePair[] = [];
  const seen = new Set<string>();
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      // Tolerate stray/trailing separators (e.g. "cpu:int8,"), the same leniency
      // as the comma-separated model list; only a non-empty malformed entry is
      // an error.
      continue;
    }
    const parts = entry.split(":");
    if (parts.length !== 2) {
      throw new Error(
        `Invalid DICTEX_STT_BENCHMARK_RUNTIMES entry "${entry}": expected "device:compute_type" (e.g. "cuda:float16")`,
      );
    }
    const device = parts[0].trim();
    const computeType = parts[1].trim();
    if (device.length === 0 || computeType.length === 0) {
      throw new Error(
        `Invalid DICTEX_STT_BENCHMARK_RUNTIMES entry "${entry}": both device and compute type must be non-empty, as in "cuda:float16"`,
      );
    }
    for (const token of [device, computeType]) {
      if (FORBIDDEN_RUNTIME_TOKENS.has(token.toLowerCase())) {
        throw new Error(
          `Invalid DICTEX_STT_BENCHMARK_RUNTIMES entry "${entry}": "auto" and "default" are not allowed — a reproducible benchmark candidate must name an explicit device and compute type`,
        );
      }
    }
    const key = `${device}:${computeType}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ device, computeType });
  }
  if (pairs.length === 0) {
    throw new Error(
      `Invalid DICTEX_STT_BENCHMARK_RUNTIMES: no runtime found; expected a comma-separated list of "device:compute_type" pairs, e.g. "cpu:int8,cuda:float16"`,
    );
  }
  return pairs;
}

/**
 * The STT benchmark runtimes the faster-whisper catalog is expanded over
 * (issue #131). Multiple `device:compute_type` pairs from
 * `DICTEX_STT_BENCHMARK_RUNTIMES` let one model be compared across CPU/GPU and
 * compute types within a single run. When that variable is absent (or blank),
 * it falls back to exactly the historical single runtime built from
 * `DICTEX_STT_DEVICE` / `DICTEX_STT_COMPUTE_TYPE`, so the catalog identity is
 * byte-for-byte unchanged. The language stays a single global
 * (`DICTEX_STT_LANGUAGE`), shared by every runtime.
 */
export function getSttBenchmarkRuntimes(): SttRuntimeConfig[] {
  const language = process.env.DICTEX_STT_LANGUAGE || DEFAULT_LANGUAGE;
  const raw = process.env.DICTEX_STT_BENCHMARK_RUNTIMES;
  if (raw === undefined || raw.trim().length === 0) {
    return [
      {
        device: process.env.DICTEX_STT_DEVICE || DEFAULT_DEVICE,
        computeType: process.env.DICTEX_STT_COMPUTE_TYPE || DEFAULT_COMPUTE_TYPE,
        language,
      },
    ];
  }
  return parseSttBenchmarkRuntimes(raw).map((pair) => ({ ...pair, language }));
}

/**
 * One catalog entry: the public candidate identity plus the internal
 * `promptVariant` name needed to configure the sidecar call. Only a
 * faster-whisper candidate ever carries `promptVariant` — Vosk has no prompt
 * concept (docs/product-decisions.md "Second local STT provider (Vosk)").
 */
export type SttBenchmarkCandidateConfig = BenchmarkCandidate & {
  /**
   * Structured runtime (device + compute type + language) this candidate must
   * execute with (issue #131). Carried explicitly so the sidecar call is built
   * from the candidate's OWN runtime, never re-parsed from the `variant` string
   * and never silently replaced by a global runtime: a candidate whose identity
   * reads `cuda-float16-fr` always runs on cuda/float16.
   */
  runtime: SttRuntimeConfig;
  promptVariant?: string;
  /**
   * Prompt text, present only for a LOCALLY-defined variant (issue #121):
   * threaded through to `SttConfig.promptText` so the sidecar can resolve it
   * without the name being present in `DICTEX_STT_PROMPT_VARIANTS`. Absent
   * for an externally-configured variant, which the sidecar resolves from
   * that env var itself.
   */
  promptText?: string;
  /** Human display name for a locally-defined variant (issue #121); absent for an external one (labelled by its raw name, see toCandidateOption). */
  promptDisplayName?: string;
  /**
   * Full prompt text for read-only DISPLAY (issue #126), present for both
   * local AND external prompt-variant candidates. Distinct from `promptText`,
   * which is deliberately local-only because threading an external variant's
   * text through `SttConfig.promptText` would change the inherited
   * `DICTEX_STT_PROMPT_VARIANTS` env path the sidecar resolves for itself.
   * Absent for the no-prompt baseline.
   */
  displayPromptText?: string;
};

/**
 * Renderer-facing catalog entry: friendly labels per dimension instead of the
 * raw technical `variant` string (e.g. `cpu-int8-fr+prompt-v3-fr-math`), so
 * the progressive selector (issue #126) can offer model, runtime variant and
 * prompt as separate choices, and show the selected prompt text read-only,
 * without ever displaying a technical identity or hash as the primary label.
 */
export type SttBenchmarkCandidateOption = {
  candidate: BenchmarkCandidateIdentity;
  providerLabel: string;
  modelLabel: string;
  /** Runtime portion of the identity (device-computeType-language), without any prompt suffix. */
  runtimeLabel: string;
  /** "baseline" or the prompt variant's display name — never the raw variant id/hash. */
  variantLabel: string;
  /** Full prompt text for read-only display; null for the no-prompt baseline. */
  promptText: string | null;
  /** Whether this provider supports an `initial_prompt` at all (false for Vosk). */
  supportsPrompt: boolean;
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
 * plus one candidate per prompt variant (both `DICTEX_STT_PROMPT_VARIANTS`
 * entries and Lab-defined local variants, issue #121) for each configured
 * model, and Vosk's no-prompt candidates. Vosk never gets a prompt-variant
 * candidate (`SUPPORTS_INITIAL_PROMPT` is faster-whisper-only in the
 * sidecar, see docs/development.md). `localPromptVariants` is read by the
 * caller (it needs the Lab's own event log) and passed in so this function
 * itself stays synchronous and easily unit-testable.
 *
 * The catalog is the cartesian product model × runtime × (baseline + prompt
 * variants) (issue #131): every configured `runtimes` entry becomes its own set
 * of candidates for each faster-whisper model, each carrying its structured
 * runtime and a distinct `variant` identity. Vosk is CPU-only with no
 * compute-type dimension, so it is NOT multiplied by the runtimes — one
 * candidate per Vosk model, keeping its historical `cpu-<language>` identity.
 */
export function buildSttBenchmarkCandidateCatalog(
  runtimes: SttRuntimeConfig[],
  localPromptVariants: SttPromptVariantDefinition[] = [],
): SttBenchmarkCandidateConfig[] {
  const externalVariants = getSttPromptVariants();
  // A local definition never overrides an external one of the same name —
  // this only matters if the env table changed after the local variant was
  // created, since creation itself already rejects a name already in use.
  const localVariants = usableLocalPromptVariants(localPromptVariants, externalVariants);
  const promptVariantEntries: {
    name: string;
    promptText?: string;
    displayName?: string;
    displayPromptText: string;
  }[] = [
    // External variants carry a display text (for the read-only prompt view,
    // #126) but NOT `promptText` — the sidecar resolves them from its own
    // inherited env table, so threading their text through would change that
    // path.
    ...Object.entries(externalVariants).map(([name, text]) => ({ name, displayPromptText: text })),
    ...localVariants.map((variant) => ({
      name: variant.name,
      promptText: variant.promptText,
      displayName: variant.displayName,
      displayPromptText: variant.promptText,
    })),
  ];
  const fasterWhisperModels = getSttBenchmarkModels();

  const fasterWhisper: SttBenchmarkCandidateConfig[] = [];
  // Model outer, runtime inner: all of a model's candidates stay contiguous
  // (the renderer groups by model), and runtimes keep their configured order.
  for (const model of fasterWhisperModels) {
    for (const runtime of runtimes) {
      fasterWhisper.push({
        stage: "stt",
        provider: FASTER_WHISPER_PROVIDER,
        model,
        variant: buildSttVariantId(runtime),
        runtime,
      });
      for (const entry of promptVariantEntries) {
        fasterWhisper.push({
          stage: "stt",
          provider: FASTER_WHISPER_PROVIDER,
          model,
          variant: buildSttVariantId(runtime, entry.name),
          runtime,
          promptVariant: entry.name,
          promptText: entry.promptText,
          promptDisplayName: entry.displayName,
          displayPromptText: entry.displayPromptText,
        });
      }
    }
  }

  // Vosk is CPU-only and has no compute-type dimension, so its variant only
  // carries the device and language — same shape as the pre-#94 baseline — and
  // it is not multiplied by the faster-whisper runtimes. Its structured runtime
  // is honestly CPU; the compute type is irrelevant to Vosk (the provider
  // ignores it) but kept explicit so execution never reaches back to a global
  // config. Language follows the shared global language of the runtimes.
  const language = runtimes[0]?.language ?? DEFAULT_LANGUAGE;
  const voskRuntime: SttRuntimeConfig = { device: DEFAULT_DEVICE, computeType: DEFAULT_COMPUTE_TYPE, language };
  const vosk: SttBenchmarkCandidateConfig[] = getVoskBenchmarkModels().map((model) => ({
    stage: "stt",
    provider: VOSK_PROVIDER,
    model,
    variant: `cpu-${language}`,
    runtime: voskRuntime,
  }));

  return [...fasterWhisper, ...vosk];
}

/**
 * Builds the sidecar `SttConfig` for one validated catalog candidate (issue
 * #131). The device, compute type and language come exclusively from the
 * candidate's structured `runtime` — never from a global config, and never by
 * re-parsing the `variant` string — so a candidate's execution can never drift
 * from its advertised identity. The prompt fields are threaded through
 * unchanged (a Vosk candidate carries neither, leaving the no-prompt path
 * identical).
 */
export function buildSttConfigForCandidate(candidate: SttBenchmarkCandidateConfig): SttConfig {
  return {
    engine: candidate.provider,
    model: candidate.model,
    language: candidate.runtime.language,
    device: candidate.runtime.device,
    computeType: candidate.runtime.computeType,
    promptVariant: candidate.promptVariant,
    promptText: candidate.promptText,
  };
}

export function toCandidateOption(candidate: SttBenchmarkCandidateConfig): SttBenchmarkCandidateOption {
  const variant = candidate.variant ?? "";
  // `buildSttVariantId` appends `+<promptVariant>` to the runtime, so strip that
  // suffix back off to recover the runtime portion for its own selector control.
  const suffix = candidate.promptVariant ? `+${candidate.promptVariant}` : "";
  const runtimeLabel = suffix && variant.endsWith(suffix) ? variant.slice(0, -suffix.length) : variant;
  return {
    candidate: {
      stage: candidate.stage,
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant ?? null,
    },
    providerLabel: candidate.provider,
    modelLabel: candidate.model,
    runtimeLabel,
    variantLabel: candidate.promptDisplayName ?? candidate.promptVariant ?? "baseline",
    promptText: candidate.displayPromptText ?? null,
    supportsPrompt: candidate.provider === FASTER_WHISPER_PROVIDER,
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
