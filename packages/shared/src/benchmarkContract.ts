import { canonicalizeLatex } from "./latex.js";
import {
  getLegacySttBenchmarkResultsForSplit,
  getSttBenchmarkResultsForRun,
  getSttBenchmarkRun,
  getSttBenchmarkSetSegments,
  getSttCorrectionsByKind,
  type LocalEvent,
  type NormalizationLayerRecord,
  type SttBenchmarkRunPromptDefinitionRecord,
  type SttBenchmarkRunStartedEvent,
  type SttBenchmarkSetSplit,
  type SttScoredBenchmarkResult,
} from "./localEvents.js";
import {
  calculateAcousticCharacterErrorRate,
  calculateCharacterErrorRate,
  calculateWordErrorRate,
} from "./sttScoring.js";
import type { NormalizerOperationTrace } from "./normalizer.js";
import type { NormalizerBenchmarkPipelineSnapshot } from "./normalizerBenchmark.js";

/**
 * Stages named by the multi-stage benchmark contract. `end_to_end` is reserved
 * so future code can name the concept without making it an executable event
 * variant today. Only implemented stages appear in the event unions below.
 */
export type BenchmarkRunStage = "stt" | "math_transform" | "end_to_end";
export type ImplementedBenchmarkRunStage = Exclude<BenchmarkRunStage, "end_to_end">;
export type BenchmarkDatasetKind = "acoustic" | "math_transform" | "end_to_end";

/** Common candidate identity. A candidate always carries the same stage as its run. */
export type BenchmarkCandidateRecord<S extends ImplementedBenchmarkRunStage = ImplementedBenchmarkRunStage> = {
  stage: S;
  provider: string;
  model: string;
  variant: string | null;
};

/** STT snapshot member: real audio plus the frozen human Layer 1 reference. */
export type BenchmarkSttSnapshotMemberRecord = {
  stage: "stt";
  session_id: string;
  segment_id: string;
  audio_ref: string;
  layer1_reference: string | null;
  acoustic_correction_created_at: string | null;
};

/**
 * Text-to-text snapshot member. Both texts come from the SAME latest
 * `math_transform` correction: its raw transcript is Layer 1 and its corrected
 * transcript is Layer 2. Layer 1 is never reconstructed from a later acoustic
 * correction.
 */
export type BenchmarkMathTransformSnapshotMemberRecord = {
  stage: "math_transform";
  session_id: string;
  segment_id: string;
  layer1_input: string;
  layer2_target: string;
  math_transform_correction_created_at: string | null;
};

export type BenchmarkSnapshotMemberRecord =
  | BenchmarkSttSnapshotMemberRecord
  | BenchmarkMathTransformSnapshotMemberRecord;

type BenchmarkRunStartedBase<
  S extends ImplementedBenchmarkRunStage,
  D extends BenchmarkDatasetKind,
  M extends BenchmarkSnapshotMemberRecord,
> = {
  event_type: "benchmark_run_started";
  run_id: string;
  created_at?: string;
  stage: S;
  dataset_kind: D;
  split: SttBenchmarkSetSplit;
  candidates: BenchmarkCandidateRecord<S>[];
  snapshot: M[];
};

export type BenchmarkSttRunStartedEvent = BenchmarkRunStartedBase<
  "stt",
  "acoustic",
  BenchmarkSttSnapshotMemberRecord
> & {
  /** Optional only for compatibility with prompt-bearing STT candidates. */
  prompt_definitions?: SttBenchmarkRunPromptDefinitionRecord[];
};

export type BenchmarkMathTransformRunStartedEvent = BenchmarkRunStartedBase<
  "math_transform",
  "math_transform",
  BenchmarkMathTransformSnapshotMemberRecord
> & {
  /** Added by #141. Optional only so #140 historical runs remain readable. */
  pipeline_snapshot?: NormalizerBenchmarkPipelineSnapshot;
};

/** Discriminated start-event union. There is deliberately no end-to-end variant yet. */
export type BenchmarkRunStartedEvent = BenchmarkSttRunStartedEvent | BenchmarkMathTransformRunStartedEvent;

type BenchmarkResultBase<S extends ImplementedBenchmarkRunStage> = {
  event_type: "benchmark_result";
  run_id: string;
  created_at?: string;
  stage: S;
  session_id: string;
  segment_id: string;
  candidate: BenchmarkCandidateRecord<S>;
};

export type BenchmarkSttResultEvent = BenchmarkResultBase<"stt"> & {
  transcript: string;
  transcription_duration_ms: number | null;
  stt_engine?: string;
  stt_model?: string;
  stt_language?: string;
  audio_duration_seconds?: number | null;
};

export type BenchmarkMathTransformResultEvent = BenchmarkResultBase<"math_transform"> & {
  output_transcript: string;
  transformation_duration_ms: number | null;
  /** Ordered normalizer layer traces, kept typed instead of hidden in a free-form payload. */
  layers: NormalizationLayerRecord[];
  /** Added by #141. Missing only on historical results written by #140. */
  operations?: NormalizerOperationTrace[];
};

/** Discriminated result union. Metrics are derived from the frozen snapshot, not stored in an arbitrary map. */
export type BenchmarkResultEvent = BenchmarkSttResultEvent | BenchmarkMathTransformResultEvent;

export type BenchmarkRunFailureRecord<S extends ImplementedBenchmarkRunStage = ImplementedBenchmarkRunStage> = {
  session_id: string;
  segment_id: string;
  candidate: BenchmarkCandidateRecord<S>;
  error: string;
};

type BenchmarkRunFinishedBase<S extends ImplementedBenchmarkRunStage> = {
  event_type: "benchmark_run_finished";
  run_id: string;
  created_at?: string;
  stage: S;
  /** Counts candidate x member attempts, unlike the older STT terminal's segment counts. */
  done: number;
  failed: number;
  failures: BenchmarkRunFailureRecord<S>[];
};

export type BenchmarkSttRunFinishedEvent = BenchmarkRunFinishedBase<"stt">;
export type BenchmarkMathTransformRunFinishedEvent = BenchmarkRunFinishedBase<"math_transform">;
export type BenchmarkRunFinishedEvent = BenchmarkSttRunFinishedEvent | BenchmarkMathTransformRunFinishedEvent;

export type BenchmarkEventValidation = { valid: true; errors: [] } | { valid: false; errors: string[] };

export type BenchmarkEventLogValidationIssueCode =
  | "invalid_start"
  | "invalid_result"
  | "invalid_terminal"
  | "duplicate_start"
  | "duplicate_result"
  | "duplicate_terminal"
  | "orphan_result"
  | "orphan_terminal"
  | "result_after_terminal"
  | "stage_mismatch"
  | "unknown_candidate"
  | "unknown_member";

export type BenchmarkEventLogValidationIssue = {
  eventIndex: number;
  runId: string | null;
  code: BenchmarkEventLogValidationIssueCode;
  message: string;
};

export type BenchmarkOutcomeStatus = "done" | "failed" | "missing" | "completed_without_output";
export type BenchmarkProjectionSource = "stt_tracked" | "stt_legacy" | "stage_aware";

