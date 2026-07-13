import { containsSentinel } from "./commands.js";
import {
  getBenchmarkRunProjection,
  validateBenchmarkRunStartedEvent,
  type BenchmarkCandidateRecord,
  type BenchmarkMathTransformRunProjection,
} from "./benchmarkContract.js";
import { canonicalizeLatex } from "./latex.js";
import type { LocalEvent, NormalizationLayerRecord } from "./localEvents.js";
import type { NormalizerOperationTrace } from "./normalizer.js";
import {
  parseNormalizerBenchmarkVariant,
  type NormalizerBenchmarkPipelineSnapshot,
} from "./normalizerBenchmark.js";

export const NORMALIZER_BENCHMARK_RUN_EXPORT_SCHEMA_VERSION = 1;
export const NORMALIZER_BENCHMARK_RUN_EXPORT_FILES = {
  manifest: "manifest.json",
  dataset: "dataset.math_transform.jsonl",
  outputs: "outputs.jsonl",
} as const;

export const NORMALIZER_ANALYSIS_TAXONOMY = [
  "dictionary",
  "command",
  "regex_missing",
  "regex_wrong",
  "scope_or_composition",
  "human_target_or_convention",
  "pipeline_diagnostic",
  "execution_failure",
] as const;

export type NormalizerBenchmarkRunExportDatasetRecord = {
  split: string;
  stage: "math_transform";
  session_id: string;
  segment_id: string;
  layer1_input: string;
  layer2_target: string;
  correction_created_at: string | null;
};

export type NormalizerBenchmarkRunExportCandidateOutput = {
  candidate: BenchmarkCandidateRecord<"math_transform">;
  status: "done" | "failed" | "missing";
  error: string | null;
  output_raw: string | null;
  output_canonical: string | null;
  target_canonical: string;
  exact_match: boolean | null;
  transformation_duration_ms: number | null;
  layers: NormalizationLayerRecord[];
  operations: NormalizerOperationTrace[];
};

export type NormalizerBenchmarkRunExportOutputRecord = {
  session_id: string;
  segment_id: string;
  outputs: NormalizerBenchmarkRunExportCandidateOutput[];
};

export type NormalizerBenchmarkRunExportManifest = {
  schema_version: 1;
  export_type: "normalizer_benchmark_run_llm";
  exported_at: string;
  run_id: string;
  run_started_at: string | null;
  run_finished_at: string | null;
  stage: "math_transform";
  dataset_kind: "math_transform";
  split: string;
  completion_status: "done" | "failed";
  status: { done: number; failed: number; missing: number };
  snapshot: {
    source_event: "benchmark_run_started";
    member_count: number;
    order: "run_snapshot";
    dataset_file: "dataset.math_transform.jsonl";
  };
  files: {
    dataset: "dataset.math_transform.jsonl";
    outputs: "outputs.jsonl";
  };
  candidates: BenchmarkCandidateRecord<"math_transform">[];
  pipeline_snapshot: NormalizerBenchmarkPipelineSnapshot;
  scoring: {
    metric: "exact_match_after_canonicalize_latex";
    raw_texts_preserved: true;
    canonical_texts_preserved: true;
    mathematical_equivalence: false;
    description: string;
  };
  scope: {
    flow: "Layer 1 -> Normalizer -> Layer 2";
    excludes: string[];
    known_limitations: string[];
  };
  llm_contract: {
    read_order: ["manifest.json", "dataset.math_transform.jsonl", "outputs.jsonl"];
    join_key: ["session_id", "segment_id"];
    human_target_role: string;
    prediction_role: string;
    trace_semantics: string;
  };
  suggested_analysis_taxonomy: typeof NORMALIZER_ANALYSIS_TAXONOMY;
  privacy: {
    contains_personal_dictionary: boolean;
    uploaded_by_dictex: false;
    warning: string;
  };
};

export type NormalizerBenchmarkRunExport = {
  manifest: NormalizerBenchmarkRunExportManifest;
  dataset: NormalizerBenchmarkRunExportDatasetRecord[];
  outputs: NormalizerBenchmarkRunExportOutputRecord[];
};

