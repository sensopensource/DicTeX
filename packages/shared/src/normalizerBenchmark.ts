import { restoreCommandWords } from "./commands.js";
import type {
  BenchmarkCandidateRecord,
  BenchmarkMathTransformRunProjection,
} from "./benchmarkContract.js";
import type { NormalizationLayerOutput, NormalizationResult } from "./normalizer.js";
import type { NormalizerOperationTrace, NormalizerPipelineSnapshot } from "./normalizer.js";
import type { NormalizerRulesMode } from "./normalizer.js";

export const NORMALIZER_BENCHMARK_DISPLAY_NAME = "Current deterministic pipeline";

export type NormalizerPipelineVersion = {
  dictionaryHash: string;
  rulesHash: string;
  pipelineContractVersion?: number;
  semanticVersion?: string;
  commandTableHash?: string;
  latexCanonicalizationContractVersion?: number;
  bundledRulesVersion?: number;
  bundledRulesHash?: string;
  rulesMode?: NormalizerRulesMode;
  overlayHash?: string | null;
  localRulesHash?: string | null;
};

export type NormalizerBenchmarkPipelineSnapshot = NormalizerPipelineSnapshot & {
  candidate: BenchmarkCandidateRecord<"math_transform">;
};

export type NormalizerBenchmarkCandidate = {
  candidate: BenchmarkCandidateRecord<"math_transform">;
  displayName: typeof NORMALIZER_BENCHMARK_DISPLAY_NAME;
  version: NormalizerPipelineVersion;
};

export type StoredNormalizerBenchmarkResult = {
  outputTranscript: string;
  layers: NormalizationLayerOutput[];
  operations: NormalizerOperationTrace[];
};

export type NormalizerBenchmarkCandidateSummary = {
  candidate: BenchmarkCandidateRecord<"math_transform">;
  total: number;
  done: number;
  exactMatches: number;
  failed: number;
  missing: number;
  meanTransformationDurationMs: number | null;
};

const NORMALIZER_VARIANT_PATTERN = /^dictionary-sha256:([0-9a-f]{64});rules-sha256:([0-9a-f]{64})$/;
const NORMALIZER_VARIANT_V2_PATTERN =
  /^pipeline-contract:(\d+);semantic:([^;]+);commands-sha256:([0-9a-f]{64});latex-contract:(\d+);dictionary-sha256:([0-9a-f]{64});rules-sha256:([0-9a-f]{64})$/;
const NORMALIZER_VARIANT_V3_PATTERN =
  /^pipeline-contract:(\d+);semantic:([^;]+);commands-sha256:([0-9a-f]{64});latex-contract:(\d+);bundled-rules-version:(\d+);bundled-rules-sha256:([0-9a-f]{64});rules-mode:(bundled|overlay|legacy);overlay-sha256:(none|[0-9a-f]{64});local-rules-sha256:(none|[0-9a-f]{64});dictionary-sha256:([0-9a-f]{64});rules-sha256:([0-9a-f]{64})$/;

export function buildNormalizerBenchmarkCandidate(
  version: NormalizerPipelineVersion,
): NormalizerBenchmarkCandidate {
  assertFullSha256(version.dictionaryHash, "dictionary");
  assertFullSha256(version.rulesHash, "rules");
  const hasDetailedIdentity =
    version.pipelineContractVersion !== undefined &&
    version.semanticVersion !== undefined &&
    version.commandTableHash !== undefined &&
    version.latexCanonicalizationContractVersion !== undefined;
  if (version.commandTableHash !== undefined) {
    assertFullSha256(version.commandTableHash, "command table");
  }
  if (version.bundledRulesHash !== undefined) {
    assertFullSha256(version.bundledRulesHash, "bundled rules");
  }
  if (version.overlayHash !== undefined && version.overlayHash !== null) {
    assertFullSha256(version.overlayHash, "rules overlay");
  }
  if (version.localRulesHash !== undefined && version.localRulesHash !== null) {
    assertFullSha256(version.localRulesHash, "local rules source");
  }
  const hasRulesProvenance =
    hasDetailedIdentity &&
    version.bundledRulesVersion !== undefined &&
    version.bundledRulesHash !== undefined &&
    version.rulesMode !== undefined &&
    version.overlayHash !== undefined &&
    version.localRulesHash !== undefined;
  const variant = hasRulesProvenance
    ? `pipeline-contract:${version.pipelineContractVersion};semantic:${version.semanticVersion};` +
      `commands-sha256:${version.commandTableHash};latex-contract:${version.latexCanonicalizationContractVersion};` +
      `bundled-rules-version:${version.bundledRulesVersion};bundled-rules-sha256:${version.bundledRulesHash};` +
      `rules-mode:${version.rulesMode};overlay-sha256:${version.overlayHash ?? "none"};` +
      `local-rules-sha256:${version.localRulesHash ?? "none"};` +
      `dictionary-sha256:${version.dictionaryHash};rules-sha256:${version.rulesHash}`
    : hasDetailedIdentity
    ? `pipeline-contract:${version.pipelineContractVersion};semantic:${version.semanticVersion};` +
      `commands-sha256:${version.commandTableHash};latex-contract:${version.latexCanonicalizationContractVersion};` +
      `dictionary-sha256:${version.dictionaryHash};rules-sha256:${version.rulesHash}`
    : `dictionary-sha256:${version.dictionaryHash};rules-sha256:${version.rulesHash}`;
  return {
    candidate: {
      stage: "math_transform",
      provider: "dictex",
      model: "deterministic-pipeline",
      variant,
    },
    displayName: NORMALIZER_BENCHMARK_DISPLAY_NAME,
    version,
  };
}