export type BenchmarkSttScoreProjection = {
  stage: "stt";
  metric: "cer_wer";
  strictCer: number;
  acousticCer: number;
  wer: number;
  referenceTranscript: string;
  correctionCreatedAt: string | null;
};

export type BenchmarkMathTransformScoreProjection = {
  stage: "math_transform";
  metric: "exact_match";
  value: boolean;
  canonicalOutput: string;
  canonicalTarget: string;
  targetTranscript: string;
  correctionCreatedAt: string | null;
};

export type BenchmarkSttResultProjection = {
  stage: "stt";
  createdAt: string | null;
  transcript: string;
  transcriptionDurationMs: number | null;
  sttEngine: string | null;
  sttModel: string | null;
  sttLanguage: string | null;
  audioDurationSeconds: number | null;
  score: BenchmarkSttScoreProjection | null;
};

export type BenchmarkMathTransformResultProjection = {
  stage: "math_transform";
  createdAt: string | null;
  outputTranscript: string;
  transformationDurationMs: number | null;
  layers: NormalizationLayerRecord[];
  operations: NormalizerOperationTrace[] | null;
  score: BenchmarkMathTransformScoreProjection;
};

export type BenchmarkSttCandidateOutcome = {
  stage: "stt";
  candidate: BenchmarkCandidateRecord<"stt">;
  status: BenchmarkOutcomeStatus;
  error: string | null;
  result: BenchmarkSttResultProjection | null;
};

export type BenchmarkMathTransformCandidateOutcome = {
  stage: "math_transform";
  candidate: BenchmarkCandidateRecord<"math_transform">;
  status: Exclude<BenchmarkOutcomeStatus, "completed_without_output">;
  error: string | null;
  result: BenchmarkMathTransformResultProjection | null;
};

export type BenchmarkCandidateOutcome = BenchmarkSttCandidateOutcome | BenchmarkMathTransformCandidateOutcome;

export type BenchmarkSttMemberProjection = {
  stage: "stt";
  sessionId: string;
  segmentId: string;
  audioRef: string;
  layer1Reference: string | null;
  acousticCorrectionCreatedAt: string | null;
  outcomes: BenchmarkSttCandidateOutcome[];
};

export type BenchmarkMathTransformMemberProjection = {
  stage: "math_transform";
  sessionId: string;
  segmentId: string;
  layer1Input: string;
  layer2Target: string;
  mathTransformCorrectionCreatedAt: string | null;
  outcomes: BenchmarkMathTransformCandidateOutcome[];
};

export type BenchmarkRunTerminalProjection = {
  createdAt: string | null;
  done: number;
  failed: number;
} | null;

export type BenchmarkOutcomeCounts = {
  done: number;
  failed: number;
  missing: number;
  completedWithoutOutput: number;
};

type BenchmarkRunProjectionBase<S extends ImplementedBenchmarkRunStage, D extends BenchmarkDatasetKind> = {
  projectionId: string;
  runId: string | null;
  source: BenchmarkProjectionSource;
  stage: S;
  datasetKind: D;
  split: SttBenchmarkSetSplit;
  createdAt: string | null;
  terminal: BenchmarkRunTerminalProjection;
  outcomeCounts: BenchmarkOutcomeCounts;
};

export type BenchmarkSttRunProjection = BenchmarkRunProjectionBase<"stt", "acoustic"> & {
  candidates: BenchmarkCandidateRecord<"stt">[];
  promptDefinitions: { id: string; displayName: string; promptText: string }[];
  members: BenchmarkSttMemberProjection[];
};

export type BenchmarkMathTransformRunProjection = BenchmarkRunProjectionBase<"math_transform", "math_transform"> & {
  candidates: BenchmarkCandidateRecord<"math_transform">[];
  pipelineSnapshot: NormalizerBenchmarkPipelineSnapshot | null;
  members: BenchmarkMathTransformMemberProjection[];
};

export type BenchmarkRunProjection = BenchmarkSttRunProjection | BenchmarkMathTransformRunProjection;

type RunOwner =
  | { kind: "stt_tracked"; eventIndex: number; event: SttBenchmarkRunStartedEvent }
  | { kind: "stage_aware"; eventIndex: number; event: BenchmarkRunStartedEvent };

function valid(errors: string[]): BenchmarkEventValidation {
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function validateCommonEvent(value: unknown, eventType: string, errors: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push("event must be an object");
    return false;
  }
  if (value.event_type !== eventType) {
    errors.push(`event_type must be ${eventType}`);
  }
  if (!isNonEmptyString(value.run_id)) {
    errors.push("run_id must be a non-empty string");
  }
  if (value.created_at !== undefined && typeof value.created_at !== "string") {
    errors.push("created_at must be a string when present");
  }
  return true;
}

function validateCandidate(value: unknown, stage: ImplementedBenchmarkRunStage, path: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  if (value.stage !== stage) {
    errors.push(`${path}.stage must match run stage ${stage}`);
  }
  if (!isNonEmptyString(value.provider)) {
    errors.push(`${path}.provider must be a non-empty string`);
  }
  if (!isNonEmptyString(value.model)) {
    errors.push(`${path}.model must be a non-empty string`);
  }
  if (value.variant !== null && typeof value.variant !== "string") {
    errors.push(`${path}.variant must be a string or null`);
  }
  return true;
}

function validateLayer(value: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  if (!isNonEmptyString(value.layer)) {
    errors.push(`${path}.layer must be a non-empty string`);
  }
  if (typeof value.input !== "string" || typeof value.output !== "string") {
    errors.push(`${path}.input and ${path}.output must be strings`);
  }
  if (typeof value.applied !== "boolean") {
    errors.push(`${path}.applied must be a boolean`);
  }
  if (value.diagnostics !== undefined && !isStringArray(value.diagnostics)) {
    errors.push(`${path}.diagnostics must be an array of strings when present`);
  }
  return true;
}

function validateOperation(value: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  if (value.operation !== "dictionary" && value.operation !== "command" && value.operation !== "regex") {
    errors.push(`${path}.operation must be dictionary, command or regex`);
  }
  if (!isNonEmptyString(value.definition_id)) {
    errors.push(`${path}.definition_id must be a non-empty string`);
  }
  if (!isNonNegativeInteger(value.occurrence_count)) {
    errors.push(`${path}.occurrence_count must be a non-negative integer`);
  }
  if (!Array.isArray(value.occurrences)) {
    errors.push(`${path}.occurrences must be an array`);
  } else {
    value.occurrences.forEach((occurrence, index) => {
      if (
        !isRecord(occurrence) ||
        !isNonNegativeInteger(occurrence.start) ||
        !isNonNegativeInteger(occurrence.end) ||
        typeof occurrence.matched_text !== "string" ||
        (occurrence.replacement_text !== undefined && typeof occurrence.replacement_text !== "string")
      ) {
        errors.push(`${path}.occurrences[${index}] has invalid positions or text`);
      }
    });
    if (isNonNegativeInteger(value.occurrence_count) && value.occurrences.length !== value.occurrence_count) {
      errors.push(`${path}.occurrence_count must equal occurrences.length`);
    }
  }
  if (value.operation === "command" && !isNonEmptyString(value.debug_label)) {
    errors.push(`${path}.debug_label must be a non-empty string for commands`);
  }
  if (value.operation === "regex" && !isNonNegativeInteger(value.pass)) {
    errors.push(`${path}.pass must be a non-negative integer for regex operations`);
  }
  return true;
}