export type NormalizerBenchmarkRunExportSummary = {
  exportType: "normalizer_benchmark_run_llm";
  runId: string;
  createdAt: string;
  exportDir: string;
  segmentCount: number;
  candidateCount: number;
  done: number;
  failed: number;
  missingOutputs: number;
  containsPersonalDictionary: boolean;
};

export type NormalizerBenchmarkRunExportValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

/** Build a portable view exclusively from the frozen stage-aware run. */
export function buildNormalizerBenchmarkRunExport(
  events: LocalEvent[],
  runId: string,
  exportedAt: string,
): NormalizerBenchmarkRunExport {
  const projection = getBenchmarkRunProjection(events, runId);
  if (!projection) {
    throw new Error(`Benchmark run not found: ${runId}`);
  }
  if (projection.stage !== "math_transform") {
    throw new Error(`Only math_transform runs use the normalizer LLM export: ${runId}`);
  }
  if (!projection.terminal) {
    throw new Error(`Normalizer benchmark run is not finished: ${runId}`);
  }
  if (!projection.pipelineSnapshot) {
    throw new Error(
      `Normalizer benchmark run ${runId} predates complete pipeline provenance; run the Normalizer benchmark again before exporting`,
    );
  }
  assertProjectionIsExportable(projection);

  const dataset = projection.members.map((member) => ({
    split: projection.split,
    stage: "math_transform" as const,
    session_id: member.sessionId,
    segment_id: member.segmentId,
    layer1_input: member.layer1Input,
    layer2_target: member.layer2Target,
    correction_created_at: member.mathTransformCorrectionCreatedAt,
  }));
  const outputs = projection.members.map((member) => ({
    session_id: member.sessionId,
    segment_id: member.segmentId,
    outputs: member.outcomes.map((outcome): NormalizerBenchmarkRunExportCandidateOutput => {
      const targetCanonical = canonicalizeLatex(member.layer2Target);
      if (outcome.status !== "done" || !outcome.result) {
        return {
          candidate: outcome.candidate,
          status: outcome.status,
          error: outcome.error,
          output_raw: null,
          output_canonical: null,
          target_canonical: targetCanonical,
          exact_match: null,
          transformation_duration_ms: null,
          layers: [],
          operations: [],
        };
      }
      if (outcome.result.operations === null) {
        throw new Error(
          `Normalizer benchmark run ${runId} has a result without detailed operation traces; run the benchmark again before exporting`,
        );
      }
      return {
        candidate: outcome.candidate,
        status: "done",
        error: null,
        output_raw: outcome.result.outputTranscript,
        output_canonical: outcome.result.score.canonicalOutput,
        target_canonical: outcome.result.score.canonicalTarget,
        exact_match: outcome.result.score.value,
        transformation_duration_ms: outcome.result.transformationDurationMs,
        layers: outcome.result.layers,
        operations: outcome.result.operations,
      };
    }),
  }));
  const pipelineSnapshot = projection.pipelineSnapshot;
  const runExport: NormalizerBenchmarkRunExport = {
    manifest: {
      schema_version: NORMALIZER_BENCHMARK_RUN_EXPORT_SCHEMA_VERSION,
      export_type: "normalizer_benchmark_run_llm",
      exported_at: exportedAt,
      run_id: runId,
      run_started_at: projection.createdAt,
      run_finished_at: projection.terminal.createdAt,
      stage: "math_transform",
      dataset_kind: "math_transform",
      split: projection.split,
      completion_status: projection.outcomeCounts.failed > 0 ? "failed" : "done",
      status: {
        done: projection.outcomeCounts.done,
        failed: projection.outcomeCounts.failed,
        missing: projection.outcomeCounts.missing,
      },
      snapshot: {
        source_event: "benchmark_run_started",
        member_count: projection.members.length,
        order: "run_snapshot",
        dataset_file: NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset,
      },
      files: {
        dataset: NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset,
        outputs: NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.outputs,
      },
      candidates: projection.candidates,
      pipeline_snapshot: pipelineSnapshot,
      scoring: {
        metric: "exact_match_after_canonicalize_latex",
        raw_texts_preserved: true,
        canonical_texts_preserved: true,
        mathematical_equivalence: false,
        description:
          "Prediction and frozen human Layer 2 target are compared for exact equality after the versioned canonicalizeLatex pass. No mathematical equivalence is inferred.",
      },
      scope: {
        flow: "Layer 1 -> Normalizer -> Layer 2",
        excludes: ["audio", "STT execution", "end-to-end audio -> STT -> normalizer evaluation"],
        known_limitations: [
          "Regex rules are intentionally local and do not infer mathematical scope, composition or semantic equivalence.",
          "Suggested analysis categories are guidance only; DicTeX does not pre-classify residuals.",
        ],
      },
      llm_contract: {
        read_order: ["manifest.json", "dataset.math_transform.jsonl", "outputs.jsonl"],
        join_key: ["session_id", "segment_id"],
        human_target_role: "layer2_target is the frozen human-authored notation reference",
        prediction_role: "output_raw is the restored deterministic pipeline prediction; output_canonical is used for scoring",
        trace_semantics:
          "layers are ordered pipeline input/output records; operations reference manifest definition ids and contain only per-segment occurrence deltas",
      },
      suggested_analysis_taxonomy: NORMALIZER_ANALYSIS_TAXONOMY,
      privacy: {
        contains_personal_dictionary:
          pipelineSnapshot.dictionary.source_content !== null ||
          pipelineSnapshot.dictionary.effective_entries.length > 0,
        uploaded_by_dictex: false,
        warning:
          "This package contains the effective personal dictionary and may contain dictated personal text. DicTeX does not upload or send it anywhere.",
      },
    },
    dataset,
    outputs,
  };
  const validation = validateNormalizerBenchmarkRunExport(runExport);
  if (!validation.valid) {
    throw new Error(`Cannot build normalizer benchmark export: ${validation.errors.join("; ")}`);
  }
  return runExport;
}

