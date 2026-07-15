import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSttDatasetExport, type BuildSttDatasetExportOptions } from "./datasetExport.js";
import { createTranscriptNormalizer, normalizeTranscript } from "./normalizer.js";
import { buildNormalizerBenchmarkCandidate, parseNormalizerBenchmarkVariant } from "./normalizerBenchmark.js";
import { containsSentinel } from "./commands.js";
import type { LocalEvent } from "./localEvents.js";

const NL = String.fromCodePoint(0xe000); // U+E000 — retour à la ligne

// One segment placed in test_frozen, carrying the two chained corrections the
// enrichment tool writes: an acoustic pair (audio -> literal) and a
// math_transform pair (literal -> notation). Both layers hold the command words
// in full, canonical form — the store is plain text, never a sentinel.
const AUDIO_REF = "audio/session_x/seg_0001.webm";
const LITERAL = "retour à la ligne x au carré plus deux"; // Layer 1
const NOTATION = "retour à la ligne x² + 2"; // Layer 2
const RAW_STT = "euh retour à la ligne x au carré plus deux"; // raw STT output

// Point the normalizer at a directory that does not exist: the personal
// dictionary degrades to passthrough and the rules degrade to the built-in
// DEFAULT_RULES, so this reproduces the exact pipeline the issue describes
// (dictionary noop + shipped regex) without depending on any on-disk config.
const ABSENT_CONFIG: BuildSttDatasetExportOptions = {
  dictionaryPath: path.join(tmpdir(), "dictex-issue-100-absent", "dictionary.json"),
  rulesPath: path.join(tmpdir(), "dictex-issue-100-absent", "rules.json"),
};

function baseEvents(): LocalEvent[] {
  return [
    { event_type: "audio_segment", session_id: "session_x", segment_id: "seg_0001", audio_ref: AUDIO_REF },
    {
      event_type: "stt_result",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      stt_engine: "faster-whisper",
      stt_model: "small",
      stt_language: "fr",
      stt_output: RAW_STT,
    },
    {
      event_type: "stt_correction",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      raw_transcript: RAW_STT,
      corrected_transcript: LITERAL,
      correction_method: "keyboard",
      correction_kind: "acoustic",
    },
    {
      event_type: "stt_correction",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      raw_transcript: LITERAL,
      corrected_transcript: NOTATION,
      correction_method: "keyboard",
      correction_kind: "math_transform",
    },
    {
      event_type: "stt_benchmark_set_membership",
      session_id: "session_x",
      segment_id: "seg_0001",
      audio_ref: AUDIO_REF,
      split: "test_frozen",
    },
  ];
}

async function recordsOf(events: LocalEvent[], options: BuildSttDatasetExportOptions = ABSENT_CONFIG) {
  const exported = await buildSttDatasetExport(events, "2026-07-10T00:00:00.000Z", options);
  const frozen = exported.splits.find((split) => split.split === "test_frozen");
  assert.ok(frozen, "test_frozen split present");
  const acoustic = frozen.kinds.find((group) => group.correctionKind === "acoustic")?.records ?? [];
  const mathTransform = frozen.kinds.find((group) => group.correctionKind === "math_transform")?.records ?? [];
  return { acoustic, mathTransform };
}

test("math_transform INPUT is the full pipeline replayed over Layer 1 (issue #100)", async () => {
  const { mathTransform } = await recordsOf(baseEvents());
  assert.equal(mathTransform.length, 1);
  const pair = mathTransform[0];
  // The INPUT is Layer 1 run through dictionary -> command extraction -> regex:
  // "au carré" fires (regex operand is one letter/number) and emits canonical
  // LaTeX wrapped in "$…$" (#107); "plus deux" does NOT fire ("deux" spelled
  // out is not an operand). This is exactly what layer 3 receives at inference
  // — the residual it must learn, not raw verbatim.
  assert.equal(pair.rawTranscript, `${NL} $x^{2}$ plus deux`);
  // The TARGET is the human-authored Layer 2 with command substitution ONLY.
  assert.equal(pair.correctedTranscript, `${NL} x² + 2`);
  // Both sides carry the sentinel so the seq2seq learns to pass it through (#92).
  assert.ok(containsSentinel(pair.rawTranscript), "Layer 1 substituted");
  assert.ok(containsSentinel(pair.correctedTranscript), "Layer 2 substituted");
});

test("INVARIANT: the exported input equals what apps/dictex would feed layer 3", async () => {
  // The whole point of the issue: the export and DicTeX go through the ONE shared
  // normalizer, and we check the equality directly rather than assuming it. Both
  // sides use `normalizeTranscript` (DicTeX's per-dictation call) / its underlying
  // pipeline (the export) with the SAME dictionary/rules, so a future divergence
  // fails here — the way #92 made command-word divergence impossible to reintroduce.
  const { mathTransform } = await recordsOf(baseEvents());
  const exportedInput = mathTransform[0].rawTranscript;
  const dictexServes = (await normalizeTranscript(LITERAL, ABSENT_CONFIG)).output;
  assert.equal(exportedInput, dictexServes);
});

