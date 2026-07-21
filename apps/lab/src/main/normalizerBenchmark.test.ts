import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containsSentinel,
  buildNormalizerBenchmarkCandidate,
  createTranscriptNormalizer,
  getBenchmarkRunProjection,
  isBenchmarkResultEvent,
  isBenchmarkRunFinishedEvent,
  isBenchmarkRunStartedEvent,
  parseNormalizerBenchmarkVariant,
  summarizeNormalizerBenchmarkRun,
  type LocalEvent,
  type BenchmarkMathTransformResultEvent,
  type NormalizationResult,
  type TranscriptNormalizer,
} from "@dictex/shared";
import { buildNormalizerBenchmarkSetPreview, runNormalizerBenchmark } from "./normalizerBenchmark.js";

function membership(segmentId: string): LocalEvent {
  return {
    event_type: "stt_benchmark_set_membership",
    session_id: "session_normalizer",
    segment_id: segmentId,
    audio_ref: "",
    split: "validation",
  };
}

function correction(segmentId: string, input: string, target: string, createdAt: string): LocalEvent {
  return {
    event_type: "stt_correction",
    session_id: "session_normalizer",
    segment_id: segmentId,
    audio_ref: "",
    raw_transcript: input,
    corrected_transcript: target,
    correction_method: "keyboard",
    correction_kind: "math_transform",
    created_at: createdAt,
  };
}

test("historical normalizer candidate variants remain readable without rules provenance", () => {
  const dictionaryHash = "1".repeat(64);
  const rulesHash = "2".repeat(64);
  assert.deepEqual(
    parseNormalizerBenchmarkVariant(`dictionary-sha256:${dictionaryHash};rules-sha256:${rulesHash}`),
    { dictionaryHash, rulesHash },
  );
  assert.deepEqual(
    parseNormalizerBenchmarkVariant(
      `pipeline-contract:2;semantic:dictex-deterministic-pipeline-v3;` +
      `commands-sha256:${"3".repeat(64)};latex-contract:1;` +
      `dictionary-sha256:${dictionaryHash};rules-sha256:${rulesHash}`,
    ),
    {
      pipelineContractVersion: 2,
      semanticVersion: "dictex-deterministic-pipeline-v3",
      commandTableHash: "3".repeat(64),
      latexCanonicalizationContractVersion: 1,
      dictionaryHash,
      rulesHash,
    },
  );
});