export function validateNormalizerBenchmarkRunExport(
  runExport: unknown,
): NormalizerBenchmarkRunExportValidation {
  const errors: string[] = [];
  if (!isRecord(runExport) || !isRecord(runExport.manifest)) {
    return { valid: false, errors: ["package and manifest must be objects"] };
  }
  const manifest = runExport.manifest;
  if (
    manifest.schema_version !== NORMALIZER_BENCHMARK_RUN_EXPORT_SCHEMA_VERSION ||
    manifest.export_type !== "normalizer_benchmark_run_llm" ||
    manifest.stage !== "math_transform" ||
    manifest.dataset_kind !== "math_transform"
  ) {
    errors.push("manifest identity or schema version is invalid");
  }
  if (
    !isRecord(manifest.files) ||
    manifest.files.dataset !== NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.dataset ||
    manifest.files.outputs !== NORMALIZER_BENCHMARK_RUN_EXPORT_FILES.outputs
  ) {
    errors.push("manifest file names must be the documented relative names");
  }
  const dataset = Array.isArray(runExport.dataset) ? runExport.dataset : [];
  const outputs = Array.isArray(runExport.outputs) ? runExport.outputs : [];
  if (!Array.isArray(runExport.dataset) || !Array.isArray(runExport.outputs)) {
    errors.push("dataset and outputs must be arrays");
  }
  if (dataset.length !== outputs.length) {
    errors.push("dataset and outputs must contain the same number of members");
  }
  if (isRecord(manifest.snapshot) && manifest.snapshot.member_count !== dataset.length) {
    errors.push("manifest snapshot member_count must equal the JSONL record count");
  }
  const syntheticStartValidation = validateBenchmarkRunStartedEvent({
    event_type: "benchmark_run_started",
    run_id: manifest.run_id,
    created_at: manifest.run_started_at,
    stage: "math_transform",
    dataset_kind: "math_transform",
    split: manifest.split,
    candidates: manifest.candidates,
    snapshot: dataset.map((record) =>
      isRecord(record)
        ? {
            stage: "math_transform",
            session_id: record.session_id,
            segment_id: record.segment_id,
            layer1_input: record.layer1_input,
            layer2_target: record.layer2_target,
            math_transform_correction_created_at: record.correction_created_at,
          }
        : record,
    ),
    pipeline_snapshot: manifest.pipeline_snapshot,
  });
  if (!syntheticStartValidation.valid) {
    errors.push(...syntheticStartValidation.errors.map((error) => `manifest pipeline snapshot: ${error}`));
  }
  const seen = new Set<string>();
  dataset.forEach((record, index) => {
    if (!isRecord(record) || typeof record.session_id !== "string" || typeof record.segment_id !== "string") {
      errors.push(`dataset[${index}] has no join key`);
      return;
    }
    const key = `${record.session_id}/${record.segment_id}`;
    if (seen.has(key)) {
      errors.push(`dataset contains duplicate member ${key}`);
    }
    seen.add(key);
    const output = outputs[index];
    if (!isRecord(output) || output.session_id !== record.session_id || output.segment_id !== record.segment_id) {
      errors.push(`outputs[${index}] does not preserve dataset order and join key`);
    }
  });

  const definitionIds = collectDefinitionIds(manifest.pipeline_snapshot);
  if (isRecord(manifest.pipeline_snapshot) && isRecord(manifest.pipeline_snapshot.candidate)) {
    const candidateVariant = typeof manifest.pipeline_snapshot.candidate.variant === "string"
      ? manifest.pipeline_snapshot.candidate.variant
      : null;
    const identity = parseNormalizerBenchmarkVariant(candidateVariant);
    const dictionary = isRecord(manifest.pipeline_snapshot.dictionary)
      ? manifest.pipeline_snapshot.dictionary
      : null;
    const commands = isRecord(manifest.pipeline_snapshot.commands)
      ? manifest.pipeline_snapshot.commands
      : null;
    const rules = isRecord(manifest.pipeline_snapshot.regex_rules)
      ? manifest.pipeline_snapshot.regex_rules
      : null;
    if (
      identity === null ||
      identity.dictionaryHash !== dictionary?.sha256 ||
      identity.rulesHash !== rules?.sha256 ||
      identity.commandTableHash !== commands?.sha256 ||
      identity.pipelineContractVersion !== manifest.pipeline_snapshot.pipeline_contract_version ||
      identity.semanticVersion !== manifest.pipeline_snapshot.semantic_version ||
      identity.latexCanonicalizationContractVersion !==
        manifest.pipeline_snapshot.latex_canonicalization_contract_version
    ) {
      errors.push("pipeline snapshot hashes and semantic versions must match candidate identity");
    }
  }
  const candidates = Array.isArray(manifest.candidates) ? manifest.candidates : [];
  const statusCounts = { done: 0, failed: 0, missing: 0 };
  outputs.forEach((record, recordIndex) => {
    if (!isRecord(record) || !Array.isArray(record.outputs)) {
      errors.push(`outputs[${recordIndex}].outputs must be an array`);
      return;
    }
    if (record.outputs.length !== candidates.length) {
      errors.push(`outputs[${recordIndex}] must contain every frozen candidate exactly once`);
    }
    record.outputs.forEach((candidateOutput, outputIndex) => {
      if (!isRecord(candidateOutput) || !Array.isArray(candidateOutput.operations)) {
        errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] has invalid operations`);
        return;
      }
      if (
        candidateOutput.status !== "done" &&
        candidateOutput.status !== "failed" &&
        candidateOutput.status !== "missing"
      ) {
        errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] has an invalid status`);
      } else {
        statusCounts[candidateOutput.status] += 1;
      }
      if (JSON.stringify(candidateOutput.candidate) !== JSON.stringify(candidates[outputIndex])) {
        errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] candidate order differs from manifest`);
      }
      const datasetRecord = dataset[recordIndex];
      const expectedTarget = isRecord(datasetRecord) && typeof datasetRecord.layer2_target === "string"
        ? canonicalizeLatex(datasetRecord.layer2_target)
        : null;
      if (candidateOutput.target_canonical !== expectedTarget) {
        errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] target is not derived from the frozen dataset`);
      }
      if (candidateOutput.status === "done") {
        if (
          typeof candidateOutput.output_raw !== "string" ||
          typeof candidateOutput.output_canonical !== "string" ||
          typeof candidateOutput.exact_match !== "boolean" ||
          !isNullableNonNegativeNumber(candidateOutput.transformation_duration_ms) ||
          !Array.isArray(candidateOutput.layers)
        ) {
          errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] done payload is incomplete`);
        } else if (
          candidateOutput.output_canonical !== canonicalizeLatex(candidateOutput.output_raw) ||
          candidateOutput.exact_match !== (candidateOutput.output_canonical === candidateOutput.target_canonical)
        ) {
          errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] canonical score is inconsistent`);
        }
      } else if (
        candidateOutput.output_raw !== null ||
        candidateOutput.output_canonical !== null ||
        candidateOutput.exact_match !== null ||
        candidateOutput.transformation_duration_ms !== null ||
        !Array.isArray(candidateOutput.layers) ||
        candidateOutput.layers.length !== 0 ||
        candidateOutput.operations.length !== 0
      ) {
        errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] non-done payload must not invent output data`);
      }
      for (const operation of candidateOutput.operations) {
        if (!isRecord(operation) || typeof operation.definition_id !== "string" || !definitionIds.has(operation.definition_id)) {
          errors.push(`outputs[${recordIndex}].outputs[${outputIndex}] references an unknown definition`);
        }
      }
    });
  });
  if (
    isRecord(manifest.status) &&
    (manifest.status.done !== statusCounts.done ||
      manifest.status.failed !== statusCounts.failed ||
      manifest.status.missing !== statusCounts.missing)
  ) {
    errors.push("manifest status counts must match outputs.jsonl");
  }
  if (containsSentinel(JSON.stringify(runExport)) || /[\uE000-\uF8FF]/u.test(JSON.stringify(runExport))) {
    errors.push("package must not contain a Private Use Area character");
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

/** Parse already-read files and validate their cross-file schema and ordering. */
export function parseNormalizerBenchmarkRunExportFiles(files: {
  manifest: string;
  dataset: string;
  outputs: string;
}): NormalizerBenchmarkRunExport {
  let parsed: NormalizerBenchmarkRunExport;
  try {
    parsed = {
      manifest: JSON.parse(files.manifest) as NormalizerBenchmarkRunExportManifest,
      dataset: parseJsonLines(files.dataset) as NormalizerBenchmarkRunExportDatasetRecord[],
      outputs: parseJsonLines(files.outputs) as NormalizerBenchmarkRunExportOutputRecord[],
    };
  } catch (error) {
    throw new Error(`Invalid normalizer benchmark export JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
  const validation = validateNormalizerBenchmarkRunExport(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid normalizer benchmark export: ${validation.errors.join("; ")}`);
  }
  return parsed;
}

function assertProjectionIsExportable(projection: BenchmarkMathTransformRunProjection): void {
  if (projection.pipelineSnapshot === null) {
    throw new Error("Complete pipeline provenance is required");
  }
  const knownIds = collectDefinitionIds(projection.pipelineSnapshot);
  for (const member of projection.members) {
    for (const outcome of member.outcomes) {
      if (outcome.status !== "done" || !outcome.result) {
        continue;
      }
      if (outcome.result.operations === null) {
        throw new Error(`Detailed traces are missing for ${member.sessionId}/${member.segmentId}`);
      }
      for (const operation of outcome.result.operations) {
        if (!knownIds.has(operation.definition_id)) {
          throw new Error(
            `Trace for ${member.sessionId}/${member.segmentId} references unknown definition ${operation.definition_id}`,
          );
        }
      }
    }
  }
}

function collectDefinitionIds(snapshot: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(snapshot)) {
    return ids;
  }
  for (const [section, field] of [
    ["dictionary", "effective_entries"],
    ["commands", "definitions"],
    ["regex_rules", "effective_rules"],
  ] as const) {
    const source = snapshot[section];
    if (!isRecord(source) || !Array.isArray(source[field])) {
      continue;
    }
    for (const definition of source[field]) {
      if (isRecord(definition) && typeof definition.id === "string") {
        ids.add(definition.id);
      }
    }
  }
  return ids;
}

function parseJsonLines(contents: string): unknown[] {
  return contents
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
