# Completed Work

Historique des issues et PR fermées. C'est une référence consultée à la
demande (par exemple pour comprendre pourquoi une décision a été prise ou
retrouver la PR d'origine d'un comportement) — elle n'a pas besoin d'être lue
avant chaque session d'agent. `AGENTS.md` reste le noyau systématiquement
chargé ; `docs/roadmap.md` reste la source canonique de l'ordre des travaux
courant.

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

Après le pivot, la priorité courante n'est plus tenue dans cette chronologie de
travaux terminés. Consulter `docs/roadmap.md` et l'état GitHub en direct. #45,
qui planifie le premier entraînement STT, reste différé jusqu'à la comparaison
des variantes de `initial_prompt` (#94), la constitution d'un volume acoustique
minimal et la démonstration d'un résidu réellement acoustique.

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
