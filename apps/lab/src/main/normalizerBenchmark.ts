import {
  buildMathTransformBenchmarkRunSnapshot,
  buildNormalizerBenchmarkCandidate,
  buildNormalizerBenchmarkPipelineSnapshot,
  containsSentinel,
  prepareNormalizerBenchmarkResultForStorage,
  restoreCommandWords,
  sameNormalizerBenchmarkCandidate,
  type BenchmarkCandidateRecord,
  type BenchmarkMathTransformRunFinishedEvent,
  type BenchmarkMathTransformRunStartedEvent,
  type BenchmarkResultEvent,
  type BenchmarkRunFinishedEvent,
  type BenchmarkRunStartedEvent,
  type LocalEvent,
  type NormalizerBenchmarkCandidate,
  type SttBenchmarkSetProgress,
  type SttBenchmarkSetSplit,
  type TranscriptNormalizer,
} from "@dictex/shared";

export type NormalizerBenchmarkSetPreview = {
  stage: "math_transform";
  split: SttBenchmarkSetSplit;
  evaluableSegments: number;
  scorableSegments: number;
  candidate: NormalizerBenchmarkCandidate;
};

export type NormalizerBenchmarkRunRequest = {
  split: SttBenchmarkSetSplit;
  candidate: BenchmarkCandidateRecord<"math_transform">;
};

export type NormalizerBenchmarkRunResponse = {
  stage: "math_transform";
  split: SttBenchmarkSetSplit;
  runId: string;
  total: number;
  done: number;
  failed: number;
};

type NormalizerBenchmarkWritableEvent = BenchmarkRunStartedEvent | BenchmarkResultEvent | BenchmarkRunFinishedEvent;

export function buildNormalizerBenchmarkSetPreview(
  events: LocalEvent[],
  split: SttBenchmarkSetSplit,
  normalizer: TranscriptNormalizer,
): NormalizerBenchmarkSetPreview {
  const snapshot = buildMathTransformBenchmarkRunSnapshot(events, split);
  requireSentinelFreeSnapshot(snapshot);
  return {
    stage: "math_transform",
    split,
    evaluableSegments: snapshot.length,
    scorableSegments: snapshot.length,
    candidate: buildNormalizerBenchmarkCandidate(normalizer.version),
  };
}

export async function runNormalizerBenchmark(options: {
  events: LocalEvent[];
  split: SttBenchmarkSetSplit;
  requestedCandidate: BenchmarkCandidateRecord<"math_transform">;
  normalizer: TranscriptNormalizer;
  runId: string;
  appendEvent: (event: NormalizerBenchmarkWritableEvent) => Promise<void>;
  onProgress?: (progress: SttBenchmarkSetProgress) => void;
  now?: () => string;
  monotonicNow?: () => number;
}): Promise<NormalizerBenchmarkRunResponse> {
  const snapshot = buildMathTransformBenchmarkRunSnapshot(options.events, options.split);
  if (snapshot.length === 0) {
    throw new Error("Cannot start a normalizer benchmark run with no evaluable math_transform pair");
  }
  requireSentinelFreeSnapshot(snapshot);

  const candidate = buildNormalizerBenchmarkCandidate(options.normalizer.version).candidate;
  if (!sameNormalizerBenchmarkCandidate(options.requestedCandidate, candidate)) {
    throw new Error("The deterministic pipeline changed after the protocol preview; refresh Experiments before launching");
  }

  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startEvent: BenchmarkMathTransformRunStartedEvent = {
    event_type: "benchmark_run_started",
    run_id: options.runId,
    created_at: now(),
    stage: "math_transform",
    dataset_kind: "math_transform",
    split: options.split,
    candidates: [candidate],
    snapshot,
    pipeline_snapshot: buildNormalizerBenchmarkPipelineSnapshot(
      options.normalizer.pipelineSnapshot,
      options.normalizer.version,
    ),
  };
  await appendSentinelFreeEvent(startEvent, options.appendEvent);

  const total = snapshot.length;
  let queued = total;
  let running = 0;
  let done = 0;
  let failed = 0;
  const failures: BenchmarkMathTransformRunFinishedEvent["failures"] = [];

  const sendProgress = (
    current: SttBenchmarkSetProgress["current"],
    lastOutcome: SttBenchmarkSetProgress["lastOutcome"],
  ): void => {
    options.onProgress?.({
      split: options.split,
      total,
      queued,
      running,
      done,
      failed,
      current,
      lastOutcome,
    });
  };
  sendProgress(null, null);

  for (const member of snapshot) {
    queued -= 1;
    running = 1;
    sendProgress({ sessionId: member.session_id, segmentId: member.segment_id }, null);

    try {
      const startedAt = monotonicNow();
      const normalized = await options.normalizer.normalize(member.layer1_input, { detailedTrace: true });
      const transformationDurationMs = Math.max(0, monotonicNow() - startedAt);
      const stored = prepareNormalizerBenchmarkResultForStorage(normalized);
      await appendSentinelFreeEvent(
        {
          event_type: "benchmark_result",
          run_id: options.runId,
          created_at: now(),
          stage: "math_transform",
          session_id: member.session_id,
          segment_id: member.segment_id,
          candidate,
          output_transcript: stored.outputTranscript,
          transformation_duration_ms: transformationDurationMs,
          layers: stored.layers,
          operations: stored.operations,
        },
        options.appendEvent,
      );
      running = 0;
      done += 1;
      sendProgress(null, {
        sessionId: member.session_id,
        segmentId: member.segment_id,
        status: "done",
        error: null,
        resultCount: 1,
      });
    } catch (error) {
      running = 0;
      failed += 1;
      const message = restoreCommandWords(
        error instanceof Error ? error.message : "Normalizer benchmark failed",
      );
      failures.push({
        session_id: member.session_id,
        segment_id: member.segment_id,
        candidate,
        error: message,
      });
      sendProgress(null, {
        sessionId: member.session_id,
        segmentId: member.segment_id,
        status: "failed",
        error: message,
        resultCount: 0,
      });
    }
  }

  await appendSentinelFreeEvent(
    {
      event_type: "benchmark_run_finished",
      run_id: options.runId,
      created_at: now(),
      stage: "math_transform",
      done,
      failed,
      failures,
    },
    options.appendEvent,
  );

  return {
    stage: "math_transform",
    split: options.split,
    runId: options.runId,
    total,
    done,
    failed,
  };
}

async function appendSentinelFreeEvent(
  event: NormalizerBenchmarkWritableEvent,
  appendEvent: (event: NormalizerBenchmarkWritableEvent) => Promise<void>,
): Promise<void> {
  if (containsSentinel(JSON.stringify(event))) {
    throw new Error(
      `Refusing to append ${event.event_type}: event contains a reserved command sentinel`,
    );
  }
  await appendEvent(event);
}

function requireSentinelFreeSnapshot(
  snapshot: ReturnType<typeof buildMathTransformBenchmarkRunSnapshot>,
): void {
  const corrupted = snapshot.find(
    (member) => containsSentinel(member.layer1_input) || containsSentinel(member.layer2_target),
  );
  if (corrupted) {
    throw new Error(
      `Cannot benchmark ${corrupted.session_id} / ${corrupted.segment_id}: its math_transform correction contains a reserved command sentinel`,
    );
  }
}