function validatePipelineSnapshot(value: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  if ((value.schema_version !== 1 && value.schema_version !== 2) || !isNonNegativeInteger(value.pipeline_contract_version)) {
    errors.push(`${path} must carry schema_version 1 or 2 and an integer pipeline_contract_version`);
  }
  if (!isNonEmptyString(value.semantic_version)) {
    errors.push(`${path}.semantic_version must be a non-empty string`);
  }
  validateCandidate(value.candidate, "math_transform", `${path}.candidate`, errors);
  if (!isNonNegativeInteger(value.latex_canonicalization_contract_version)) {
    errors.push(`${path}.latex_canonicalization_contract_version must be an integer`);
  }

  validateSourceSnapshot(value.dictionary, `${path}.dictionary`, "effective_entries", "ignored_entries", errors);
  validateSourceSnapshot(value.regex_rules, `${path}.regex_rules`, "effective_rules", "ignored_rules", errors);
  if (value.schema_version === 2 && isRecord(value.regex_rules)) {
    if (!isNonNegativeInteger(value.regex_rules.bundled_version) || !isSha256(value.regex_rules.bundled_sha256)) {
      errors.push(`${path}.regex_rules must carry the bundled version and SHA-256 in schema 2`);
    }
    if (
      value.regex_rules.overlay_source_state !== "absent" &&
      value.regex_rules.overlay_source_state !== "file" &&
      value.regex_rules.overlay_source_state !== "invalid" &&
      value.regex_rules.overlay_source_state !== "unreadable"
    ) {
      errors.push(`${path}.regex_rules.overlay_source_state is invalid`);
    }
    if (value.regex_rules.overlay_sha256 !== null && !isSha256(value.regex_rules.overlay_sha256)) {
      errors.push(`${path}.regex_rules.overlay_sha256 must be null or a full SHA-256`);
    }
    if (value.regex_rules.legacy_source_sha256 !== null && !isSha256(value.regex_rules.legacy_source_sha256)) {
      errors.push(`${path}.regex_rules.legacy_source_sha256 must be null or a full SHA-256`);
    }
    if (
      value.regex_rules.configuration_mode !== "bundled" &&
      value.regex_rules.configuration_mode !== "overlay" &&
      value.regex_rules.configuration_mode !== "legacy"
    ) {
      errors.push(`${path}.regex_rules.configuration_mode is invalid`);
    }
  }
  if (!isRecord(value.commands)) {
    errors.push(`${path}.commands must be an object`);
  } else {
    if (!isNonNegativeInteger(value.commands.contract_version) || !isSha256(value.commands.sha256)) {
      errors.push(`${path}.commands must carry contract_version and a full SHA-256`);
    }
    if (!Array.isArray(value.commands.definitions)) {
      errors.push(`${path}.commands.definitions must be an array`);
    } else {
      value.commands.definitions.forEach((definition, index) => {
        if (
          !isRecord(definition) ||
          !isNonEmptyString(definition.id) ||
          !isNonNegativeInteger(definition.order) ||
          !isNonEmptyString(definition.canonical_phrase) ||
          !isNonEmptyString(definition.debug_label) ||
          !isNonEmptyString(definition.effect)
        ) {
          errors.push(`${path}.commands.definitions[${index}] is invalid`);
        }
      });
    }
  }
  if (containsPrivateUseCharacter(JSON.stringify(value))) {
    errors.push(`${path} must not contain a Private Use Area character`);
  }
  return true;
}

function validateSourceSnapshot(
  value: unknown,
  path: string,
  effectiveField: string,
  ignoredField: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    value.source_state !== "file" &&
    value.source_state !== "default_absent" &&
    value.source_state !== "invalid" &&
    value.source_state !== "unreadable"
  ) {
    errors.push(`${path}.source_state is invalid`);
  }
  if (!isSha256(value.sha256)) {
    errors.push(`${path}.sha256 must be a full lowercase SHA-256`);
  }
  if (!isNullableString(value.source_content)) {
    errors.push(`${path}.source_content must be a string or null`);
  }
  if (!Array.isArray(value[effectiveField])) {
    errors.push(`${path}.${effectiveField} must be an array`);
  } else {
    value[effectiveField].forEach((definition, index) => {
      if (!isRecord(definition) || !isNonEmptyString(definition.id) || !isNonNegativeInteger(definition.order)) {
        errors.push(`${path}.${effectiveField}[${index}] must carry a stable id and order`);
      }
    });
  }
  if (!Array.isArray(value[ignoredField])) {
    errors.push(`${path}.${ignoredField} must be an array`);
  }
  if (!isStringArray(value.diagnostics)) {
    errors.push(`${path}.diagnostics must be an array of strings`);
  }
}

