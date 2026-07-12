import {
  getSttBenchmarkResultsForRun,
  getSttBenchmarkRun,
  type BenchmarkCandidateIdentity,
  type LocalEvent,
} from "./localEvents.js";
import {
  calculateAcousticCharacterErrorRate,
  calculateCharacterErrorRate,
  calculateWordErrorRate,
} from "./sttScoring.js";

// Bumped to 2 for issue #134: each candidate output now carries `strict_cer`
// (formerly `cer`) plus a new `acoustic_cer`, and the manifest `scoring` block
// documents the two CER metrics distinctly.
export const STT_BENCHMARK_RUN_EXPORT_SCHEMA_VERSION = 2;
export const STT_BENCHMARK_RUN_EXPORT_FILES = {
  manifest: "manifest.json",
  dataset: "dataset.acoustic.jsonl",
  outputs: "outputs.jsonl",
} as const;

export type SttBenchmarkExportPromptDefinition = {
  id: string;
  displayName: string;
  promptText: string;
};

export type SttBenchmarkRunExportDatasetRecord = {
  split: string;
  dataset_kind: "acoustic";
  session_id: string;
  segment_id: string;
  audio_ref: string;
  audio_path: string | null;
  reference_transcript: string | null;
  correction_created_at: string | null;
};

export type SttBenchmarkRunExportCandidateOutput = {
  candidate: BenchmarkCandidateIdentity;
  prompt_variant_id: string | null;
  status: "done" | "failed" | "missing";
  transcript: string | null;
  latency_ms: number | null;
  /** Strict CER: exact fidelity, sentence punctuation counted (issue #134). */
  strict_cer: number | null;
  /** Acoustic CER: same texts, sentence punctuation neutralized (issue #134). */
  acoustic_cer: number | null;
  wer: number | null;
  error: string | null;
};

export type SttBenchmarkRunExportOutputRecord = {
  session_id: string;
  segment_id: string;
  outputs: SttBenchmarkRunExportCandidateOutput[];
};

export type SttBenchmarkRunExportManifest = {
  schema_version: number;
  export_type: "stt_benchmark_run_llm";
  run_id: string;
  exported_at: string;
  run_started_at: string | null;
  run_finished_at: string | null;
  stage: string;
  dataset_kind: string;
  split: string;
  status: {
    done: number;
    failed: number;
  };
  snapshot: {
    source_event: "stt_benchmark_run_started";
    segment_count: number;
    dataset_file: string;
  };
  files: {
    dataset: string;
    outputs: string;
  };
  scoring: {
    strict_cer: string;
    acoustic_cer: string;
    wer: string;
    limitations: string[];
  };
  prompt_variants: {
    id: string;
    display_name: string;
    prompt_text: string;
  }[];
  candidates: {
    stage: string;
    provider: string;
    model: string;
    variant: string | null;
    prompt_variant_id: string | null;
  }[];
};

export type SttBenchmarkRunExport = {
  manifest: SttBenchmarkRunExportManifest;
  dataset: SttBenchmarkRunExportDatasetRecord[];
  outputs: SttBenchmarkRunExportOutputRecord[];
};

export type BuildSttBenchmarkRunExportOptions = {
  exportedAt: string;
  promptDefinitions: SttBenchmarkExportPromptDefinition[];
  resolveAudioPath: (audioRef: string) => string | null;
};

/**
 * Builds the portable, three-file LLM view of ONE completed STT benchmark run.
 * The dataset and scores come only from the run's frozen snapshot and its
 * run_id-tagged results; current split membership and corrections are never
 * consulted, so regenerating an export cannot move historical ground truth.
 */
