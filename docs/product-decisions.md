# Product Decisions

This document captures the product and implementation context that future agents should preserve when working on DicTeX.

## DicTeX / Lab split (monorepo)

DicTeX is being split into two Electron apps in one npm-workspaces monorepo
(see `pivot_dictex_lab_split.md` / AGENTS.md "Current Direction"):

- **`apps/dictex`** — the consumer dictation tool (voice → STT → normalizer →
  insert). Has the microphone, hotkey, clipboard/paste, and normalizer.
- **`apps/lab`** — **DicTeX Lab**, the ML tooling app (pivot Phase 2, #76). No
  microphone: it hosts the STT benchmark (segment/batch, summary, error
  analysis, candidate selection), typed corrections, benchmark-set split
  membership, the Vosk provider, and the dataset export.

Data contract (one-directional, file-based, zero code coupling): the Lab reads
DicTeX's local data folder **read-only** (audio + `stt_result` /
`normalization_result` events) and keeps its **own** store for everything it
writes — corrections, splits, benchmark results, candidate selections, dataset
exports, and its own settings — under its own Electron `userData`
(`%APPDATA%/dictex-lab-app/data`), never DicTeX's `%APPDATA%/dictex-app/data`.
The DicTeX data folder path is configurable in the Lab (default
`%APPDATA%/dictex-app/data`). Both apps import all derivation/scoring/export
logic from `packages/shared` so the two apps cannot diverge; DicTeX never
depends on the Lab.

