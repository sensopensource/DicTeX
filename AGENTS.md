# AGENTS.md

Repository guidance for agents working on DicTeX.

Before changing code, read:

- `README.md`
- `docs/product-decisions.md`
- `docs/development.md`
- `pivot_strategique_stt_normalisation.md` (current strategic direction)
- this file

## Product Context

DicTeX is a local-first dictation layer for mathematical writing.

It is OpenWhispr-like, not document-first. The MVP should not own documents,
notebooks, LaTeX files, or editor state. DicTeX listens, transcribes,
optionally transforms later, inserts into the active application, and stores
local data for future improvement.

Current product loop:

```text
voice -> local STT -> clipboard / active app insertion -> local logs
```

Target product loop (from the strategic pivot):

```text
voice
-> local STT (raw literal text)
-> normalization pipeline
   -> layer 1: personal dictionary (deterministic)
   -> layer 2: regex math-verbalization rules
   -> layer 3: small seq2seq text-to-text model
-> math rendering (KaTeX)
-> fast correction, tagged by correctionKind
-> two separable datasets: acoustic (STT) and math_transform (normalizer)
-> Phase 3 normalizer training, then Phase 4 STT acoustic fine-tuning (later)
```

## Strategic Pivot (current direction)

See `pivot_strategique_stt_normalisation.md`. The plan decouples two problems
previously conflated in a single "fine-tune STT to emit clean math" goal:

- **Priority 1 — text-to-text normalization.** Turn literal STT output
  ("x au carré") into formal notation ("x²") with a three-layer normalizer:
  personal dictionary, regex rules, then a small seq2seq model. Dictionary and
  regex already cover much of the need with zero ML.
- **Priority 2 (later) — STT acoustic fine-tuning.** Only for genuine acoustic
  errors tied to the user's voice/mic, on correction data tagged `acoustic`.

The base dictation loop, logs, diagnostics, history, benchmark, split, and
correction capture are now stable, so this normalization work can start. The
existing infrastructure is reused as-is; nothing is thrown away. Its main data
consequence is that corrections must be typed (see Data Model Notes).

## Current Implementation

Stack:

- Electron desktop app.
- React + TypeScript renderer.
- Python sidecar engine.
- faster-whisper local STT.
- JSONL event logging.
- Local audio segment storage.
- Windows-first auto-paste.
- Global hotkey toggle: `Win+Alt+Space`.

Current flow:

```text
manual button or hotkey
-> browser MediaRecorder captures audio
-> renderer sends bytes to Electron main
-> main saves audio under Electron userData
-> main calls Python sidecar
-> faster-whisper transcribes
-> main writes audio_segment + stt_result to events.jsonl
-> main copies transcript to clipboard
-> hotkey path also sends Ctrl+V on Windows
-> renderer refreshes recent segment history
-> user may replay local audio, save STT correction, or benchmark the segment
```

Current benchmark flow:

```text
latest or selected stored audio segment
-> replay through faster-whisper tiny/base/small
-> show transcript + latency + STT candidate metadata
-> when a corrected transcript exists, compute CER against it
-> append stt_benchmark_result events
```

Current correction flow:

```text
latest transcript or recent segment
-> user edits transcript in compact UI
-> main appends stt_correction to events.jsonl
-> history derives corrected/raw state from append-only events
```

Current history/playback flow:

```text
events.jsonl
-> local event reader reconstructs recent segments by session_id + segment_id
-> renderer shows recent dictations
-> user can copy raw/corrected transcript, replay stored audio, or benchmark a segment
```

Local runtime data path on this machine:

```text
C:\Users\souid\AppData\Roaming\dictex-app\data
```

Important runtime files:

```text
C:\Users\souid\AppData\Roaming\dictex-app\data\events.jsonl
C:\Users\souid\AppData\Roaming\dictex-app\data\audio\
```

## Development Commands

From repo root:

```powershell
cd app
..\scripts\npm.cmd run typecheck
..\scripts\npm.cmd run build
..\scripts\npm.cmd run dev
```

Python venv exists locally at:

```text
C:\Users\souid\DicTeX\.venv
```

Use pip with truststore on this machine:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r engine\requirements.txt
```

Do not use `strict-ssl=false`.

## Git Workflow

Main repo:

```text
C:\Users\souid\DicTeX
https://github.com/sensopensource/DicTeX
```

Rule:

```text
one agent = one clone = one folder = one branch = one PR
```

When told to solve an issue, the implementing agent does not work in the main
checkout. It clones the repo into a fresh sibling folder and works entirely
there. Parallel agents are then isolated by construction: they never share a
working directory and cannot collide.

```text
git clone https://github.com/sensopensource/DicTeX.git ../DicTeX-issue-<N>
cd ../DicTeX-issue-<N>
git checkout -b issue-<N>-<slug>
```

Then read README.md, docs/product-decisions.md, docs/development.md, AGENTS.md,
and the assigned issue; do the work in that folder; push the branch and open a
PR; do not merge.

## Agent Reasoning Levels

Issues are labeled with the reasoning capability an agent needs to do the work
well. The scale is provider-neutral: the shared lever is **reasoning effort**,
mapped to a representative model per provider so either a Claude agent or an
OpenAI/Codex agent can pick up the work.

### Scale

Four levels, French names kept as the label surface:

- `level:faible` — low effort, mechanical or well-patterned change.
- `level:moyen` — medium effort, some design/UI judgment.
- `level:eleve` — high effort, correctness- or data-integrity-critical.
- `level:tres-eleve` — maximum effort, defines core semantics or has a high
  cost of error.

Modifier label (orthogonal, not a fifth level):

- `needs:high-review` — after implementing, the agent must flag that a
  higher-tier review is needed and suggest a reviewer model/level; a separate
  human-chosen session does the review before merge.

### How a level is assigned

Score the issue 1–4 on five axes, then aggregate:

- **A. Cognitive complexity** (Bloom): 1 = apply a known pattern; 4 = design or
  evaluate open-ended choices.
- **B. Spec uncertainty**: 1 = closed, unambiguous spec; 4 = under-specified,
  product decisions required.
- **C. Blast radius / reversibility**: 1 = one isolated file, reversible; 4 =
  core semantics, append-only history, or data integrity.
- **D. Horizon / steps**: 1 = single step; 4 = multi-step across modules.
- **E. Cost of an error**: 1 = cosmetic; 4 = corrupts data or invalidates an
  evaluation.

Aggregation rule: if axis **C** or **E** is 4, the level is at least
`level:eleve`; otherwise use the rounded mean of the five axes. The max on a
critical axis dominates the average on purpose.

### Level to model + reasoning effort

Reasoning effort is the primary lever; the model is the representative tier per
provider. Model IDs evolve — treat them as "current best fit for this tier" and
prefer the latest capable model in the family.

| Level              | Reasoning effort        | Claude (this agent) | OpenAI / Codex             | Review           |
| ------------------ | ----------------------- | ------------------- | -------------------------- | ---------------- |
| `level:faible`     | low / minimal           | Haiku 4.5           | gpt-5-mini / gpt-5-codex (low)   | auto             |
| `level:moyen`      | medium                  | Sonnet 5            | gpt-5-codex (medium)       | auto             |
| `level:eleve`      | high                    | Opus 4.8            | gpt-5-codex (high)         | recommended      |
| `level:tres-eleve` | max / extended thinking | Opus 4.8 (max)      | gpt-5-codex (high, max)    | human, mandatory |

Notes:

- A Codex agent should stay within its own model family (OpenAI) and read the
  effort column, not the Claude model names.
- Label slugs are unaccented for clean CLI/URL handling; the display intent is
  faible / moyen / élevé / très élevé.

### Operating protocol (single agent, one session)

The intended workflow is one agent, in one terminal session, from workspace
setup to PR. The human sets the model and reasoning effort at launch (per the
level table) and owns review and merge. When told to work an issue, the agent
runs this protocol itself:

1. **Set up an isolated workspace.** Clone the repo into a fresh sibling folder
   and create the issue branch there (see Git Workflow). Do all work in that
   clone, never in the main checkout.
2. **Dependency guard.** Read the issue's `Depends on:` line (see Issue
   Orchestration). For each referenced issue, verify it is CLOSED (merged). If
   any is still open, STOP, report "blocked by #X", and write no code.
3. Read the issue and find its `level:*` label.
4. Confirm the current model/effort fits that level (the human set it at
   launch). If clearly under-powered for the level, say so instead of pushing
   ahead.
5. Do the work and open the PR.
6. Check the issue for `needs:high-review`.
7. If present, do NOT self-review and do NOT change your own effort. Finish the
   work, then in the PR and final report **flag that a review is required and
   propose a reviewer model + reasoning level** — one notch above your own
   current model/effort (e.g. a `level:moyen` agent on Sonnet/medium suggests
   review on Opus/high). The human chooses the reviewer and launches it.
8. Finalize the PR with that recommendation surfaced. Do not merge.

Notes on review:

- The implementer never changes its own reasoning effort mid-session and never
  reviews its own work. Effort is fixed by the human at launch.
- `needs:high-review` only obligates the implementer to surface the need and a
  suggested reviewer tier; a separate human-chosen session does the review.
- A human always owns final merge approval.

## Issue Orchestration

Two distinct roles. The section above governs the **implementer** (one agent,
one issue). This section governs the **orchestrator** (one powerful agent that
plans the next batch of issues) and how dependencies are tracked so parallel
implementer sessions never collide.

There is no GitHub-native blocking. Dependencies live as plain text in the issue
body and are enforced by the implementer's step-0 guard. This keeps everything
provider-neutral (Claude and Codex both read it) and needs no extra tooling.

### Dependency line (source of truth)

Every issue that depends on others carries one machine-parsable line in its body:

```text
Depends on: #38, #39
```

Rules:

- One line, comma-separated issue numbers. Omit the line if there are no hard
  dependencies.
- A dependency means "must be CLOSED before this issue can start", nothing else.
- This replaces prose `## Dependencies` sections. Keep prose context if useful,
  but the `Depends on:` line is what agents parse.
