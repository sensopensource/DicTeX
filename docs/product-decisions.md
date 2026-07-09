# Product Decisions

This document captures the product and implementation context that future agents should preserve when working on DicTeX.

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

### Dataset enrichment view (two-layer capture)

The Dataset view captures **separable** training data for one freshly recorded
clip as two explicit layers, so the acoustic (STT) and math_transform
(normalizer) datasets stay cleanly separable. It writes **two chained
append-only `stt_correction` events** — no new event type:

1. `correction_kind = "acoustic"`: `raw_transcript` = raw STT output,
   `corrected_transcript` = literal-correct transcript (only mishearings fixed;
   notation stays verbal). Feeds the acoustic dataset paired with the audio.
2. `correction_kind = "math_transform"`: `raw_transcript` = the literal
   transcript, `corrected_transcript` = normalized notation. Feeds the
   normalizer dataset as a text→text pair (no audio).

The pipeline stage is encoded by **which field is filled**, not by one blended
tag — a single fully-normalized text would collapse both transformations and
make the datasets non-separable. A layer left empty is skipped rather than
written empty; the notation layer cannot be saved without the literal layer,
since it is its input.

Recording in this view **never touches the clipboard and never pastes**
(`transcribeAudio` is called with `writeClipboard: false` and `autoPaste:
false`) and uses a per-call STT model override that does not change the
persisted global dictation model.

Consequence for consumers: a segment can now carry more than one correction
event. `reconstructRecentSegments` (`app/src/main/localEvents.ts`) uses
latest-event-wins, so history shows only the last kind. **Dataset export (#44)
must read all correction events of a segment, not just the latest.** Do not
"fix" the history derivation for this — history display and dataset extraction
have different needs.

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
sidecar (`engine/providers/`): `faster-whisper` is the first provider, **Vosk**
the second.

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

