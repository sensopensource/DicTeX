# AGENTS.md

Repository guidance for agents working on DicTeX.

Before changing code, read:

- `README.md`
- `docs/product-decisions.md`
- `docs/development.md`
- `pivot_dictex_lab_split.md` (**current strategic direction** — DicTeX/Lab split)
- `pivot_strategique_stt_normalisation.md` (normalization strategy; still valid,
  but its dataset/benchmark tooling now lives in the Lab, not in DicTeX)
- `docs/dataset-and-normalization-design.md` (**settled data design**: verbatim
  Layer 1, split semantics, command sentinels, how to produce the data). Read it
  before adding a correction kind, a normalizer layer, or a dataset export field.
- this file

## Current Direction: DicTeX / Lab split (adopted 2026-07-09)

See `pivot_dictex_lab_split.md`. DicTeX had grown into two products in one — a
consumer dictation tool **and** an ML bench — and that coupling is the main
source of complexity and bugs. We are splitting them:

- **DicTeX = minimal consumer dictation tool**: voice → STT → normalizer
  (dictionary + regex) → insert. Plus a collapsible copy/copy-raw/play history
  and an **"Open Lab"** button. Nothing ML-ops.
- **DicTeX Lab = separate app** for all benchmark + dataset-building + model
  monitoring. No microphone: it reads DicTeX's real transcriptions and local
  data folder.
- **Monorepo** (`apps/dictex`, `apps/lab`, `packages/engine`, `packages/shared`);
  the Lab reads DicTeX's data folder read-only.

This supersedes the "in-app dataset enrichment / benchmark inside DicTeX"
direction. The normalization strategy below is unchanged; only *where* its
evaluation/training tooling lives moves out of the consumer app. Roadmap +
waves are under "Open roadmap".

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

## Normalization Strategy (still valid, tooling now in the Lab)

See `pivot_strategique_stt_normalisation.md`. This decoupling of the *product*
problem is unchanged; only its dataset/benchmark tooling moves to the Lab (see
"Current Direction" above). The plan decouples two problems previously conflated
in a single "fine-tune STT to emit clean math" goal:

- **Priority 1 — text-to-text normalization.** Turn literal STT output
  ("x au carré") into formal notation ("x²") with a three-layer normalizer:
  personal dictionary, regex rules, then a small seq2seq model. Dictionary and
  regex already cover much of the need with zero ML.
- **Priority 2 (later) — STT acoustic fine-tuning.** Only for genuine acoustic
  errors tied to the user's voice/mic, on correction data tagged `acoustic`.