- Only list **hard** dependencies (real ordering). Soft "works better after"
  relationships are notes, not `Depends on:` entries.

### Orchestrator responsibilities

First read the live issue state with `gh` (open/closed issues, labels, and
`Depends on:` lines) — the roadmap snapshot in this file may be stale.

When asked to plan the next N issues, the orchestrator:

1. Writes each issue with clear Goal / Scope / Out of scope / Acceptance
   criteria.
2. Scores each with the five-axis rubric and applies the correct `level:*` label
   (plus `needs:high-review` when a higher-tier review is warranted).
3. Adds a `Depends on:` line listing only hard dependencies.
4. Proposes a model per issue from the level table (Claude and OpenAI/Codex
   columns), so any provider can pick it up.
5. Emits a **launch plan in waves** — which issues are startable now in parallel
   vs which must wait:

```text
Wave 1 (ready now, parallel): #42 (faible), #38 (élevé)
Wave 2 (after #38):           #39 (très-élevé)
Wave 3 (after #39):           #40 (moyen), #41 (moyen)
```

6. Flags **soft conflicts**: issues with no hard dependency that still touch the
   same files/module. These are not `Depends on:` entries; they are a note to
   sequence them, since separate clones still merge-conflict on shared files.

### How a dependency clears

No status label to maintain. When an issue is merged and its GitHub issue is
CLOSED, its dependents become startable automatically: the next implementer's
step-0 guard sees the dependency is CLOSED and proceeds. If launched too early,
the guard stops the agent before any code is written. The `Depends on:` line is
the only thing to keep correct.