export function validateBenchmarkRunStartedEvent(value: unknown): BenchmarkEventValidation {
  const errors: string[] = [];
  if (!validateCommonEvent(value, "benchmark_run_started", errors)) {
    return valid(errors);
  }

  const stage = value.stage;
  if (stage !== "stt" && stage !== "math_transform") {
    errors.push("stage must be an implemented stage (stt or math_transform); end_to_end is reserved");
    return valid(errors);
  }
  if (!isSttBenchmarkSetSplit(value.split)) {
    errors.push("split must be a known benchmark split");
  }
  const expectedDatasetKind = stage === "stt" ? "acoustic" : "math_transform";
  if (value.dataset_kind !== expectedDatasetKind) {
    errors.push(`dataset_kind must be ${expectedDatasetKind} for stage ${stage}`);
  }

  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    errors.push("candidates must contain at least one candidate");
  } else {
    const candidateKeys = new Set<string>();
    value.candidates.forEach((candidate, index) => {
      validateCandidate(candidate, stage, `candidates[${index}]`, errors);
      if (isRecord(candidate)) {
        const key = candidateKeyFromUnknown(candidate);
        if (key !== null && candidateKeys.has(key)) {
          errors.push(`candidates[${index}] duplicates candidate ${key}`);
        }
        if (key !== null) {
          candidateKeys.add(key);
        }
      }
    });
  }

  if (!Array.isArray(value.snapshot) || value.snapshot.length === 0) {
    errors.push("snapshot must contain at least one member");
  } else {
    const memberKeys = new Set<string>();
    value.snapshot.forEach((member, index) => {
      const path = `snapshot[${index}]`;
      if (!isRecord(member)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (member.stage !== stage) {
        errors.push(`${path}.stage must match run stage ${stage}`);
      }
      if (!isNonEmptyString(member.session_id) || !isNonEmptyString(member.segment_id)) {
        errors.push(`${path}.session_id and ${path}.segment_id must be non-empty strings`);
      }
      const key = memberKeyFromUnknown(member);
      if (key !== null && memberKeys.has(key)) {
        errors.push(`${path} duplicates member ${key}`);
      }
      if (key !== null) {
        memberKeys.add(key);
      }

      if (stage === "stt") {
        if (!isNonEmptyString(member.audio_ref)) {
          errors.push(`${path}.audio_ref must be a non-empty string for STT`);
        }
        if (!isNullableString(member.layer1_reference)) {
          errors.push(`${path}.layer1_reference must be a string or null`);
        }
        if (!isNullableString(member.acoustic_correction_created_at)) {
          errors.push(`${path}.acoustic_correction_created_at must be a string or null`);
        }
        if (
          hasOwn(member, "layer1_input") ||
          hasOwn(member, "layer2_target") ||
          hasOwn(member, "math_transform_correction_created_at")
        ) {
          errors.push(`${path} must not mix math_transform snapshot fields into an STT member`);
        }
      } else {
        if (typeof member.layer1_input !== "string" || typeof member.layer2_target !== "string") {
          errors.push(`${path}.layer1_input and ${path}.layer2_target must be strings`);
        }
        if (!isNullableString(member.math_transform_correction_created_at)) {
          errors.push(`${path}.math_transform_correction_created_at must be a string or null`);
        }
        if (
          hasOwn(member, "audio_ref") ||
          hasOwn(member, "layer1_reference") ||
          hasOwn(member, "acoustic_correction_created_at")
        ) {
          errors.push(`${path} must not mix STT snapshot fields into a math_transform member`);
        }
      }
    });
  }

  if (stage === "stt" && value.prompt_definitions !== undefined) {
    if (!Array.isArray(value.prompt_definitions)) {
      errors.push("prompt_definitions must be an array when present");
    } else {
      value.prompt_definitions.forEach((definition, index) => {
        if (
          !isRecord(definition) ||
          !isNonEmptyString(definition.id) ||
          !isNonEmptyString(definition.display_name) ||
          !isNonEmptyString(definition.prompt_text)
        ) {
          errors.push(`prompt_definitions[${index}] must contain non-empty id, display_name and prompt_text`);
        }
      });
    }
  } else if (stage === "math_transform" && value.prompt_definitions !== undefined) {
    errors.push("prompt_definitions is STT-specific and must be absent for math_transform");
  }

  if (stage === "math_transform" && value.pipeline_snapshot !== undefined) {
    validatePipelineSnapshot(value.pipeline_snapshot, "pipeline_snapshot", errors);
    const snapshotCandidate = isRecord(value.pipeline_snapshot)
      ? value.pipeline_snapshot.candidate
      : null;
    if (
      isRecord(snapshotCandidate) &&
      Array.isArray(value.candidates) &&
      !value.candidates.some(
        (candidate) =>
          isRecord(candidate) &&
          candidateKeyFromUnknown(candidate) === candidateKeyFromUnknown(snapshotCandidate),
      )
    ) {
      errors.push("pipeline_snapshot.candidate must be one of the frozen candidates");
    }
  } else if (stage === "stt" && value.pipeline_snapshot !== undefined) {
    errors.push("pipeline_snapshot is math_transform-specific and must be absent for STT");
  }

  return valid(errors);
}

export function validateBenchmarkResultEvent(value: unknown): BenchmarkEventValidation {
  const errors: string[] = [];
  if (!validateCommonEvent(value, "benchmark_result", errors)) {
    return valid(errors);
  }

  const stage = value.stage;
  if (stage !== "stt" && stage !== "math_transform") {
    errors.push("stage must be an implemented stage (stt or math_transform)");
    return valid(errors);
  }
  if (!isNonEmptyString(value.session_id) || !isNonEmptyString(value.segment_id)) {
    errors.push("session_id and segment_id must be non-empty strings");
  }
  validateCandidate(value.candidate, stage, "candidate", errors);

  if (stage === "stt") {
    if (typeof value.transcript !== "string") {
      errors.push("transcript must be a string for STT");
    }
    if (!isNullableNonNegativeNumber(value.transcription_duration_ms)) {
      errors.push("transcription_duration_ms must be a non-negative number or null");
    }
    if (value.audio_duration_seconds !== undefined && !isNullableNonNegativeNumber(value.audio_duration_seconds)) {
      errors.push("audio_duration_seconds must be a non-negative number or null when present");
    }
    for (const field of ["stt_engine", "stt_model", "stt_language"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        errors.push(`${field} must be a string when present`);
      }
    }
    if (
      hasOwn(value, "output_transcript") ||
      hasOwn(value, "transformation_duration_ms") ||
      hasOwn(value, "layers")
    ) {
      errors.push("STT results must not carry math_transform output fields");
    }
  } else {
    if (typeof value.output_transcript !== "string") {
      errors.push("output_transcript must be a string for math_transform");
    }
    if (!isNullableNonNegativeNumber(value.transformation_duration_ms)) {
      errors.push("transformation_duration_ms must be a non-negative number or null");
    }
    if (!Array.isArray(value.layers)) {
      errors.push("layers must be an array for math_transform");
    } else {
      value.layers.forEach((layer, index) => validateLayer(layer, `layers[${index}]`, errors));
    }
    if (value.operations !== undefined) {
      if (!Array.isArray(value.operations)) {
        errors.push("operations must be an array when present");
      } else {
        value.operations.forEach((operation, index) => validateOperation(operation, `operations[${index}]`, errors));
      }
    }
    if (
      hasOwn(value, "transcript") ||
      hasOwn(value, "transcription_duration_ms") ||
      hasOwn(value, "stt_engine") ||
      hasOwn(value, "stt_model") ||
      hasOwn(value, "stt_language") ||
      hasOwn(value, "audio_duration_seconds")
    ) {
      errors.push("math_transform results must not carry STT output fields");
    }
  }

  return valid(errors);
}

export function validateBenchmarkRunFinishedEvent(value: unknown): BenchmarkEventValidation {
  const errors: string[] = [];
  if (!validateCommonEvent(value, "benchmark_run_finished", errors)) {
    return valid(errors);
  }

  const stage = value.stage;
  if (stage !== "stt" && stage !== "math_transform") {
    errors.push("stage must be an implemented stage (stt or math_transform)");
    return valid(errors);
  }
  if (!isNonNegativeInteger(value.done) || !isNonNegativeInteger(value.failed)) {
    errors.push("done and failed must be non-negative integers");
  }
  if (!Array.isArray(value.failures)) {
    errors.push("failures must be an array");
  } else {
    const failureKeys = new Set<string>();
    value.failures.forEach((failure, index) => {
      const path = `failures[${index}]`;
      if (!isRecord(failure)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(failure.session_id) || !isNonEmptyString(failure.segment_id)) {
        errors.push(`${path}.session_id and ${path}.segment_id must be non-empty strings`);
      }
      if (!isNonEmptyString(failure.error)) {
        errors.push(`${path}.error must be a non-empty string`);
      }
      validateCandidate(failure.candidate, stage, `${path}.candidate`, errors);
      if (isRecord(failure.candidate)) {
        const candidateKey = candidateKeyFromUnknown(failure.candidate);
        const memberKey = memberKeyFromUnknown(failure);
        if (candidateKey !== null && memberKey !== null) {
          const key = `${memberKey}::${candidateKey}`;
          if (failureKeys.has(key)) {
            errors.push(`${path} duplicates failure ${key}`);
          }
          failureKeys.add(key);
        }
      }
    });
    if (isNonNegativeInteger(value.failed) && value.failures.length !== value.failed) {
      errors.push("failed must equal the number of failure records");
    }
  }
  return valid(errors);
}