export function buildSttBenchmarkRunExport(
  events: LocalEvent[],
  runId: string,
  options: BuildSttBenchmarkRunExportOptions,
): SttBenchmarkRunExport {
  const run = getSttBenchmarkRun(events, runId);
  if (!run) {
    throw new Error(`Benchmark run not found: ${runId}`);
  }
  if (!run.finished) {
    throw new Error(`Benchmark run is not finished: ${runId}`);
  }
  if (run.stage !== "stt" || run.datasetKind !== "acoustic") {
    throw new Error(`Only completed acoustic STT runs can be exported: ${runId}`);
  }

  const snapshotKeys = new Set<string>();
  for (const member of run.snapshot) {
    if (member.audioRef.length === 0) {
      throw new Error(
        `Acoustic benchmark run contains a segment without audio: ${member.sessionId}/${member.segmentId}`,
      );
    }
    const key = segmentKey(member.sessionId, member.segmentId);
    if (snapshotKeys.has(key)) {
      throw new Error(`Benchmark run snapshot contains a duplicate segment: ${key}`);
    }
    snapshotKeys.add(key);
  }

  // Runs created since issue #123 carry their own full definitions. The
  // caller-supplied definitions are only a compatibility fallback for older
  // #122 runs that stored the immutable prompt id alone.
  const promptDefinitions = indexPromptDefinitions([...run.promptDefinitions, ...options.promptDefinitions]);
  const usedPromptIds: string[] = [];
  for (const candidate of run.candidates) {
    if (!candidate.promptVariant) {
      continue;
    }
    if (!promptDefinitions.has(candidate.promptVariant)) {
      throw new Error(`Prompt definition unavailable for run ${runId}: ${candidate.promptVariant}`);
    }
    if (!usedPromptIds.includes(candidate.promptVariant)) {
      usedPromptIds.push(candidate.promptVariant);
    }
  }

  const results = getSttBenchmarkResultsForRun(events, runId, run.snapshot);
  const resultsByKey = new Map(
    results.map((result) => [candidateSegmentKey(result.sessionId, result.segmentId, result.candidate), result]),
  );
  const failuresBySegment = new Map(
    run.finished.failures.map((failure) => [segmentKey(failure.sessionId, failure.segmentId), failure.error]),
  );

  const dataset = run.snapshot.map((member) => ({
    split: run.split,
    dataset_kind: "acoustic" as const,
    session_id: member.sessionId,
    segment_id: member.segmentId,
    audio_ref: member.audioRef,
    audio_path: safelyResolveAudioPath(member.audioRef, options.resolveAudioPath),
    reference_transcript: member.referenceTranscript,
    correction_created_at: member.correctionCreatedAt,
  }));

  const outputs = run.snapshot.map((member) => {
    const failure = failuresBySegment.get(segmentKey(member.sessionId, member.segmentId)) ?? null;
    return {
      session_id: member.sessionId,
      segment_id: member.segmentId,
      outputs: run.candidates.map((candidate) => {
        const result = resultsByKey.get(candidateSegmentKey(member.sessionId, member.segmentId, candidate));
        if (!result) {
          return {
            candidate: toCandidateIdentity(candidate),
            prompt_variant_id: candidate.promptVariant,
            status: failure ? ("failed" as const) : ("missing" as const),
            transcript: null,
            latency_ms: null,
            strict_cer: null,
            acoustic_cer: null,
            wer: null,
            error: failure,
          };
        }

        const reference = member.referenceTranscript;
        return {
          candidate: toCandidateIdentity(candidate),
          prompt_variant_id: candidate.promptVariant,
          status: "done" as const,
          transcript: result.transcript,
          latency_ms: result.transcriptionDurationMs,
          strict_cer: reference === null ? null : calculateCharacterErrorRate(result.transcript, reference),
          acoustic_cer:
            reference === null ? null : calculateAcousticCharacterErrorRate(result.transcript, reference),
          wer: reference === null ? null : calculateWordErrorRate(result.transcript, reference),
          error: null,
        };
      }),
    };
  });

  return {
    manifest: {
      schema_version: STT_BENCHMARK_RUN_EXPORT_SCHEMA_VERSION,
      export_type: "stt_benchmark_run_llm",
      run_id: run.runId,
      exported_at: options.exportedAt,
      run_started_at: run.createdAt,
      run_finished_at: run.finished.createdAt,
      stage: run.stage,
      dataset_kind: run.datasetKind,
      split: run.split,
      status: { done: run.finished.done, failed: run.finished.failed },
      snapshot: {
        source_event: "stt_benchmark_run_started",
        segment_count: run.snapshot.length,
        dataset_file: STT_BENCHMARK_RUN_EXPORT_FILES.dataset,
      },
      files: {
        dataset: STT_BENCHMARK_RUN_EXPORT_FILES.dataset,
        outputs: STT_BENCHMARK_RUN_EXPORT_FILES.outputs,
      },
      scoring: {
        strict_cer:
          "Strict CER: Levenshtein distance over canonicalized, trimmed, case-folded characters divided by " +
          "reference length. Sentence punctuation is counted, so it measures exact output fidelity.",
        acoustic_cer:
          "Acoustic CER: the same strict normalization, then every sentence-punctuation mark (. , ; : ! ? …) is " +
          "replaced by a space and runs of whitespace collapsed, before the same character Levenshtein distance " +
          "divided by reference length. It ignores ONLY sentence punctuation, so a candidate that heard the words " +
          "but not the commas is not penalized. Apostrophes, hyphens, digits, Greek letters, math symbols, " +
          "parentheses and the LaTeX $ delimiter are NOT neutralized.",
        wer:
          "Levenshtein distance over canonicalized, trimmed, case-folded whitespace tokens divided by reference token count.",
        limitations: [
          "Strict text scoring does not equate spoken and written numbers, Greek letter names and symbols, " +
            "or punctuation variants; only the acoustic CER additionally ignores sentence punctuation.",
          "Strict CER, acoustic CER and WER are null when the frozen snapshot has no reference transcript or the " +
            "candidate has no output.",
          "LaTeX canonicalization only normalizes supported delimited math spelling; " +
            "it does not compare mathematical meaning.",
        ],
      },
      prompt_variants: usedPromptIds.map((id) => {
        const definition = promptDefinitions.get(id) as SttBenchmarkExportPromptDefinition;
        return { id, display_name: definition.displayName, prompt_text: definition.promptText };
      }),
      candidates: run.candidates.map((candidate) => ({
        stage: candidate.stage,
        provider: candidate.provider,
        model: candidate.model,
        variant: candidate.variant,
        prompt_variant_id: candidate.promptVariant,
      })),
    },
    dataset,
    outputs,
  };
}