## Completed Work

Issue #1 / PR #2:

- Built initial Electron + React app scaffold.
- Added audio capture.
- Added Python sidecar boundary.
- Integrated faster-whisper.
- Added local STT event logging.
- Merged.

Issue #3 / PR #4:

- Added global toggle hotkey.
- Default shortcut: `Win+Alt+Space`.
- Added Windows auto-paste via clipboard + PowerShell SendKeys Ctrl+V.
- Added `docs/product-decisions.md`.
- Merged.

Issue #5 / PR #7:

- Replaced demo/landing UI with compact utility UI.
- Added visible dictation status, hotkey status, STT config, latency, session, segment, audio duration, and paste result.
- Added buttons to open data folder and events log.
- Merged.
- Note: #7 was preferred visually over #6. Preserve the compact dark utility direction unless a later issue explicitly changes it.

Issue #8 / PR #9:

- Added STT benchmark mode.
- Replays the latest stored audio segment through faster-whisper `tiny`, `base`, and `small`.
- Shows transcript + latency.
- Appends `stt_benchmark_result` events.
- Merged.

Issue #10 / PR #36:

- Added GitHub Actions app CI.
- Runs app `npm ci`, `typecheck`, and `build` on PRs and pushes to `main`.
- Added Windows MVP smoke test checklist in `docs/development.md`.
- Merged through integration PR #36.

Issue #21 / PR #36:

- Added shared local JSONL event reader.
- Reconstructs recent segments from append-only events.
- Keeps latest audio lookup distinct from full segment reconstruction.
- Merged through integration PR #36.

Issue #11 / PR #36:

- Added compact recent segment history.
- Shows timestamp, session, segment, transcript, STT model/language, duration, latency, correction state.
- Supports copying historical transcripts.
- Merged through integration PR #36.

Issue #12 / PR #36:

- Added append-only `stt_correction` events.
- Saves keyboard corrections for transcripts without mutating `stt_result`.
- Merged through integration PR #36.

Issue #13 / PR #36:

- Added STT benchmark candidate metadata.
- Current candidate identity includes `stage`, `provider`, `model`, and `variant`.
- Preserves existing STT fields for compatibility.
- Merged through integration PR #36.

Issue #14 / PR #36:

- Added selected-segment STT benchmarking from history.
- Keeps `Benchmark latest` as a convenience.
- Associates benchmark results with selected `session_id` and `segment_id`.
- Merged through integration PR #36.

Issue #22 / PR #36:

- Shows correction state in segment history.
- Displays latest corrected transcript while preserving raw transcript.
- Merged through integration PR #36.

Issue #23 / PR #36:

- Added local audio playback from recent segment history.
- Resolves audio refs through the main process and keeps refs inside Electron userData/data.
- Merged through integration PR #36.

Issue #24 / PR #36:

- Scores STT benchmark outputs against corrected transcripts using CER.
- Scores only the STT stage when an `stt_correction` exists.
- Appends score metadata alongside `stt_benchmark_result`.
- Merged through integration PR #36.

Issue #37 / PR #46:

- Added correction of selected historical segments.
- Merged.

Issue #38:

- Added corrected STT benchmark set membership.
- Append-only split metadata: `train_candidate_pool`, `validation`,
  `test_frozen`, with latest-event-wins derivation.
- Completed.

Issue #42 / PR #51:

- Made faster-whisper STT benchmark candidates configurable via
  `DICTEX_STT_BENCHMARK_MODELS`.
- Merged.

Issue #48 / PR #52:

- Added typed corrections: required `correction_kind`
  (acoustic / math_transform / normalization / rephrasing) on `stt_correction`
  events, mandatory UI selector on both correction paths, untyped legacy
  events surface as null.
- Merged. Pivot Phase 1 done.

Issue #39 / PR #53:

- Benchmarked STT candidates over the corrected benchmark set.
- Merged.

Open roadmap (labels + hard deps). Per the strategic pivot, STT fine-tuning is
deferred to Phase 4, so #44/#45 are Phase-4 prep, not the near-term goal:

- #40 summarize results by candidate — `level:moyen`, Depends on #39 (done) ->
  ready.
- #41 lightweight error analysis — `level:moyen` + `needs:high-review`,
  Depends on #39 (done) -> ready.
- #43 candidate selection report — `level:moyen` + `needs:high-review`,
  Depends on #40.
- #44 export corrected datasets — `level:eleve`, Depends on #43. Phase 4 prep;
  export should also split by `correctionKind`.
- #45 plan first fine-tuning experiment — `level:faible` + `needs:high-review`,
  Depends on #44. Phase 4; conditional on enough `acoustic`-tagged data.
- #49 normalizer module + personal dictionary (layer 1) — `level:eleve` +
  `needs:high-review`, no hard dependency -> ready. Pivot Phase 2.
- #50 regex math-verbalization rules (layer 2) — `level:moyen`, Depends on #49.
  Pivot Phase 2.

Startable now in parallel: #49, #40, #41. Soft conflict: all three touch the
same app source files (the app is only four source files), so separate clones
will merge-conflict — launch in parallel but merge sequentially and rebase.

## Product Decisions To Preserve

Do preserve:

- OpenWhispr-like dictation layer.
- Session-first, not document-first.
- `session_id` + `segment_id`, not `document_id`, in the MVP core path.
- Audio + raw STT outputs before correction UX.
- Append-only event history.
- Corrections typed by `correctionKind` (acoustic / math_transform /
  normalization / rephrasing), keeping acoustic and semantic problems separable.
- French-first spoken input.
- English public docs for GitHub discoverability.
- Windows-first auto-paste, Linux later.
- Compact utility UI direction.
- Benchmarking as an evaluation loop, not just a developer tool.

Do not introduce without an explicit issue:

- document ownership;
- internal rich document editor;
- Tauri migration;
- SQLite migration;
- math parsing;
- LaTeX generation;
- LLM provider integrations;
- API key handling;
- fine-tuning;
- cloud sync;
- multi-user backend.

The strategic pivot sanctions the normalization pipeline (dictionary, regex,
small seq2seq) and math rendering as the Priority 1 direction — still land them
through explicit issues, not ad hoc.

## UI Direction

Target feel:

- compact;
- sober;
- utility-like;
- close to OpenCode/OpenWhispr;
- minimal colors;
- clear state;
- diagnostics visible but not noisy.

Avoid:

- landing-page hero;
- gradients;
- big decorative typography;
- generic AI SaaS dashboard feel;
- broad settings pages too early.

Useful visible information:

- status: ready, recording, transcribing, copied/pasted, error;
- hotkey status;
- STT engine/model/language;
- last session and segment;
- latency;
- audio duration;
- output mode: pasted or clipboard;
- recent segment history;
- correction status;
- benchmark results;
- buttons to open data folder and events log.

## Data Model Notes

Current JSONL event types include:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_mime_type":"audio/webm;codecs=opus","audio_size_bytes":12345}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stt_engine":"faster-whisper","stt_model":"base","stt_language":"fr","stt_output":"...","corrected_transcript":null,"audio_duration_seconds":1.23,"transcription_duration_ms":900}
```

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830}
```