export function isBenchmarkRunStartedEvent(value: unknown): value is BenchmarkRunStartedEvent {
  return validateBenchmarkRunStartedEvent(value).valid;
}

export function isBenchmarkResultEvent(value: unknown): value is BenchmarkResultEvent {
  return validateBenchmarkResultEvent(value).valid;
}

export function isBenchmarkRunFinishedEvent(value: unknown): value is BenchmarkRunFinishedEvent {
  return validateBenchmarkRunFinishedEvent(value).valid;
}

/**
 * Cross-event validation for the new family. It reports orphaned, duplicate,
 * cross-stage, unknown-member and unknown-candidate records without mutating or
 * repairing the append-only log.
 */
export function validateStageAwareBenchmarkEvents(events: LocalEvent[]): BenchmarkEventLogValidationIssue[] {
  const issues: BenchmarkEventLogValidationIssue[] = [];
  const globalOwners = new Map(collectRunOwners(events).map((owner) => [owner.event.run_id, owner]));
  const starts = new Map<string, { event: BenchmarkRunStartedEvent; terminalSeen: boolean; results: Set<string> }>();

  events.forEach((event, eventIndex) => {
    if (event.event_type === "benchmark_run_started") {
      const validation = validateBenchmarkRunStartedEvent(event);
      if (!validation.valid) {
        issues.push(issue(eventIndex, event, "invalid_start", validation.errors.join("; ")));
        return;
      }
      const startedEvent = event as BenchmarkRunStartedEvent;
      const globalOwner = globalOwners.get(startedEvent.run_id);
      if (!globalOwner || globalOwner.eventIndex !== eventIndex) {
        issues.push(
          issue(eventIndex, event, "duplicate_start", `first start for ${startedEvent.run_id} already won`),
        );
        return;
      }
      starts.set(startedEvent.run_id, { event: startedEvent, terminalSeen: false, results: new Set<string>() });
      return;
    }

    if (isTrackedSttRunStartedEvent(event)) {
      const globalOwner = globalOwners.get(event.run_id);
      if (globalOwner?.kind === "stage_aware" && globalOwner.eventIndex !== eventIndex) {
        issues.push(issue(eventIndex, event, "duplicate_start", `first start for ${event.run_id} already won`));
      }
      return;
    }

    if (event.event_type === "benchmark_result") {
      const validation = validateBenchmarkResultEvent(event);
      if (!validation.valid) {
        issues.push(issue(eventIndex, event, "invalid_result", validation.errors.join("; ")));
        return;
      }
      const resultEvent = event as BenchmarkResultEvent;
      const owner = starts.get(resultEvent.run_id);
      if (!owner) {
        issues.push(issue(eventIndex, event, "orphan_result", `no earlier valid start for ${resultEvent.run_id}`));
        return;
      }
      if (owner.terminalSeen) {
        issues.push(
          issue(eventIndex, event, "result_after_terminal", `run ${resultEvent.run_id} is already terminal`),
        );
        return;
      }
      if (resultEvent.stage !== owner.event.stage) {
        issues.push(
          issue(eventIndex, event, "stage_mismatch", `result stage does not match run ${resultEvent.run_id}`),
        );
        return;
      }
      if (!hasCandidate(owner.event, resultEvent.candidate)) {
        issues.push(issue(eventIndex, event, "unknown_candidate", "result candidate was not frozen by the run start"));
        return;
      }
      if (!hasMember(owner.event, resultEvent.session_id, resultEvent.segment_id)) {
        issues.push(issue(eventIndex, event, "unknown_member", "result member was not frozen by the run start"));
        return;
      }
      const key = candidateMemberKey(resultEvent.session_id, resultEvent.segment_id, resultEvent.candidate);
      if (owner.results.has(key)) {
        issues.push(issue(eventIndex, event, "duplicate_result", "first result for candidate x member already won"));
        return;
      }
      owner.results.add(key);
      return;
    }

    if (event.event_type === "benchmark_run_finished") {
      const validation = validateBenchmarkRunFinishedEvent(event);
      if (!validation.valid) {
        issues.push(issue(eventIndex, event, "invalid_terminal", validation.errors.join("; ")));
        return;
      }
      const terminalEvent = event as BenchmarkRunFinishedEvent;
      const owner = starts.get(terminalEvent.run_id);
      if (!owner) {
        issues.push(
          issue(eventIndex, event, "orphan_terminal", `no earlier valid start for ${terminalEvent.run_id}`),
        );
        return;
      }
      if (owner.terminalSeen) {
        issues.push(
          issue(eventIndex, event, "duplicate_terminal", `first terminal for ${terminalEvent.run_id} already won`),
        );
        return;
      }
      if (terminalEvent.stage !== owner.event.stage) {
        issues.push(
          issue(eventIndex, event, "stage_mismatch", `terminal stage does not match run ${terminalEvent.run_id}`),
        );
        return;
      }
      for (const failure of terminalEvent.failures) {
        const knownCandidate = hasCandidate(owner.event, failure.candidate);
        const knownMember = hasMember(owner.event, failure.session_id, failure.segment_id);
        if (!knownCandidate) {
          issues.push(
            issue(eventIndex, event, "unknown_candidate", "failure candidate was not frozen by the run start"),
          );
        }
        if (!knownMember) {
          issues.push(issue(eventIndex, event, "unknown_member", "failure member was not frozen by the run start"));
        }
        if (
          knownCandidate &&
          knownMember &&
          owner.results.has(candidateMemberKey(failure.session_id, failure.segment_id, failure.candidate))
        ) {
          issues.push(
            issue(
              eventIndex,
              event,
              "invalid_terminal",
              "failure overlaps an already recorded result for candidate x member",
            ),
          );
        }
      }
      const slotCount = owner.event.candidates.length * owner.event.snapshot.length;
      if (
        terminalEvent.done !== owner.results.size ||
        terminalEvent.done + terminalEvent.failed > slotCount
      ) {
        issues.push(
          issue(
            eventIndex,
            event,
            "invalid_terminal",
            "terminal counts must match recorded results and cannot exceed candidate x member slots",
          ),
        );
      }
      owner.terminalSeen = true;
    }
  });

  return issues;
}

/**
 * Builds the text-only snapshot used by a future normalizer run. The pair is
 * copied directly from the latest `math_transform` correction event. A later
 * acoustic correction cannot replace or rebuild its Layer 1 input.
 */
export function buildMathTransformBenchmarkRunSnapshot(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): BenchmarkMathTransformSnapshotMemberRecord[] {
  return getSttBenchmarkSetSegments(events, split).flatMap((segment) => {
    const correction = getSttCorrectionsByKind(events, segment.sessionId, segment.segmentId).find(
      (candidate) => candidate.correctionKind === "math_transform",
    );
    if (!correction) {
      return [];
    }
    return [
      {
        stage: "math_transform" as const,
        session_id: segment.sessionId,
        segment_id: segment.segmentId,
        layer1_input: correction.rawTranscript,
        layer2_target: correction.correctedTranscript,
        math_transform_correction_created_at: correction.correctionCreatedAt,
      },
    ];
  });
}