The base dictation loop, logs, diagnostics, and the dictionary + regex normalizer
are stable in DicTeX. Benchmark, split, dataset export, and typed-correction
capture still exist but are being **moved out to the Lab** (see Open roadmap);
they are not thrown away, just relocated. The in-app two-layer *recording*
(#66) has been removed (Phase 0).

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
-> user may replay local audio or copy the raw / inserted transcript
   (corrections + benchmark now live in DicTeX Lab, not DicTeX)
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
C:\Users\souid\AppData\Roaming\dictex-app\data\normalizer\dictionary.json
C:\Users\souid\AppData\Roaming\dictex-app\data\settings.json
```

## Development Commands

DicTeX is an npm-workspaces monorepo (`apps/dictex`, `packages/engine`,
`packages/shared`). Run npm from the repository root; the root `package.json`
holds the workspaces list and delegates `typecheck` / `build` / `dev` to
`apps/dictex`:

```powershell
scripts\npm.cmd install
scripts\npm.cmd run typecheck
scripts\npm.cmd run build
scripts\npm.cmd run dev
```

There is one root `package-lock.json`; the app has no separate lockfile.

Python venv exists locally at the repository root (not inside a workspace):

```text
C:\Users\souid\DicTeX\.venv
```

The Electron main process resolves the repo root at runtime (four levels up
from the built `apps/dictex/out/main`) and looks for the engine at
`packages/engine/transcribe.py` and Python at `<repoRoot>/.venv`. Keep the venv
at the repo root.

Use pip with truststore on this machine:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements.txt
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

Issue #41 / PR #54:

- Added lightweight STT benchmark error analysis.
- Merged.

Issue #49 / PR #55:

- Added the normalizer pipeline module with the personal dictionary layer
  (layer 1), `normalization_result` events with per-layer state, passthrough
  on missing/invalid dictionary. Pivot Phase 2, layer 1 done.
- Merged.

Issue #40 / PR #56:

- Summarized corrected STT benchmark results by candidate.
- Merged.

GPU STT (no issue, direct docs+engine commit):

- `packages/engine/transcribe.py` makes `cublas64_12.dll` discoverable from the
  `nvidia-cublas-cu12` pip package on Windows, enabling
  `DICTEX_STT_DEVICE=cuda`; setup documented in `docs/development.md`.

Issue #50 / PR #62:

- Added the regex math-verbalization rules layer (layer 2) to the normalizer.
  Pivot Phase 2, layers 1 & 2 now done.
- Merged.

Issue #57 / PR #61:

- Select the active STT model from the UI. Model selector in the controls
  panel (`main.tsx`), listing `tiny`/`base`/`small`/`large-v3-turbo`, persisted
  and applied to the next dictation.
- Merged. The shell refactor #63 keeps it on the Home view.

Issue #43 / PR #60:

- Added STT candidate selection: a new append-only `stt_candidate_selection`
  event (`stage`/`provider`/`model`/`variant`/`selection_reason`), a
  "Select"/"Reselect" action on the existing candidate summary panel (#40),
  and a banner showing the current selection + reason. No new panel needed —
  the summary table already gave the comparison data.
- Merged.

Issue #59 / PR #68:

- Added Vosk (Kaldi-based) as a second local, benchmark-only STT provider,
  behind a minimal provider abstraction in the Python sidecar
  (`packages/engine/providers/`). faster-whisper output stays byte-identical; Vosk
  candidates are optional at runtime (quiet skip if uninstalled) and never
  block dictation or faster-whisper benchmarking.
- Documented in `docs/product-decisions.md` ("Second local STT provider
  (Vosk)") and `docs/development.md`.
- Merged.

Issue #63 / PR #67:

- UI shell: split the single-screen renderer into three task-focused views —
  Home (dictation, controls, diagnostics, collapsible history, correction),
  Benchmark (segment/batch benchmark, summary, error analysis — moved
  unchanged), Dataset (placeholder for #66). Simple `useState` navigation, no
  routing library.
- Merged. Keystone for the UI refactor track.

Issue #64 / PR #69:

- Benchmark view: 1-3 candidate checkbox selector (sourced from
  `getSttBenchmarkModels`) + dataset selector (`test_frozen` default,
  `validation` available); "Run analysis" scopes the batch run (filtered in
  the main process, to avoid wasted transcription work) and the candidate
  summary (filtered client-side) to the checked candidates.
- Covers the intent of #58 without modifying or closing it.
- Merged.

Issue #65 / PR #70:

- Benchmark view: graceful empty states for the candidate summary and
  error-analysis panels (pre-run, and "segments exist but none match the
  checked candidates"), reacting to the #64 candidate/dataset selection.
  `analyzeBatchErrors` semantics untouched.
- Covers the intent of #43's original UI-layout ask (the underlying feature
  itself landed separately via #43/PR #60 above).
- Merged.

Pivot Phase 0 (PR #74, merged to main directly):

- Removed the buggy in-app two-layer audio->text *recording* capture (#66):
  Dataset view reduced to export-only, `transcribeAudio` model/writeClipboard
  options reverted, capture CSS removed (net -402 lines).
- Recorded the DicTeX/Lab split plan in `pivot_dictex_lab_split.md`.
- Done.

Pivot Phase 1 (#75, PR #79, merged): npm-workspaces monorepo — `app/` ->
`apps/dictex`, `engine/` -> `packages/engine`, empty `packages/shared`; the
Electron main `repoRoot` resolves four levels up from the built
`apps/dictex/out/main`. No behavior change. Done.

Pivot Phase 2 (#76, PR #80, merged):

- Scaffolded `apps/lab` (**DicTeX Lab**): electron-vite + React, no microphone/
  hotkey/clipboard/normalizer. Hosts the STT benchmark (segment/batch, candidate
  summary, error analysis, candidate selection), typed corrections,
  benchmark-set splits, and the test_frozen dataset export.
- Factored the shared pure logic into `packages/shared` (populated from the
  empty Phase-1 scaffold): `localEvents` (event schema + append-only
  derivations), `sttScoring` (CER/WER), `benchmarkSummary`, `datasetExport`,
  `sttEngine` (Python sidecar invocation + `getSttBenchmarkModels`),
  `benchmarkTypes` (benchmark IPC types), `errorAnalysis`, and `formatting`.
  `apps/dictex` re-points its imports to `@dictex/shared` (its local copies of
  those modules deleted); its dictation path is otherwise unchanged. The node-
  touching barrel (`.`) is main-process only; `formatting` + `errorAnalysis` are
  browser-safe subpath exports for renderers.
- The Lab reads DicTeX's data folder **read-only** (configurable, default
  `%APPDATA%/dictex-app/data`) and writes only into its OWN store
  (`%APPDATA%/dictex-lab-app/data`). Documented in `docs/development.md` and
  `docs/product-decisions.md`.
- The Lab still coexisted with the same features in `apps/dictex` at this point;
  Phase 3 (#77) removed them from DicTeX. Done.

Pivot Phase 3 (#77, PR #81, merged): slimmed `apps/dictex` to a pure consumer
dictation tool — single Home view (dictation + normalizer + STT model selector +
minimal diagnostics), collapsible history with **Copy / Copy raw / Play only**,
and an **"Open Lab"** launcher (prefers the built Lab, falls back to `dev:lab`,
graceful error). Removed all benchmark/dataset/correction/split IPC + UI and 61
dead CSS blocks (~-3400 LOC; CSS bundle 16.6 -> 9.2 kB). No `packages/shared` or
`packages/engine` deletions. Done.

Roadmap — DicTeX / Lab split (see `pivot_dictex_lab_split.md`). **The pivot is
complete: all four phases (0-4) are merged.** DicTeX is the lean consumer
dictation app; the Lab owns benchmark + dataset building + export. Prior
benchmark/dataset issues are done or folded in (#43/#58 closed; #44 export
relocated to the Lab in Phase 2; #66 recording reverted in Phase 0).

- #75 Phase 1 — monorepo skeleton — **DONE** (PR #79).
- #76 Phase 2 — `apps/lab` + `packages/shared` — **DONE** (PR #80).
- #77 Phase 3 — slim DicTeX + Open Lab — **DONE** (PR #81).
- #78 Phase 4 — Lab manual two-layer dataset builder + benchmark from the data
  folder — **DONE** (PR #82; Opus-max review restricted paste sources to
  math_transform, so no audio-less `acoustic` records reach the STT dataset).

Post-pivot (done):

- #83 Open Lab reliability + post-pivot cleanup — **DONE** (PR #86).
  `openLabApp()` now also requires `apps/lab/out/renderer/index.html` before
  launching the built Lab (a partial build with only `out/main` previously
  launched a blank/frozen window); removed the vestigial `referenceModel`
  field/UI from the Lab dataset builder (dead since the synthetic `stt_result`
  path was removed); swept 17 dead CSS rule blocks from
  `apps/lab/src/renderer/src/styles.css` (Lab CSS bundle 17.00 -> 13.96 kB).

- #84 UX/UI design review + on-direction polish — **DONE** (PR #87). Added the
  shared token layer `packages/shared/src/styles.css` (both renderers import it
  first), one `.panel-header`, consistent focus/hover/disabled, and
  `docs/ux-review.md`. Fixed real drift from #77/#83: classes used in JSX with no
  CSS rule.
- #85 Lab dataset-builder + view-state UX — **DONE** (PR #88). Mirrors
  `planDatasetBuilderSave`'s real errors in the renderer, live "will save X ->
  split" preview, empty/pre-run states across Segments/Benchmark/Dataset. Also
  fixed a guard that left Save enabled for a paste-mode entry with no Layer 2 —
  a request the main process could only reject.

- #89 Lab dataset builder: refresh the segment list + replay segment audio —
  **DONE** (PR #91). Threads `loadSegments` / `playSegmentAudio` into
  `DatasetView`; audio affordances hidden in paste mode.
- #92 Command words: shared sentinel layer — **DONE** (PR #98). One table in
  `packages/shared/src/commands.ts`, consumed by `apps/dictex`'s normalizer
  (`extractCommands` between the dictionary and the regex layer), by insertion
  and event writing (`expandCommands`, a total sentinel eliminator), and by the
  dataset export (`extractCommands` on both layers of a `math_transform` pair,
  never on an `acoustic` one). `npm test` guards the no-sentinel-in-store
  invariant and now runs in CI.

Post-pivot (open):
- #45 plan first fine-tuning experiment — `level:faible` + `needs:high-review`.
  Phase 5, gated on the Lab producing enough `acoustic`-tagged data. **Reconsider
  the ordering**: benchmarking STT system-prompt variants costs no training data
  and no GPU, and is representable today as a new `variant` in the existing
  `{stage, provider, model, variant}` candidate identity. See
  `docs/dataset-and-normalization-design.md` §6.

Layer-3 input, **decided 2026-07-10** (see `docs/dataset-and-normalization-design.md`
§7): **resolution 1 — layer 3 learns the residual.** The exported training input
is the pipeline's output over Layer 1 (dictionary -> command extraction -> regex),
i.e. what layer 3 actually receives at inference; the target stays the
human-authored Layer 2. Rejected: letting layer 3 replace the regex. The
principle: never make a model learn what a rule does with certainty.

Consequences, tracked as issues:

- #100 move the normalizer into `packages/shared` and replay the pipeline over
  Layer 1 at export — `level:eleve` + `needs:high-review`. Leaving it in
  `apps/dictex` while the export lives in `packages/shared` would recreate the
  train/serve divergence #92 just eliminated for command words. **DONE**
  (PR #103, merged as `9f64cca`).
- #101 the Lab builder prefills Layer 2 from the pipeline output and
  **highlights what the pipeline changed**, because a prefilled field invites
  passive acceptance — `level:moyen`, depends on #100. **DONE**. The prefill
  runs the FULL pipeline (dictionary -> command extraction -> regex — the same
  fold `apps/dictex` serves) over Layer 1, then `restoreCommandWords`
  (`packages/shared/src/commands.ts`) maps the sentinel back to its canonical
  spoken phrase — the exact inverse of `extractCommands` for the sentinel ->
  words direction — so the builder's Layer 2 field only ever holds canonical
  words, never a sentinel or a literal command effect. Chosen over skipping
  command extraction in the prefill: skipping it would run the regex on text
  the real pipeline never gives it. The diff itself is a small word-level LCS
  diff (`packages/shared/src/textDiff.ts`) between Layer 1 and the prefilled
  Layer 2, rendered inline in the dataset builder panel.

The regex layer is not a stopgap the seq2seq makes redundant: its operand is a
single letter or number, so it structurally cannot do composition, scope, or
disambiguation. And the `math_transform` dataset is the *measurement* of the regex
layer before it is fuel for a model — it keeps its value even if layer 3 never
ships.

Deferred UX proposals (from `docs/ux-review.md`, human decisions recorded):

- **Typographic scale (A)** — wanted, but touches nearly every CSS rule in both
  apps, so it is a merge-conflict magnet. Land it alone, never bundled.
- **Idle DicTeX Home (B)** — decision: **hide empty metrics** until they have a
  value, rather than showing eight `-` cells or seeding from config.
- **Record-button wording (F)** — decision: **align the button on the toggle**
  (Start / Stop), matching `Win+Alt+Space`. One mental model; push-to-hold goes.
- **Footer actions (C)** and **collapsible Lab data-folder panel (E)** — still
  open, no decision.
- **Unified navigation model (D)** — deliberately deferred. Structural, purely
  aesthetic benefit, and the likeliest way to drift a utility UI toward a
  dashboard. Revisit once both apps stop moving.
- **Light theme (G)** — not happening. Both apps are dark-only by design.

Model per level (Claude / Codex): `level:eleve` -> Opus 4.8 high / gpt-5-codex
high; `needs:high-review` issues get a reviewer one notch up (Opus 4.8 max).

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
- LLM provider integrations;
- API key handling;
- fine-tuning;
- cloud sync;
- multi-user backend.

The strategic pivot sanctions the normalization pipeline (dictionary, regex,
small seq2seq) and math rendering as the Priority 1 direction — still land them
through explicit issues, not ad hoc.

**LaTeX generation is now sanctioned** (decided 2026-07-10, was on the list
above). The normalizer's canonical output format is LaTeX, not Unicode: Unicode
cannot express integrals, structured fractions, sums with bounds, or matrices,
and `LaTeX -> Unicode` can be derived while `Unicode -> LaTeX` cannot. Layer 2 is
hand-written and, unlike every other artefact here, **does not regenerate** — so
the format had to be settled before collecting. KaTeX remains a *renderer* (it
displays LaTeX); it is not a format and not a pipeline layer. See
`docs/dataset-and-normalization-design.md` §8, issues #106 (style subset +
canonicalizer, blocks collection) and #107 (rules rewrite). Math *parsing* is
still not sanctioned.

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

Navigation (sanctioned by the UI refactor, issues #63-#66): a **small number of
task-focused views** is allowed — Home, Benchmark, Dataset (enrichment) — reached
from big entry buttons on Home, with a back-to-home control in each view. This is
a deliberate exception to "one compact screen", but the compact, sober,
minimal-color, clear-state feel MUST hold *within* each view. Do not let the
multi-view shell drift into a SaaS dashboard, a decorative hero, or broad
settings pages. Keep dictation + last transcript + correction on Home; the
Benchmark and Dataset views host only their own task.

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

Each dictation also appends a normalization record (pivot Phase 2, layer 1).
The raw `stt_result` is left untouched; the normalized output is what gets
inserted, and each layer's output is preserved so a wrong insertion is
attributable to a specific layer:

```json
{"event_type":"normalization_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","input_transcript":"dic tex","output_transcript":"DicTeX","passthrough":false,"layers":[{"layer":"personal_dictionary","input":"dic tex","output":"DicTeX","applied":true,"diagnostics":[]}],"diagnostics":[]}
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

Two-layer dataset enrichment (issue #66): to keep the acoustic (STT) and
math_transform (normalizer) datasets separable, the enrichment tool captures two
layers for one recorded segment and writes **two chained `stt_correction`
events** — no new event type:

1. `correction_kind = "acoustic"`: `raw_transcript` = raw STT output,
   `corrected_transcript` = acoustically-correct literal transcript (notation
   still verbal). Feeds the acoustic dataset paired with the segment audio.
2. `correction_kind = "math_transform"`: `raw_transcript` = the literal-correct
   transcript, `corrected_transcript` = normalized notation. Feeds the
   normalizer dataset as a text->text pair (no audio).

A single fully-normalized pasted text would collapse both transformations and
make the datasets non-separable — so the stage is encoded by which layer is
filled, not by one blended tag. Consequence: a segment can carry more than one
correction event. `reconstructRecentSegments` keeps latest-event-wins for
history display, but **dataset extraction (#44) must read all correction events
of a segment**, not just the last. `correctionKind` still applies as a single
tag for quick inline corrections (short, single-purpose).

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

GPU (CUDA) is supported on this machine via env config (see
`docs/development.md`, "GPU (CUDA) STT"):

```text
DICTEX_STT_MODEL=large-v3-turbo
DICTEX_STT_DEVICE=cuda
DICTEX_STT_COMPUTE_TYPE=float16
```

Requires `nvidia-cublas-cu12` + `nvidia-cudnn-cu12` pip packages;
`packages/engine/transcribe.py` handles the cuBLAS DLL path on Windows.

Current STT benchmark candidates (defaults, configurable via
`DICTEX_STT_BENCHMARK_MODELS` since PR #51):

- faster-whisper/tiny
- faster-whisper/base
- faster-whisper/small

Since PR #68, a second local provider is also available as benchmark
candidates: Vosk (`vosk-model-small-fr-0.22` by default, configurable via
`DICTEX_VOSK_BENCHMARK_MODELS` + `DICTEX_VOSK_MODEL_DIR`), optional at runtime
(quiet skip if uninstalled). See `docs/development.md` -> "Second STT provider
(Vosk)".

These are current candidates, not the final benchmark universe. The model
actually used for dictation on this machine is faster-whisper/large-v3-turbo
on GPU (already selectable for dictation via the Home model selector, #57);
it is not yet in the default *benchmark* candidate list — include it via
`DICTEX_STT_BENCHMARK_MODELS=tiny,base,small,large-v3-turbo` until an issue
adds it by default.

## Next Product Priorities

The correction/evaluation loop (#11-#14, #21-#24) merged through PR #36.
Corrected-segment correction (#37) and benchmark-set membership (#38) are done,
so the foundations the pivot relies on are in place.

Priorities now follow the strategic pivot's phasing:

1. **Phase 1 — typed correction data (done, issue #48 / PR #52).**
   `correctionKind` is now required on every new correction; unlabeled data is
   no longer collected.
2. **Phase 2 — code normalizer (layers 1 & 2, issues #49 / PR #55 and #50 /
   PR #62) — done.** Personal dictionary + regex math-verbalization rules
   landed; rendering-quality gains with zero ML.
3. **Phase 3 — ML normalizer (layer 3).** After some usage, extract the
   `math_transform`-tagged dataset and fine-tune a small seq2seq model.
4. **Phase 4 — STT acoustic fine-tuning.** Extract the `acoustic`-tagged
   dataset; if residual acoustic errors justify it, LoRA the selected STT model
   on that clean data only.

(These are the **normalization-track** phases; do not confuse them with the
**pivot phases** #75-#78, which are about *where the tooling lives*, not the
normalizer itself.) The STT benchmark -> selection track (#39-#43) and the Vosk
provider (#59) are done; the UI refactor (#63-#65) is done.

**The near-term priority is now the DicTeX / Lab split**, not more in-app
tooling. Its phasing lives under "Open roadmap": Phase 0 (done, PR #74) removed
the in-app recording; Phase 1 (#75) is the monorepo skeleton — the keystone —
then #76 (Lab), #77 (slim DicTeX), #78 (Lab dataset builder). The
normalization-track ML work (layer-3 seq2seq, STT fine-tuning) and #45 resume
**after** the Lab can build and export the datasets.

Land each phase through the explicit issues above; do not build a large generic
framework ahead of need, and keep new ML/tooling surface in the Lab, not in
DicTeX.

## Important Nuance

The user cares about not losing correction and improvement data. Even before correction UI exists, preserve raw audio, raw STT outputs, benchmark outputs, and later human corrections.

If a future feature changes how outputs are generated, preserve enough intermediate state to know which layer made the mistake.