export function parseNormalizerBenchmarkVariant(variant: string | null): NormalizerPipelineVersion | null {
  if (variant === null) {
    return null;
  }
  const current = NORMALIZER_VARIANT_V3_PATTERN.exec(variant);
  if (current) {
    return {
      pipelineContractVersion: Number(current[1]),
      semanticVersion: current[2],
      commandTableHash: current[3],
      latexCanonicalizationContractVersion: Number(current[4]),
      bundledRulesVersion: Number(current[5]),
      bundledRulesHash: current[6],
      rulesMode: current[7] as NormalizerRulesMode,
      overlayHash: current[8] === "none" ? null : current[8],
      localRulesHash: current[9] === "none" ? null : current[9],
      dictionaryHash: current[10],
      rulesHash: current[11],
    };
  }
  const modern = NORMALIZER_VARIANT_V2_PATTERN.exec(variant);
  if (modern) {
    return {
      pipelineContractVersion: Number(modern[1]),
      semanticVersion: modern[2],
      commandTableHash: modern[3],
      latexCanonicalizationContractVersion: Number(modern[4]),
      dictionaryHash: modern[5],
      rulesHash: modern[6],
    };
  }
  const match = NORMALIZER_VARIANT_PATTERN.exec(variant);
  return match ? { dictionaryHash: match[1], rulesHash: match[2] } : null;
}

export function buildNormalizerBenchmarkPipelineSnapshot(
  pipelineSnapshot: NormalizerPipelineSnapshot,
  version: NormalizerPipelineVersion,
): NormalizerBenchmarkPipelineSnapshot {
  return {
    ...escapePipelineSnapshotForStorage(pipelineSnapshot),
    candidate: buildNormalizerBenchmarkCandidate(version).candidate,
  };
}

export function sameNormalizerBenchmarkCandidate(
  left: BenchmarkCandidateRecord<"math_transform">,
  right: BenchmarkCandidateRecord<"math_transform">,
): boolean {
  return (
    left.stage === right.stage &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.variant === right.variant
  );
}

/**
 * Converts the pipeline output and every layer trace back to canonical spoken
 * command words. The append-only benchmark store therefore never receives a
 * PUA sentinel, while the rules still ran on the exact production pipeline.
 */
export function prepareNormalizerBenchmarkResultForStorage(
  result: NormalizationResult,
): StoredNormalizerBenchmarkResult {
  return {
    outputTranscript: restoreCommandWords(result.output),
    layers: result.layers.map((layer) => ({
      ...layer,
      input: restoreCommandWords(layer.input),
      output: restoreCommandWords(layer.output),
      diagnostics: layer.diagnostics.map(restoreCommandWords),
    })),
    operations: (result.operations ?? []).map((operation) => ({
      ...operation,
      ...(operation.operation === "command"
        ? { debug_label: restoreCommandWords(operation.debug_label) }
        : {}),
      occurrences: operation.occurrences.map((occurrence) => ({
        ...occurrence,
        matched_text: restoreCommandWords(occurrence.matched_text),
        ...(occurrence.replacement_text === undefined
          ? {}
          : { replacement_text: restoreCommandWords(occurrence.replacement_text) }),
      })),
    })),
  };
}

export function summarizeNormalizerBenchmarkRun(
  run: BenchmarkMathTransformRunProjection,
): NormalizerBenchmarkCandidateSummary[] {
  return run.candidates.map((candidate, candidateIndex) => {
    let done = 0;
    let exactMatches = 0;
    let failed = 0;
    let missing = 0;
    const durations: number[] = [];

    for (const member of run.members) {
      const outcome = member.outcomes[candidateIndex];
      if (!outcome) {
        missing += 1;
        continue;
      }
      if (outcome.status === "failed") {
        failed += 1;
        continue;
      }
      if (outcome.status === "missing") {
        missing += 1;
        continue;
      }
      done += 1;
      if (outcome.result?.score.value) {
        exactMatches += 1;
      }
      if (outcome.result?.transformationDurationMs !== null && outcome.result?.transformationDurationMs !== undefined) {
        durations.push(outcome.result.transformationDurationMs);
      }
    }

    return {
      candidate,
      total: run.members.length,
      done,
      exactMatches,
      failed,
      missing,
      meanTransformationDurationMs:
        durations.length === 0 ? null : durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    };
  });
}

function assertFullSha256(value: string, source: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${source} hash must be a full lowercase SHA-256`);
  }
}

function escapePipelineSnapshotForStorage(snapshot: NormalizerPipelineSnapshot): NormalizerPipelineSnapshot {
  return mapSnapshotValue(snapshot) as NormalizerPipelineSnapshot;
}

function mapSnapshotValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[\uE000-\uF8FF]/gu, (character) =>
      `\\u${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) {
    return value.map(mapSnapshotValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapSnapshotValue(entry)]));
  }
  return value;
}