/**
 * Common Results projection for one split. Tracked STT starts, stage-aware
 * starts and the virtual legacy STT bucket are adapted without rewriting any
 * source event. Real runs are newest-first; the optional legacy bucket is last.
 */
export function getBenchmarkRunProjections(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): BenchmarkRunProjection[] {
  const owners = collectRunOwners(events)
    .filter((owner) => owner.event.split === split)
    .sort((left, right) => right.eventIndex - left.eventIndex);
  const projections = owners
    .map((owner) => projectRunOwner(events, owner))
    .filter((projection): projection is BenchmarkRunProjection => projection !== null);
  const legacy = projectLegacySttBenchmarkResults(events, split);
  return legacy ? [...projections, legacy] : projections;
}

/** Resolves one real run id across both event families, honoring the first start globally. */
export function getBenchmarkRunProjection(events: LocalEvent[], runId: string): BenchmarkRunProjection | null {
  const owner = collectRunOwners(events).find((candidate) => candidate.event.run_id === runId);
  return owner ? projectRunOwner(events, owner) : null;
}

/** Adapts pre-run STT results into an explicitly limited virtual projection. */
export function projectLegacySttBenchmarkResults(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
): BenchmarkSttRunProjection | null {
  const results = getLegacySttBenchmarkResultsForSplit(events, split).filter(
    (result) => result.candidate.stage === "stt",
  );
  if (results.length === 0) {
    return null;
  }

  const candidates = uniqueSttCandidates(results.map((result) => toSttCandidate(result.candidate)));
  const splitSegments = new Map(
    getSttBenchmarkSetSegments(events, split).map((segment) => [
      memberKey(segment.sessionId, segment.segmentId),
      segment,
    ]),
  );
  const resultsByMember = groupSttResults(results);
  const members: BenchmarkSttMemberProjection[] = [];

  for (const [key, byCandidate] of resultsByMember) {
    const segment = splitSegments.get(key);
    if (!segment) {
      continue;
    }
    const reference = Array.from(byCandidate.values()).find((result) => result.referenceTranscript !== null)
      ?.referenceTranscript ?? null;
    members.push({
      stage: "stt",
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      audioRef: segment.audioRef,
      layer1Reference: reference,
      acousticCorrectionCreatedAt: null,
      outcomes: candidates.map((candidate) => {
        const result = byCandidate.get(candidateKey(candidate)) ?? null;
        return result
          ? sttDoneOutcome(candidate, toLegacySttResultProjection(result))
          : sttEmptyOutcome(candidate, "missing", null);
      }),
    });
  }

  return {
    projectionId: `legacy:stt:${split}`,
    runId: null,
    source: "stt_legacy",
    stage: "stt",
    datasetKind: "acoustic",
    split,
    createdAt: null,
    terminal: null,
    candidates,
    promptDefinitions: [],
    members,
    outcomeCounts: countOutcomes(members.flatMap((member) => member.outcomes)),
  };
}

function collectRunOwners(events: LocalEvent[]): RunOwner[] {
  const owners = new Map<string, RunOwner>();
  events.forEach((event, eventIndex) => {
    if (isBenchmarkRunStartedEvent(event)) {
      if (!owners.has(event.run_id)) {
        owners.set(event.run_id, { kind: "stage_aware", eventIndex, event });
      }
      return;
    }
    if (isTrackedSttRunStartedEvent(event) && !owners.has(event.run_id)) {
      owners.set(event.run_id, { kind: "stt_tracked", eventIndex, event });
    }
  });
  return Array.from(owners.values());
}

function projectRunOwner(events: LocalEvent[], owner: RunOwner): BenchmarkRunProjection | null {
  return owner.kind === "stt_tracked"
    ? projectTrackedSttRun(events, owner)
    : projectStageAwareRun(events, owner);
}

function projectTrackedSttRun(
  events: LocalEvent[],
  owner: Extract<RunOwner, { kind: "stt_tracked" }>,
): BenchmarkSttRunProjection | null {
  const run = getSttBenchmarkRun(events, owner.event.run_id);
  if (!run || run.stage !== "stt" || run.datasetKind !== "acoustic") {
    return null;
  }
  const candidates = uniqueSttCandidates(
    run.candidates
      .filter((candidate) => candidate.stage === "stt")
      .map((candidate) => ({
        stage: "stt" as const,
        provider: candidate.provider,
        model: candidate.model,
        variant: candidate.variant,
      })),
  );
  const resultsByMember = groupSttResults(getSttBenchmarkResultsForRun(events, run.runId, run.snapshot));
  const failuresByMember = new Map(
    (run.finished?.failures ?? []).map((failure) => [
      memberKey(failure.sessionId, failure.segmentId),
      failure.error,
    ]),
  );
  const terminalAccountsForEveryMember =
    run.finished !== null &&
    run.finished.done + run.finished.failed === run.snapshot.length &&
    run.finished.failures.length === run.finished.failed;

  const members: BenchmarkSttMemberProjection[] = run.snapshot.map((member) => {
    const key = memberKey(member.sessionId, member.segmentId);
    const byCandidate = resultsByMember.get(key) ?? new Map<string, SttScoredBenchmarkResult>();
    const failure = failuresByMember.get(key) ?? null;
    const memberHasAnyResult = byCandidate.size > 0;
    return {
      stage: "stt",
      sessionId: member.sessionId,
      segmentId: member.segmentId,
      audioRef: member.audioRef,
      layer1Reference: member.referenceTranscript,
      acousticCorrectionCreatedAt: member.correctionCreatedAt,
      outcomes: candidates.map((candidate) => {
        const result = byCandidate.get(candidateKey(candidate));
        if (result) {
          return sttDoneOutcome(
            candidate,
            toTrackedSttResultProjection(result, member.referenceTranscript, member.correctionCreatedAt),
          );
        }
        if (failure !== null) {
          return sttEmptyOutcome(candidate, "failed", failure);
        }
        if (!memberHasAnyResult && terminalAccountsForEveryMember) {
          return sttEmptyOutcome(candidate, "completed_without_output", null);
        }
        return sttEmptyOutcome(candidate, "missing", null);
      }),
    };
  });

  return {
    projectionId: run.runId,
    runId: run.runId,
    source: "stt_tracked",
    stage: "stt",
    datasetKind: "acoustic",
    split: run.split,
    createdAt: run.createdAt,
    terminal: run.finished
      ? { createdAt: run.finished.createdAt, done: run.finished.done, failed: run.finished.failed }
      : null,
    candidates,
    promptDefinitions: run.promptDefinitions,
    members,
    outcomeCounts: countOutcomes(members.flatMap((member) => member.outcomes)),
  };
}

function projectStageAwareRun(
  events: LocalEvent[],
  owner: Extract<RunOwner, { kind: "stage_aware" }>,
): BenchmarkRunProjection {
  return owner.event.stage === "stt"
    ? projectStageAwareSttRun(events, owner.eventIndex, owner.event)
    : projectStageAwareMathTransformRun(events, owner.eventIndex, owner.event);
}