Phase 2 (#76) **adds** the Lab and factors the shared logic; it deliberately
does **not** remove the benchmark/dataset/correction/split features from
`apps/dictex` — that is Phase 3 (#77). So those features temporarily exist in
both apps, kept DRY by the shared package.

## Product Shape

DicTeX is an OpenWhispr-like dictation layer for mathematical writing.

It is not document-first. In the MVP, DicTeX should not own, manage, or edit full documents. It listens, transcribes, transforms later, and inserts output into the currently active application.

Current product loop:

```text
voice
-> local STT
-> clipboard / active app insertion
-> local event logging
-> future correction and improvement
```

Future product loop:

```text
voice
-> local STT
-> paragraph/math/command detection
-> text + LaTeX
-> fast correction
-> correction logs
-> rules/prompts/fine-tuning later
```

## Current MVP Reality

The implementation currently uses:

- Electron + React + TypeScript for the desktop app.
- Python sidecar for the local STT engine.
- faster-whisper as the local STT engine.
- JSONL event logging for local data capture.
- Windows-first auto-paste.

Do not migrate to Tauri, SQLite, or a document editor unless there is a specific issue for that migration.

## Data Model Decisions

The MVP is session-first, not document-first.

Use:

```text
session_id
segment_id
audio_ref
stt_result
```

Do not introduce `document_id` into the MVP core path. DicTeX outputs into external apps, so it usually does not know or own the target document.

Each dictation should preserve the audio -> STT output link:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm"}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_output":"...","corrected_transcript":null}
```

This is important even before correction UI exists, because these records are the basis for later STT evaluation and fine-tuning.

## Correction Strategy

Correction is a first-class product concept, but not all correction layers should be implemented immediately.

Keep these layers separate:

- STT correction: audio + raw STT output + corrected transcript.
- Math parsing correction: spoken text + predicted LaTeX + corrected LaTeX.
- Output correction: final inserted text corrected by the user.

Do not collapse all corrections into a single final-output edit, or future training data will be ambiguous.

Store `corrected_transcript: null` in `stt_result` for compatibility, but write human transcript corrections as separate `stt_correction` events. Do not mutate older `stt_result` records.

### Dataset enrichment recording — removed (DicTeX/Lab split)

The in-app two-layer audio→text *recording* capture (issue #66) has been
**removed** from DicTeX. Per the current pivot (see
`pivot_dictex_lab_split.md`), dataset building and benchmarking move to a
separate **DicTeX Lab** app, and DicTeX stays a lean consumer dictation tool.
The Lab has no microphone: it consumes DicTeX's real transcriptions and reads
DicTeX's local data folder. The Dataset view in DicTeX now only exposes the
local dataset **export** (#44) of already-captured corrections, until the Lab
takes that over too.

The two-layer separability principle itself is preserved — it just lives in the
Lab now: acoustic pairs (audio → literal-correct transcript) and math_transform
pairs (literal text → normalized notation) stay separable by encoding the
pipeline stage in which field is filled, still as chained append-only
`stt_correction` events.

## UI Direction

The UI should feel like a compact utility app, not a landing page, dashboard, or marketing site.

Preferred direction:

- sober;
- compact;
- functional;
- information-dense but not cluttered;
- close to tools like OpenCode/OpenWhispr;
- minimal colors;
- clear status and diagnostics.

Avoid:

- large hero sections;
- gradient-heavy marketing screens;
- decorative animations;
- generic AI SaaS layouts;
- document-editor complexity in the MVP.

Useful visible information:

- current status: ready, recording, transcribing, pasted, error;
- global shortcut;
- STT engine/model/language;
- last session and segment;
- transcription duration;
- paste result;
- recent segment history;
- correction state;
- benchmark results;
- data folder / events log access.

## Shortcut And Insertion Decisions

Default global shortcut:

```text
Win+Alt+Space
```

It is a toggle:

```text
press once -> start recording
press again -> stop, transcribe, paste
```

Global push-to-talk is intentionally deferred because global key release handling is less reliable cross-platform.

Windows auto-paste is implemented first. Linux auto-paste should be a separate issue. On unsupported platforms, copying to clipboard is acceptable.

## STT Decisions

Default STT configuration:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

French is the first spoken language target. English documentation is still preferred for GitHub discoverability.

Future model comparison should be based on actual stored segments, not assumptions. Useful candidates:

- tiny;
- base;
- small.

Fine-tuning should not happen before enough clean local correction data exists.

## Benchmark Candidates

Benchmarking is stage-aware. A benchmark candidate is identified by:

```text
stage + provider + model + variant
```

Current implemented candidates are STT candidates, for example:

```json
{"stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr"}
```

Future candidates may belong to other stages, such as normalization, segment classification, math transform, or correction suggestion. They can include local STT engines, local LLMs, remote LLMs, or rule-based transforms, but candidates should only be compared within the same stage for the same segment.

Do not treat a Whisper STT transcript and a Claude or Qwen math-transform output as the same kind of benchmark artifact. They may share benchmark metadata, but their stage defines what output is being evaluated.

### Second local STT provider (Vosk)

The STT benchmark universe must not stay "Whisper base vs Whisper small". To make
it genuinely multi-provider, a second local STT engine was added as a
benchmark-only candidate behind a small provider abstraction in the Python
sidecar (`packages/engine/providers/`): `faster-whisper` is the first provider,
**Vosk** the second.

Why Vosk:

- Different engine family (Kaldi/DNN-HMM), not another Whisper flavour, so the
  benchmark compares real alternatives instead of variants of one model.
- Fully local and offline; pip-installable wheel on Windows with no compilation.
- French acoustic models are available (e.g. `vosk-model-small-fr-0.22`), and it
  is CPU-friendly and lightweight.

Rejected alternatives:

- **whisper.cpp** — still Whisper (same family), and the Windows path needs a
  compiled binary / build toolchain, contrary to the pip-only local setup.
- **Moonshine** — English-only today; the product is French-first.
- **NeMo / other large toolkits** — heavy dependency footprint and not
  CPU-lightweight, disproportionate for a benchmark-only candidate.

Constraints kept:

- Benchmark-only. `faster-whisper` remains the dictation engine; switching the
  dictation engine would be its own issue, justified by the candidate selection
  report.
- Optional at runtime. If the `vosk` package or the local model files are
  absent, the Vosk candidate is skipped with a quiet diagnostic; dictation and
  faster-whisper benchmarking are never blocked.
- Candidate identity is unchanged: `stage="stt"`, `provider="vosk"`,
  `model=<vosk model name>`, `variant="cpu-<language>"` (Vosk is CPU-only, so no
  compute-type dimension). Vosk expects 16 kHz mono PCM and does not decode
  compressed audio, so the sidecar decodes stored segments with PyAV (already a
  faster-whisper dependency) — no new decode dependency.

Setup and env vars are documented in `docs/development.md`
("Second STT provider (Vosk)").

## Corrected dataset export

The Dataset view can export the corrected STT dataset to local JSONL files, in
preparation for Phase 3 normalizer training and Phase 4 STT acoustic
fine-tuning. It only reads the append-only event log and writes new files under
`data/exports/stt-dataset-<timestamp>/`; it never rewrites event history and
never uploads anything.

Decisions:

- The fine-tuning target is `audio -> corrected_transcript` (the human
  reference), not `model transcript -> corrected_transcript`. Model transcripts
  stay useful for benchmarking/error analysis, but the acoustic target is the
  human transcript.
- Records are partitioned by benchmark split (`train_candidate_pool`,
  `validation`, `test_frozen` — frozen test always in its own files) **and** by
  `correction_kind`. Files are named `<split>.<correction_kind>.jsonl`, so the
  acoustic (STT) dataset and the math_transform (normalizer) dataset land in
  distinct files and stay separable.
- The export reads **all** correction events of a segment, taking the latest
  correction of **each** kind — not the single latest event. A segment enriched
  by #66 carries chained `acoustic` + `math_transform` corrections; collapsing to
  the last event would silently drop the acoustic pair. Within one kind,
  latest-event-wins still applies so a re-correction supersedes its predecessor.
- Untyped legacy corrections (no `correction_kind`) cannot be routed into a
  kind-partitioned dataset, so they are skipped and their count is reported in
  the manifest and UI rather than dropped silently.
- Each record is traceable to its source events: `session_id`, `segment_id`,
  `audio_ref`, resolved absolute `audio_path`, `raw_transcript` and
  `corrected_transcript` (the transform's input/target), `original_stt_output`
  (the raw STT even when a chained correction's own raw text is a later literal
  transcript), `language`, `correction_kind`, `correction_created_at`, and the
  selected base candidate metadata. A `manifest.json` records per-split /
  per-kind counts and the selection. Export proceeds even when no base candidate
  has been selected yet (`selected_candidate` is then null and the UI notes it).

## Math Parsing Decisions

Math parsing is not part of the current working loop yet.

Do not add spoken-math-to-LaTeX until these foundations are stable:

- local dictation loop;
- hotkey and insertion;
- STT event logging;
- compact utility UI;
- basic diagnostics/settings.

When math parsing starts, keep the scope narrow:

- variables;
- arithmetic;
- fractions;
- powers;
- roots;
- indices;
- parentheses;
- simple equations.

Ambiguity is expected. Future correction UX should make it easy to choose or correct parse scope.

## Agent Handoff Guidance

When handing a task to another agent, tell it to read at least:

- `README.md`
- `docs/product-decisions.md`
- `docs/development.md`
- the GitHub issue it is implementing

Good tasks for another agent:

- tightly scoped UI improvements;
- diagnostics display;
- settings fields;
- tests/build fixes;
- documentation updates;
- isolated bug fixes.

Risky tasks without human review:

- changing the data model;
- introducing document ownership;
- replacing Electron/Tauri stack;
- adding math parsing too early;
- changing correction semantics;
- changing privacy/storage defaults.

If an implementation conflicts with this document, update the document in the same PR and explain the product reason.