function indexPromptDefinitions(
  definitions: SttBenchmarkExportPromptDefinition[],
): Map<string, SttBenchmarkExportPromptDefinition> {
  const byId = new Map<string, SttBenchmarkExportPromptDefinition>();
  for (const definition of definitions) {
    if (!byId.has(definition.id)) {
      byId.set(definition.id, definition);
    }
  }
  return byId;
}

function safelyResolveAudioPath(
  audioRef: string,
  resolveAudioPath: (audioRef: string) => string | null,
): string | null {
  try {
    return resolveAudioPath(audioRef);
  } catch {
    return null;
  }
}

function segmentKey(sessionId: string, segmentId: string): string {
  return `${sessionId}/${segmentId}`;
}

function candidateSegmentKey(
  sessionId: string,
  segmentId: string,
  candidate: { stage: string; provider: string; model: string; variant?: string | null },
): string {
  const identity = `${candidate.stage}/${candidate.provider}/${candidate.model}/${candidate.variant ?? ""}`;
  return `${segmentKey(sessionId, segmentId)}::${identity}`;
}

function toCandidateIdentity(candidate: {
  stage: string;
  provider: string;
  model: string;
  variant?: string | null;
}): BenchmarkCandidateIdentity {
  return {
    stage: candidate.stage,
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant ?? null,
  };
}