function projectStageAwareSttRun(
  events: LocalEvent[],
  startIndex: number,
  start: BenchmarkSttRunStartedEvent,
): BenchmarkSttRunProjection {
  const terminal = findStageAwareTerminal(events, startIndex, start.run_id, "stt");
  const results = collectStageAwareResults(events, startIndex, terminal?.eventIndex ?? events.length, start);
  const failures = terminal ? collectStageAwareFailures(terminal.event, start) : new Map<string, string>();
  const members: BenchmarkSttMemberProjection[] = start.snapshot.map((member) => ({
    stage: "stt",
    sessionId: member.session_id,
    segmentId: member.segment_id,
    audioRef: member.audio_ref,
    layer1Reference: member.layer1_reference,
    acousticCorrectionCreatedAt: member.acoustic_correction_created_at,
    outcomes: start.candidates.map((candidate) => {
      const key = candidateMemberKey(member.session_id, member.segment_id, candidate);
      const result = results.get(key);
      if (result?.stage === "stt") {
        return sttDoneOutcome(
          candidate,
          toStageAwareSttResultProjection(
            result,
            member.layer1_reference,
            member.acoustic_correction_created_at,
          ),
        );
      }
      const error = failures.get(key) ?? null;
      return sttEmptyOutcome(candidate, error === null ? "missing" : "failed", error);
    }),
  }));

  return {
    projectionId: start.run_id,
    runId: start.run_id,
    source: "stage_aware",
    stage: "stt",
    datasetKind: "acoustic",
    split: start.split,
    createdAt: stringOrNull(start.created_at),
    terminal: terminal
      ? { createdAt: stringOrNull(terminal.event.created_at), done: terminal.event.done, failed: terminal.event.failed }
      : null,
    candidates: start.candidates,
    promptDefinitions: (start.prompt_definitions ?? []).map((definition) => ({
      id: definition.id,
      displayName: definition.display_name,
      promptText: definition.prompt_text,
    })),
    members,
    outcomeCounts: countOutcomes(members.flatMap((member) => member.outcomes)),
  };
}

function projectStageAwareMathTransformRun(
  events: LocalEvent[],
  startIndex: number,
  start: BenchmarkMathTransformRunStartedEvent,
): BenchmarkMathTransformRunProjection {
  const terminal = findStageAwareTerminal(events, startIndex, start.run_id, "math_transform");
  const results = collectStageAwareResults(events, startIndex, terminal?.eventIndex ?? events.length, start);
  const failures = terminal ? collectStageAwareFailures(terminal.event, start) : new Map<string, string>();
  const members: BenchmarkMathTransformMemberProjection[] = start.snapshot.map((member) => ({
    stage: "math_transform",
    sessionId: member.session_id,
    segmentId: member.segment_id,
    layer1Input: member.layer1_input,
    layer2Target: member.layer2_target,
    mathTransformCorrectionCreatedAt: member.math_transform_correction_created_at,
    outcomes: start.candidates.map((candidate) => {
      const key = candidateMemberKey(member.session_id, member.segment_id, candidate);
      const result = results.get(key);
      if (result?.stage === "math_transform") {
        return mathDoneOutcome(
          candidate,
          toMathTransformResultProjection(
            result,
            member.layer2_target,
            member.math_transform_correction_created_at,
          ),
        );
      }
      const error = failures.get(key) ?? null;
      return mathEmptyOutcome(candidate, error === null ? "missing" : "failed", error);
    }),
  }));

  return {
    projectionId: start.run_id,
    runId: start.run_id,
    source: "stage_aware",
    stage: "math_transform",
    datasetKind: "math_transform",
    split: start.split,
    createdAt: stringOrNull(start.created_at),
    terminal: terminal
      ? { createdAt: stringOrNull(terminal.event.created_at), done: terminal.event.done, failed: terminal.event.failed }
      : null,
    candidates: start.candidates,
    pipelineSnapshot: start.pipeline_snapshot ?? null,
    members,
    outcomeCounts: countOutcomes(members.flatMap((member) => member.outcomes)),
  };
}

function findStageAwareTerminal<S extends ImplementedBenchmarkRunStage>(
  events: LocalEvent[],
  startIndex: number,
  runId: string,
  stage: S,
): { eventIndex: number; event: Extract<BenchmarkRunFinishedEvent, { stage: S }> } | null {
  for (let eventIndex = startIndex + 1; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (isBenchmarkRunFinishedEvent(event) && event.run_id === runId && event.stage === stage) {
      return { eventIndex, event: event as Extract<BenchmarkRunFinishedEvent, { stage: S }> };
    }
  }
  return null;
}

function collectStageAwareResults(
  events: LocalEvent[],
  startIndex: number,
  endIndex: number,
  start: BenchmarkRunStartedEvent,
): Map<string, BenchmarkResultEvent> {
  const results = new Map<string, BenchmarkResultEvent>();
  for (let eventIndex = startIndex + 1; eventIndex < endIndex; eventIndex += 1) {
    const event = events[eventIndex];
    if (
      !isBenchmarkResultEvent(event) ||
      event.run_id !== start.run_id ||
      event.stage !== start.stage ||
      !hasCandidate(start, event.candidate) ||
      !hasMember(start, event.session_id, event.segment_id)
    ) {
      continue;
    }
    const key = candidateMemberKey(event.session_id, event.segment_id, event.candidate);
    if (!results.has(key)) {
      results.set(key, event);
    }
  }
  return results;
}

function collectStageAwareFailures(
  terminal: BenchmarkRunFinishedEvent,
  start: BenchmarkRunStartedEvent,
): Map<string, string> {
  const failures = new Map<string, string>();
  for (const failure of terminal.failures) {
    if (
      failure.candidate.stage !== start.stage ||
      !hasCandidate(start, failure.candidate) ||
      !hasMember(start, failure.session_id, failure.segment_id)
    ) {
      continue;
    }
    const key = candidateMemberKey(failure.session_id, failure.segment_id, failure.candidate);
    if (!failures.has(key)) {
      failures.set(key, failure.error);
    }
  }
  return failures;
}

function toStageAwareSttResultProjection(
  result: BenchmarkSttResultEvent,
  referenceTranscript: string | null,
  correctionCreatedAt: string | null,
): BenchmarkSttResultProjection {
  return {
    stage: "stt",
    createdAt: stringOrNull(result.created_at),
    transcript: result.transcript,
    transcriptionDurationMs: result.transcription_duration_ms,
    sttEngine: stringOrNull(result.stt_engine),
    sttModel: stringOrNull(result.stt_model),
    sttLanguage: stringOrNull(result.stt_language),
    audioDurationSeconds: numberOrNull(result.audio_duration_seconds),
    score: buildSttScore(result.transcript, referenceTranscript, correctionCreatedAt),
  };
}

function toTrackedSttResultProjection(
  result: SttScoredBenchmarkResult,
  referenceTranscript: string | null,
  correctionCreatedAt: string | null,
): BenchmarkSttResultProjection {
  return {
    stage: "stt",
    createdAt: null,
    transcript: result.transcript,
    transcriptionDurationMs: result.transcriptionDurationMs,
    sttEngine: result.sttEngine,
    sttModel: result.sttModel,
    sttLanguage: result.sttLanguage,
    audioDurationSeconds: result.audioDurationSeconds,
    score: buildSttScore(result.transcript, referenceTranscript, correctionCreatedAt),
  };
}