test("the normalizer identity separates legacy source provenance from effective rule provenance", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-benchmark-"));
  try {
    const dictionaryPath = path.join(directory, "dictionary.json");
    const rulesPath = path.join(directory, "rules.json");
    const dictionarySource = '{"version":1,"entries":[{"from":"dic tex","to":"DicTeX"}]}\n';
    const rulesSource = '{"version":1,"rules":[]}\n';
    writeFileSync(dictionaryPath, dictionarySource, "utf8");
    writeFileSync(rulesPath, rulesSource, "utf8");

    const normalizer = await createTranscriptNormalizer({ dictionaryPath, rulesPath });
    assert.equal(normalizer.version.dictionaryHash, createHash("sha256").update(dictionarySource).digest("hex"));
    assert.equal(normalizer.rulesConfiguration.legacyHash, createHash("sha256").update(rulesSource).digest("hex"));
    assert.match(normalizer.version.dictionaryHash, /^[0-9a-f]{64}$/);
    assert.match(normalizer.version.rulesHash, /^[0-9a-f]{64}$/);
    assert.match(normalizer.version.bundledRulesHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(normalizer.version.rulesMode, "legacy");
    const identity = buildNormalizerBenchmarkCandidate(normalizer.version).candidate;
    assert.match(identity.variant ?? "", /pipeline-contract:3/);
    assert.match(identity.variant ?? "", /commands-sha256:[0-9a-f]{64}/);
    assert.match(identity.variant ?? "", /bundled-rules-version:6;bundled-rules-sha256:[0-9a-f]{64}/);
    assert.match(identity.variant ?? "", /rules-mode:legacy/);
    assert.match(identity.variant ?? "", /local-rules-sha256:[0-9a-f]{64}/);
    const changedCommands = buildNormalizerBenchmarkCandidate({
      ...normalizer.version,
      commandTableHash: "0".repeat(64),
    }).candidate;
    assert.notEqual(changedCommands.variant, identity.variant, "command-table changes alter candidate identity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a normalizer run freezes pairs and version, restores commands, canonicalizes scoring and keeps mixed outcomes", async () => {
  const events: LocalEvent[] = [
    membership("seg_canonical"),
    correction("seg_canonical", "x au carré", "$wrong$", "2026-07-13T08:00:00.000Z"),
    correction("seg_canonical", "x au carré", "$x^{2}$", "2026-07-13T09:00:00.000Z"),
    membership("seg_failure"),
    correction("seg_failure", "fail this member", "$f$", "2026-07-13T09:01:00.000Z"),
    membership("seg_command"),
    correction(
      "seg_command",
      "retour à la ligne y au carré",
      "retour à la ligne $y^{2}$",
      "2026-07-13T09:02:00.000Z",
    ),
    membership("seg_scope"),
    correction("seg_scope", "z au carré plus un", "$z^{2} + 1$", "2026-07-13T09:03:00.000Z"),
  ];
  const absentRoot = path.join(tmpdir(), "dictex-normalizer-benchmark-absent");
  const base = await createTranscriptNormalizer({
    dictionaryPath: path.join(absentRoot, "dictionary.json"),
    rulesPath: path.join(absentRoot, "rules.json"),
  });
  const normalizer: TranscriptNormalizer = {
    version: base.version,
    pipelineSnapshot: base.pipelineSnapshot,
    rulesConfiguration: base.rulesConfiguration,
    normalize: async (input, runtimeOptions): Promise<NormalizationResult> => {
      if (input === "fail this member") {
        throw new Error("synthetic \uE000 member failure \uE00F");
      }
      if (input === "x au carré") {
        return {
          input,
          output: "$x^2$",
          passthrough: false,
          diagnostics: [],
          layers: [
            { layer: "regex_rules", input, output: "$x^2$", applied: true, diagnostics: [] },
          ],
        };
      }
      return base.normalize(input, runtimeOptions);
    },
  };

  const preview = buildNormalizerBenchmarkSetPreview(events, "validation", normalizer);
  assert.equal(preview.evaluableSegments, 4);
  assert.deepEqual(parseNormalizerBenchmarkVariant(preview.candidate.candidate.variant), normalizer.version);

  let monotonic = 0;
  const written: LocalEvent[] = [];
  const response = await runNormalizerBenchmark({
    events,
    split: "validation",
    requestedCandidate: preview.candidate.candidate,
    normalizer,
    runId: "run_normalizer_reference",
    appendEvent: async (event) => {
      written.push(event);
      events.push(event);
    },
    now: () => "2026-07-13T10:00:00.000Z",
    monotonicNow: () => monotonic++,
  });

  assert.deepEqual(
    { total: response.total, done: response.done, failed: response.failed },
    { total: 4, done: 3, failed: 1 },
  );
  const start = written.find(isBenchmarkRunStartedEvent);
  assert.equal(start?.stage, "math_transform");
  if (start?.stage === "math_transform") {
    assert.equal(start.snapshot[0].layer2_target, "$x^{2}$", "the latest pair is frozen at launch");
    assert.equal(start.snapshot[0].math_transform_correction_created_at, "2026-07-13T09:00:00.000Z");
    assert.deepEqual(parseNormalizerBenchmarkVariant(start.candidates[0].variant), normalizer.version);
    assert.equal(start.pipeline_snapshot?.dictionary.source_state, "default_absent");
    assert.equal(start.pipeline_snapshot?.regex_rules.source_state, "default_absent");
    assert.equal(start.pipeline_snapshot?.candidate.variant, start.candidates[0].variant);
  }

  assert.equal(containsSentinel(JSON.stringify(written)), false, "no PUA sentinel reaches the event log");
  const terminal = written.find(isBenchmarkRunFinishedEvent);
  assert.equal(terminal?.stage, "math_transform");
  if (terminal?.stage === "math_transform") {
    assert.match(terminal.failures[0].error, /retour à la ligne/);
    assert.equal(containsSentinel(terminal.failures[0].error), false);
  }
  const commandResult = written.find(
    (event): event is BenchmarkMathTransformResultEvent =>
      isBenchmarkResultEvent(event) && event.stage === "math_transform" && event.segment_id === "seg_command",
  );
  if (commandResult) {
    assert.equal(commandResult.output_transcript, "retour à la ligne $y^{2}$");
    assert.equal(containsSentinel(commandResult.output_transcript), false);
    assert.equal(commandResult.layers.some((layer) => containsSentinel(layer.input) || containsSentinel(layer.output)), false);
    assert.ok(commandResult.operations?.some((operation) => operation.operation === "command"));
  } else {
    assert.fail("command result was not recorded");
  }

  const projectionBeforeCorrection = getBenchmarkRunProjection(events, response.runId);
  assert.equal(projectionBeforeCorrection?.stage, "math_transform");
  if (projectionBeforeCorrection?.stage !== "math_transform") {
    assert.fail("math_transform projection was not built");
  }
  const canonicalMember = projectionBeforeCorrection.members.find((member) => member.segmentId === "seg_canonical");
  assert.equal(canonicalMember?.outcomes[0].result?.score.value, true, "$x^2$ matches canonical $x^{2}$");
  const scopeMember = projectionBeforeCorrection.members.find((member) => member.segmentId === "seg_scope");
  assert.equal(scopeMember?.outcomes[0].result?.score.value, false, "a scope/convention difference stays visible");

  const summary = summarizeNormalizerBenchmarkRun(projectionBeforeCorrection)[0];
  assert.deepEqual(
    {
      exactMatches: summary.exactMatches,
      total: summary.total,
      done: summary.done,
      failed: summary.failed,
      missing: summary.missing,
    },
    { exactMatches: 2, total: 4, done: 3, failed: 1, missing: 0 },
  );

  events.push(
    correction("seg_canonical", "x au carré", "$x^{3}$", "2026-07-13T11:00:00.000Z"),
  );
  const projectionAfterCorrection = getBenchmarkRunProjection(events, response.runId);
  assert.deepEqual(
    projectionAfterCorrection,
    projectionBeforeCorrection,
    "a later human correction cannot change the frozen score or detail",
  );
});

test("invalid-rule diagnostics are readable and sentinel-free in every written event", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-normalizer-benchmark-diagnostic-"));
  try {
    const rulesPath = path.join(directory, "rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify({ version: 1, rules: [{ pattern: "\uE000[", replacement: "x" }] }),
      "utf8",
    );
    const normalizer = await createTranscriptNormalizer({
      dictionaryPath: path.join(directory, "dictionary.json"),
      rulesPath,
    });
    const rawResult = await normalizer.normalize("plain prose");
    assert.equal(
      containsSentinel(JSON.stringify(rawResult.layers)),
      true,
      "the invalid RegExp diagnostic reproduces the storage-boundary bug",
    );

    const events: LocalEvent[] = [
      membership("seg_diagnostic"),
      correction("seg_diagnostic", "plain prose", "plain prose", "2026-07-13T12:00:00.000Z"),
    ];
    const preview = buildNormalizerBenchmarkSetPreview(events, "validation", normalizer);
    const written: LocalEvent[] = [];
    await runNormalizerBenchmark({
      events,
      split: "validation",
      requestedCandidate: preview.candidate.candidate,
      normalizer,
      runId: "run_normalizer_diagnostic",
      appendEvent: async (event) => {
        written.push(event);
      },
    });

    assert.equal(containsSentinel(JSON.stringify(written)), false);
    const result = written.find(
      (event): event is BenchmarkMathTransformResultEvent =>
        isBenchmarkResultEvent(event) && event.stage === "math_transform",
    );
    assert.ok(result);
    const diagnostics = result.layers.flatMap((layer) => layer.diagnostics ?? []);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.includes("retour à la ligne")));
    assert.ok(diagnostics.some((diagnostic) => /invalid regex/i.test(diagnostic)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the append boundary rejects a sentinel introduced by any event property", async () => {
  const events: LocalEvent[] = [
    membership("seg_boundary"),
    correction("seg_boundary", "plain prose", "plain prose", "2026-07-13T13:00:00.000Z"),
  ];
  const absentRoot = path.join(tmpdir(), "dictex-normalizer-benchmark-boundary-absent");
  const normalizer = await createTranscriptNormalizer({
    dictionaryPath: path.join(absentRoot, "dictionary.json"),
    rulesPath: path.join(absentRoot, "rules.json"),
  });
  const preview = buildNormalizerBenchmarkSetPreview(events, "validation", normalizer);
  const written: LocalEvent[] = [];

  await assert.rejects(
    runNormalizerBenchmark({
      events,
      split: "validation",
      requestedCandidate: preview.candidate.candidate,
      normalizer,
      runId: "run_\uE000_boundary",
      appendEvent: async (event) => {
        written.push(event);
      },
    }),
    /Refusing to append benchmark_run_started/,
  );
  assert.deepEqual(written, []);
});