test("overlay parity: DicTeX, Lab export and benchmark identity share one effective output and hash", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dictex-overlay-parity-"));
  try {
    const options: BuildSttDatasetExportOptions = {
      dictionaryPath: path.join(directory, "dictionary.json"),
      rulesPath: path.join(directory, "rules.json"),
      rulesOverlayPath: path.join(directory, "rules-overlay.json"),
    };
    writeFileSync(options.rulesOverlayPath!, JSON.stringify({
      version: 1,
      bundled_rules_version: 2,
      disabled_rule_ids: ["power-square"],
      replacements: [],
      personal_rules: [{ id: "personal-two", order: 1, pattern: "\\bdeux\\b", replacement: "2", flags: "i" }],
    }), "utf8");
    const normalizer = await createTranscriptNormalizer(options);
    const served = (await normalizer.normalize(LITERAL)).output;
    const exported = await recordsOf(baseEvents(), options);
    assert.equal(exported.mathTransform[0].rawTranscript, served);

    const dataset = await buildSttDatasetExport(baseEvents(), "2026-07-10T00:00:00.000Z", options);
    assert.equal(dataset.normalizerVersion.rulesHash, normalizer.version.rulesHash);
    assert.equal(dataset.normalizerVersion.overlayHash, normalizer.version.overlayHash);
    assert.equal(dataset.normalizerVersion.localRulesHash, normalizer.version.localRulesHash);
    const benchmarkVersion = parseNormalizerBenchmarkVariant(
      buildNormalizerBenchmarkCandidate(normalizer.version).candidate.variant,
    );
    assert.deepEqual(benchmarkVersion, normalizer.version);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("export NEVER touches an acoustic pair (Layer 1 stays verbatim for STT)", async () => {
  const { acoustic } = await recordsOf(baseEvents());
  assert.equal(acoustic.length, 1);
  const pair = acoustic[0];
  assert.equal(containsSentinel(pair.rawTranscript), false);
  assert.equal(containsSentinel(pair.correctedTranscript), false);
  // Neither the normalizer nor extractCommands runs: command words survive spelled
  // out and the maths is NOT rewritten ("au carré" stays "au carré"), exactly as
  // spoken, because Layer 1 is the STT target.
  assert.equal(pair.rawTranscript, RAW_STT);
  assert.equal(pair.correctedTranscript, LITERAL);
});

test("no-sentinel-in-store invariant: building the export never mutates the store", async () => {
  const events = baseEvents();
  const before = JSON.stringify(events);
  await buildSttDatasetExport(events, "2026-07-10T00:00:00.000Z", ABSENT_CONFIG);
  const after = JSON.stringify(events);
  // The append-only event store is untouched by export; normalization and
  // substitution are pure functions applied to the derived training pair only.
  assert.equal(after, before);
  // And no event in the store contains a sentinel character.
  assert.equal(containsSentinel(after), false);
});

test("regenerating the export is deterministic (retroactive correctness by rebuild)", async () => {
  const events = baseEvents();
  const first = JSON.stringify((await recordsOf(events)).mathTransform);
  const second = JSON.stringify((await recordsOf(events)).mathTransform);
  assert.equal(first, second);
});

test("normalizerVersion records bundled, local and effective provenance from the loaded pipeline", async () => {
  // Absent config still has effective hashes; it has no local source hash.
  const absent = await buildSttDatasetExport(baseEvents(), "2026-07-10T00:00:00.000Z", ABSENT_CONFIG);
  assert.match(absent.normalizerVersion.dictionaryHash ?? "", /^[0-9a-f]{64}$/u);
  assert.match(absent.normalizerVersion.rulesHash ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(absent.normalizerVersion.rulesHash, absent.normalizerVersion.bundledRulesHash);
  assert.equal(absent.normalizerVersion.rulesMode, "bundled");
  assert.equal(absent.normalizerVersion.localRulesHash, null);

  // Present config: each hash is the sha256 of the file's bytes, so the dataset is
  // traceable to the exact pipeline version that produced its inputs.
  const dir = mkdtempSync(path.join(tmpdir(), "dictex-issue-100-cfg-"));
  const dictionaryPath = path.join(dir, "dictionary.json");
  const rulesPath = path.join(dir, "rules.json");
  const dictionaryBytes = JSON.stringify({ version: 1, entries: [] });
  const rulesBytes = JSON.stringify({ version: 1, rules: [] });
  writeFileSync(dictionaryPath, dictionaryBytes, { encoding: "utf8" });
  writeFileSync(rulesPath, rulesBytes, { encoding: "utf8" });

  const present = await buildSttDatasetExport(baseEvents(), "2026-07-10T00:00:00.000Z", {
    dictionaryPath,
    rulesPath,
  });
  assert.equal(
    present.normalizerVersion.dictionaryHash,
    createHash("sha256").update(dictionaryBytes).digest("hex"),
  );
  assert.equal(present.normalizerVersion.localRulesHash, createHash("sha256").update(rulesBytes).digest("hex"));
  assert.match(present.normalizerVersion.rulesHash ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(present.normalizerVersion.rulesMode, "legacy");
});