function toLegacySttResultProjection(result: SttScoredBenchmarkResult): BenchmarkSttResultProjection {
  return toTrackedSttResultProjection(result, result.referenceTranscript, null);
}

function buildSttScore(
  transcript: string,
  referenceTranscript: string | null,
  correctionCreatedAt: string | null,
): BenchmarkSttScoreProjection | null {
  if (referenceTranscript === null) {
    return null;
  }
  return {
    stage: "stt",
    metric: "cer_wer",
    strictCer: calculateCharacterErrorRate(transcript, referenceTranscript),
    acousticCer: calculateAcousticCharacterErrorRate(transcript, referenceTranscript),
    wer: calculateWordErrorRate(transcript, referenceTranscript),
    referenceTranscript,
    correctionCreatedAt,
  };
}

function toMathTransformResultProjection(
  result: BenchmarkMathTransformResultEvent,
  targetTranscript: string,
  correctionCreatedAt: string | null,
): BenchmarkMathTransformResultProjection {
  const canonicalOutput = canonicalizeLatex(result.output_transcript);
  const canonicalTarget = canonicalizeLatex(targetTranscript);
  return {
    stage: "math_transform",
    createdAt: stringOrNull(result.created_at),
    outputTranscript: result.output_transcript,
    transformationDurationMs: result.transformation_duration_ms,
    layers: result.layers,
    operations: result.operations ?? null,
    score: {
      stage: "math_transform",
      metric: "exact_match",
      value: canonicalOutput === canonicalTarget,
      canonicalOutput,
      canonicalTarget,
      targetTranscript,
      correctionCreatedAt,
    },
  };
}

function sttDoneOutcome(
  candidate: BenchmarkCandidateRecord<"stt">,
  result: BenchmarkSttResultProjection,
): BenchmarkSttCandidateOutcome {
  return { stage: "stt", candidate, status: "done", error: null, result };
}

function sttEmptyOutcome(
  candidate: BenchmarkCandidateRecord<"stt">,
  status: Exclude<BenchmarkOutcomeStatus, "done">,
  error: string | null,
): BenchmarkSttCandidateOutcome {
  return { stage: "stt", candidate, status, error, result: null };
}

function mathDoneOutcome(
  candidate: BenchmarkCandidateRecord<"math_transform">,
  result: BenchmarkMathTransformResultProjection,
): BenchmarkMathTransformCandidateOutcome {
  return { stage: "math_transform", candidate, status: "done", error: null, result };
}

function mathEmptyOutcome(
  candidate: BenchmarkCandidateRecord<"math_transform">,
  status: "failed" | "missing",
  error: string | null,
): BenchmarkMathTransformCandidateOutcome {
  return { stage: "math_transform", candidate, status, error, result: null };
}

function countOutcomes(outcomes: BenchmarkCandidateOutcome[]): BenchmarkOutcomeCounts {
  return outcomes.reduce<BenchmarkOutcomeCounts>(
    (counts, outcome) => {
      if (outcome.status === "completed_without_output") {
        counts.completedWithoutOutput += 1;
      } else {
        counts[outcome.status] += 1;
      }
      return counts;
    },
    { done: 0, failed: 0, missing: 0, completedWithoutOutput: 0 },
  );
}

function groupSttResults(results: SttScoredBenchmarkResult[]): Map<string, Map<string, SttScoredBenchmarkResult>> {
  const byMember = new Map<string, Map<string, SttScoredBenchmarkResult>>();
  for (const result of results) {
    const key = memberKey(result.sessionId, result.segmentId);
    const byCandidate = byMember.get(key) ?? new Map<string, SttScoredBenchmarkResult>();
    byCandidate.set(candidateKey(result.candidate), result);
    byMember.set(key, byCandidate);
  }
  return byMember;
}

function uniqueSttCandidates(candidates: BenchmarkCandidateRecord<"stt">[]): BenchmarkCandidateRecord<"stt">[] {
  const byKey = new Map<string, BenchmarkCandidateRecord<"stt">>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}

function toSttCandidate(candidate: {
  stage: string;
  provider: string;
  model: string;
  variant: string | null;
}): BenchmarkCandidateRecord<"stt"> {
  return { stage: "stt", provider: candidate.provider, model: candidate.model, variant: candidate.variant };
}

function hasCandidate(
  start: BenchmarkRunStartedEvent,
  candidate: BenchmarkCandidateRecord,
): boolean {
  return start.candidates.some((frozen) => candidateKey(frozen) === candidateKey(candidate));
}

function hasMember(start: BenchmarkRunStartedEvent, sessionId: string, segmentId: string): boolean {
  return start.snapshot.some((member) => member.session_id === sessionId && member.segment_id === segmentId);
}

function candidateMemberKey(
  sessionId: string,
  segmentId: string,
  candidate: { stage: string; provider: string; model: string; variant: string | null },
): string {
  return `${memberKey(sessionId, segmentId)}::${candidateKey(candidate)}`;
}

function candidateKey(candidate: { stage: string; provider: string; model: string; variant: string | null }): string {
  return `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
}

function candidateKeyFromUnknown(candidate: Record<string, unknown>): string | null {
  return isNonEmptyString(candidate.stage) && isNonEmptyString(candidate.provider) && isNonEmptyString(candidate.model)
    ? `${candidate.stage}/${candidate.provider}/${candidate.model}/${typeof candidate.variant === "string" ? candidate.variant : ""}`
    : null;
}

function memberKey(sessionId: string, segmentId: string): string {
  return `${sessionId}/${segmentId}`;
}

function memberKeyFromUnknown(member: Record<string, unknown>): string | null {
  return isNonEmptyString(member.session_id) && isNonEmptyString(member.segment_id)
    ? memberKey(member.session_id, member.segment_id)
    : null;
}

function issue(
  eventIndex: number,
  event: LocalEvent,
  code: BenchmarkEventLogValidationIssueCode,
  message: string,
): BenchmarkEventLogValidationIssue {
  const runId = isRecord(event) && "run_id" in event && typeof event.run_id === "string" ? event.run_id : null;
  return {
    eventIndex,
    runId,
    code,
    message,
  };
}

function isTrackedSttRunStartedEvent(event: LocalEvent): event is SttBenchmarkRunStartedEvent {
  if (
    event.event_type !== "stt_benchmark_run_started" ||
    !isNonEmptyString(event.run_id) ||
    event.stage !== "stt" ||
    event.dataset_kind !== "acoustic" ||
    !isSttBenchmarkSetSplit(event.split) ||
    !Array.isArray(event.candidates) ||
    !Array.isArray(event.snapshot)
  ) {
    return false;
  }
  return (
    event.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        candidate.stage === "stt" &&
        isNonEmptyString(candidate.provider) &&
        isNonEmptyString(candidate.model),
    ) &&
    event.snapshot.every(
      (member) =>
        isRecord(member) &&
        isNonEmptyString(member.session_id) &&
        isNonEmptyString(member.segment_id) &&
        isNonEmptyString(member.audio_ref),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function containsPrivateUseCharacter(value: string): boolean {
  return /[\uE000-\uF8FF]/u.test(value);
}

function isSttBenchmarkSetSplit(value: unknown): value is SttBenchmarkSetSplit {
  return value === "train_candidate_pool" || value === "validation" || value === "test_frozen";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