Current benchmark events also include candidate metadata and may include STT scoring metadata:

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830,"score_metric":"cer","score_value":0.12,"score_reference_type":"stt_correction"}
```

Current STT corrections use separate event types and must not overwrite history:

```json
{"event_type":"stt_correction","created_at":"2026-07-05T00:00:00.000Z","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","raw_transcript":"...","corrected_transcript":"...","correction_method":"keyboard"}
```

Corrections stay append-only and must not overwrite history.

Future correction typing (from the strategic pivot): tag each correction with a
`correctionKind` so acoustic and semantic problems feed different datasets:

- `acoustic`: the STT misheard (e.g. "égalé" -> "égal"). Feeds Phase 4 STT
  fine-tuning.
- `math_transform`: spoken text -> notation (e.g. "x au carré" -> "x²"). Feeds
  Phase 3 normalizer training.
- `normalization`: cleanup (e.g. "euh donc on a" -> "on a").
- `rephrasing`: free user rewording.

Prefer extending the existing `stt_correction` event with `correctionKind` over
inventing separate event types. The `train_candidate_pool` / `validation` /
`test_frozen` split is kept and read alongside `correctionKind` to build each
dataset.

## Benchmark Vision

Do not let the benchmark architecture get stuck as "Whisper base vs Whisper small".

That is only the first useful benchmark because the current implemented layer is STT. The long-term goal is to compare candidates by pipeline stage:

```text
segment audio/transcript
-> STT candidates
-> normalization candidates
-> segment classification candidates
-> math transform candidates
-> correction suggestion candidates
```

Benchmark identity should move toward:

```text
stage + provider + model + variant
```

Examples:

```json
{"stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr"}
```

```json
{"stage":"math_transform","provider":"qwen","model":"qwen2.5-coder","variant":"local"}
```

```json
{"stage":"math_transform","provider":"claude","model":"claude-sonnet","variant":"remote"}
```

Important nuance:

- Whisper/faster-whisper belongs to STT.
- Mistral, Qwen, Claude, OpenAI, or local rules would usually belong to math transform, normalization, or correction suggestion stages.
- Do not compare incompatible stages as if they produce the same artifact.
- Do compare candidates within the same stage for the same segment.

Implement this progressively. Do not build a large generic benchmark framework before the product needs it, but avoid hardcoding assumptions that make future model-vs-model comparisons awkward.

## STT Notes

Default config:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

Current STT benchmark candidates (defaults, configurable via
`DICTEX_STT_BENCHMARK_MODELS` since PR #51):

- faster-whisper/tiny
- faster-whisper/base
- faster-whisper/small

These are current candidates, not the final benchmark universe.

## Next Product Priorities

The correction/evaluation loop (#11-#14, #21-#24) merged through PR #36.
Corrected-segment correction (#37) and benchmark-set membership (#38) are done,
so the foundations the pivot relies on are in place.

Priorities now follow the strategic pivot's phasing:

1. **Phase 1 — typed correction data (done, issue #48 / PR #52).**
   `correctionKind` is now required on every new correction; unlabeled data is
   no longer collected.
2. **Phase 2 — code normalizer (layers 1 & 2, issues #49 and #50) — next.**
   Personal dictionary + regex math-verbalization rules. Immediate
   rendering-quality gains, zero ML.
3. **Phase 3 — ML normalizer (layer 3).** After some usage, extract the
   `math_transform`-tagged dataset and fine-tune a small seq2seq model.
4. **Phase 4 — STT acoustic fine-tuning.** Extract the `acoustic`-tagged
   dataset; if residual acoustic errors justify it, LoRA the selected STT model
   on that clean data only.

The STT benchmark -> selection track (#39-#43) stays valid as evaluation
infrastructure: it picks the base STT model the normalizer sits on top of, and
#44/#45 prepare Phase 4. Run it in parallel, but Phase 1 (typed data) is the
immediate next step.

Other still-unissued candidates: event-log diagnostics and invalid-line
visibility; safer correction UX for older segments; a small benchmark result
history per segment. Land each phase through explicit issues; do not build a
large generic framework ahead of need.

## Important Nuance

The user cares about not losing correction and improvement data. Even before correction UI exists, preserve raw audio, raw STT outputs, benchmark outputs, and later human corrections.

If a future feature changes how outputs are generated, preserve enough intermediate state to know which layer made the mistake.
