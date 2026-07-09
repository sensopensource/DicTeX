# Development

## Requirements

- Node.js LTS
- npm
- Python 3.11
- Git

## Repository Layout

DicTeX is an npm-workspaces monorepo. The consumer app, the tooling app, the
Python STT engine, and shared TypeScript live in separate workspaces:

```text
apps/
  dictex/      # the Electron + React consumer dictation app (has a microphone)
  lab/         # DicTeX Lab — Electron + React tooling app (NO microphone):
               # benchmark + dataset export + corrections/splits over DicTeX's
               # data folder, read-only, with its own store
packages/
  engine/      # the Python STT sidecar (faster-whisper + Vosk) — shared
  shared/      # shared TS used by both apps: JSONL event schema + derivations,
               # CER/WER scoring, benchmark summary, dataset export builder,
               # STT engine invocation, benchmark IPC types, error analysis,
               # and presentation helpers
```

npm commands run from the **repository root**. The root `package.json` holds the
workspaces list; root `typecheck` and `build` cover `packages/shared` +
`apps/dictex` + `apps/lab`, while `dev` runs `apps/dictex` (use `dev:dictex` /
`dev:lab` to pick one). So `scripts/npm.cmd run <script>` from the root drives
the monorepo. The Python `.venv` lives at the **repository root** (`.venv/`),
not inside a workspace; each app's Electron main process resolves it relative to
the repo root at runtime (both apps sit at the same depth under `apps/`).

## Windows TLS Note

On this machine, npm cannot verify the npm registry certificate with Node's bundled CA store. Use Node's system CA mode when running npm:

```text
NODE_OPTIONS=--use-system-ca
```

This makes Node/npm use the Windows certificate store instead of disabling SSL verification.

Do not use `strict-ssl=false` for this project.

The same certificate issue can affect pip. Use:

```powershell
python -m pip install --use-feature=truststore -r packages\engine\requirements.txt
```

Windows helper:

```powershell
scripts\npm.cmd <npm arguments>
```

Linux/macOS helper:

```sh
scripts/npm.sh <npm arguments>
```

## Install

Run everything from the repository root.

Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements.txt
scripts\npm.cmd install
```

Linux/macOS:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r packages/engine/requirements.txt
scripts/npm.sh install
```

`npm install` at the root installs every workspace (there is one root
`package-lock.json`; the app has no separate lockfile).

### Migrating an existing checkout to the monorepo

A checkout made before the monorepo move (`app/` → `apps/dictex`, `engine/` →
`packages/engine`) needs a fresh **root** install — dependencies are now hoisted
to a single root `node_modules`, so the app's tools (e.g. `electron-vite`) are
not found until you reinstall. After pulling:

```powershell
scripts\npm.cmd install        # reinstall at the root (hoists all workspaces)
Remove-Item -Recurse -Force .\app   # optional: delete the now-orphaned old app/ (only ignored node_modules/out remain)
```

The `.venv` at the repo root is reused as-is — it is still at the (unchanged)
repository root, so dictation keeps working with no changes.

## Validate

Windows:

```powershell
scripts\npm.cmd run typecheck
scripts\npm.cmd run build
```

Linux/macOS:

```sh
scripts/npm.sh run typecheck
scripts/npm.sh run build
```

These root scripts delegate to `apps/dictex`.

## Manual MVP Smoke Test

Run this checklist on Windows when validating MVP behavior manually. CI does not cover microphone input, global hotkeys, auto-paste, Python STT, or local model availability.

1. Launch the app:

```powershell
scripts\npm.cmd run dev
```

2. Confirm the app opens to the compact utility UI and shows the global shortcut status.
3. Hold `Hold to dictate`, speak a short French phrase, then release.
4. Confirm the transcript appears in `Last transcript` and the diagnostics show session id, segment id, model, language, latency, and audio duration when available.
5. Confirm the transcript is copied to the clipboard.
6. Press `Win+Alt+Space`, speak a short phrase, then press `Win+Alt+Space` again.
7. Confirm Windows auto-paste inserts the transcript into the previously active text field, or that the UI reports clipboard-only behavior if paste fails.
8. Confirm the recent segment history refreshes; on an older segment use **Copy** (inserted/normalized text) and **Copy raw** (raw STT output).
9. Play a recent segment from history and confirm local audio playback works.
10. Click `Open data folder` and confirm the stored audio file exists under `data/audio/session_.../`.
11. Click `Open events log` and confirm `audio_segment`, `stt_result`, and `normalization_result` events were appended. (DicTeX no longer writes corrections or benchmark events — those live in DicTeX Lab.)
12. Click `Open dictionary`, add an entry like `{"from":"dic tex","to":"DicTeX"}`, save the file, then dictate a phrase containing "dic tex". Confirm the clipboard/pasted text and the `Inserted (normalized)` line show `DicTeX`, the `Last transcript (raw)` textarea still shows the raw STT output, and a `normalization_result` event was appended while `stt_result.stt_output` kept the raw transcript. Break the JSON on purpose and confirm the next dictation still inserts the raw text with a quiet `Normalizer:` diagnostic instead of failing.
13. Without touching `rules.json`, dictate "deux plus trois" spoken as digits (e.g. "2 plus 3") and confirm the inserted text shows `2 + 3` from the shipped default rules alone. Then dictate an ordinary sentence containing "plus" or "moins" outside a math context (e.g. "je suis de plus en plus fatigué") and confirm it is inserted unchanged. Click `Open rules`, break the JSON on purpose, and confirm the next dictation inserts the (still dictionary-normalized) text unchanged by regex rules with a quiet `Normalizer:` diagnostic instead of failing.
14. In the `STT model` selector (controls panel), pick a different model. Confirm the `Model` diagnostic reflects it, dictate a phrase, and confirm the `stt_result` event records the chosen model. Restart the app and confirm the selector still shows the chosen model (persisted in `data/settings.json`). Corrupt `settings.json` and confirm the app still starts and dictates using the env var / default `base`.
15. Click **Open Lab**. With the Lab built (`scripts\npm.cmd run build`), confirm the DicTeX Lab app launches; without a build, confirm DicTeX shows a graceful "build/start the Lab first" message and does not crash.

Benchmark, typed corrections, benchmark-set splits, candidate selection, Vosk, and the test_frozen dataset export are **no longer in DicTeX** (Pivot Phase 3) — they now live in DicTeX Lab and are verified there (see "DicTeX Lab" below).

## Run

Windows:

```powershell
scripts\npm.cmd run dev
```

Linux/macOS:

```sh
scripts/npm.sh run dev
```

The app uses a Python sidecar with faster-whisper for local transcription.

## DicTeX Lab (tooling app)

`apps/lab` is the separate **DicTeX Lab** app (pivot Phase 2, see
`pivot_dictex_lab_split.md`). It has **no microphone, no hotkey, no
clipboard/paste, and no normalizer**: it is where the ML tooling lives —
STT benchmark (segment/batch, candidate summary, error analysis, candidate
selection), typed corrections, benchmark-set split membership, and the
test_frozen-compatible dataset export. It reuses `packages/engine`
(faster-whisper + Vosk) for STT and `packages/shared` for all derivation /
scoring / export logic, so DicTeX and the Lab cannot diverge.

Run it (from the repository root):

```powershell
scripts\npm.cmd run dev:lab
```

```sh
scripts/npm.sh run dev:lab
```

### DicTeX data folder (read-only source) + the Lab's own store

The Lab reads DicTeX's local data folder — `audio/` + `events.jsonl`
(`audio_segment` / `stt_result` / `normalization_result`) — **read-only**.
It never writes into DicTeX's folder. Everything the Lab produces
(corrections, splits, benchmark results, candidate selections, dataset
exports, and its own settings) goes into the **Lab's own** store under its
own Electron `userData` (`%APPDATA%/dictex-lab-app/data`), a separate folder
from DicTeX's `%APPDATA%/dictex-app/data`.

The DicTeX data folder path is configurable in the Lab's Segments view:

- default: `%APPDATA%/dictex-app/data`;
- override via `Choose folder…` (native picker) or by pasting an absolute
  path + `Apply`;
- `Reset to default` clears the override.

The choice is persisted in the Lab's own `settings.json`
(`{"dictexDataFolder": "..."}`); a missing/malformed file degrades to the
default with a quiet diagnostic. When the Lab benchmarks a segment, it reads
that segment's audio from the configured source folder and appends the
`stt_benchmark_result` to its **own** event log. When combining state for a
segment, the Lab concatenates DicTeX's read-only events (first) with its own
events (second), so latest-event-wins derivations see the Lab's corrections/
splits layered on top of DicTeX's raw dictation records.

### Dataset builder (manual two-layer entries, issue #78)

The `Dataset` view's **Build a dataset entry** panel is the Lab's manual,
no-microphone replacement for the old in-app recording (#66, removed in
Phase 0): you run DicTeX in the background yourself, then feed the Lab its
real transcription by hand. Two independent inputs:

- **Paste a transcription** — free-text raw STT transcript, no audio. Mints a
  synthetic identity (`lab_manual_<timestamp>` / `entry_<random>`).
- **Pick a DicTeX segment** — chooses one of the (read-only) segments listed
  in the Segments view; the real `sessionId`/`segmentId`/`audioRef` and raw
  transcript are reused as-is.

Then two layers, always typed by hand:

- **Layer 1 (literal, verbal)** — e.g. `x au carré plus deux`.
- **Layer 2 (normalized notation, LaTeX/KaTeX-compatible)** — e.g. `x^2 + 2`;
  the field stays disabled until Layer 1 is filled.

Clicking `Save entry` writes chained `stt_correction` events into the Lab's
**own** store (never DicTeX's folder), same principle as the removed #66
recorder (see AGENTS.md "Two-layer dataset enrichment"): an **empty layer is
skipped**, so the two datasets stay separable purely by which layer was
filled —

- a raw transcript (pasted or from a picked segment) + Layer 1 writes an
  `acoustic` correction (`raw_transcript` = raw STT, `corrected_transcript` =
  Layer 1);
- Layer 1 + Layer 2 writes a `math_transform` correction (`raw_transcript` =
  Layer 1, `corrected_transcript` = Layer 2) — Layer 2 can never be saved
  without Layer 1, since Layer 1 is its input;
- both can be written together (chained on the same segment identity), giving
  one record in each dataset once exported.

The entry is also marked into the chosen benchmark-set split (train pool /
validation / test frozen) so it is immediately visible to `buildSttDatasetExport`
and to the Benchmark view's set runner. A **paste**-sourced entry has no real
audio: internally it is still assigned a string `audioRef` (not `null`) so the
shared `getSttBenchmarkSetSegments` derivation picks it up, but the Lab's own
`serializeDatasetRecord` maps that back to `audio_ref: null, audio_path: null`
in the exported JSONL — the export never claims a fake audio file exists for a
text-only, math_transform-only entry. A **picked-segment** entry always keeps
its real `audio_ref`/`audio_path`, resolved against the configured (read-only)
DicTeX data folder.

### Manual Lab smoke test

1. `scripts\npm.cmd run dev:lab`, confirm the window opens to the Segments
   view and the data-folder line shows `%APPDATA%/dictex-app/data (default)`
   with a `data folder ok` pill when DicTeX has recorded at least once.
2. Confirm DicTeX segments recorded by `apps/dictex` appear in the list
   (read from the source folder), and `Play` plays their audio.
3. `Correct` a segment (choose a correction kind), then set its split to
   `Test frozen`; confirm both land only in the Lab's events log
   (`Open Lab events log`) and DicTeX's `events.jsonl` is untouched.
4. In `Benchmark`, click `Benchmark latest` (needs the venv or
   `DICTEX_PYTHON`); confirm `tiny`/`base`/`small` transcripts + latency
   appear. Run `Run analysis` over `Test frozen`, `Summarize by candidate`,
   and `Select` a candidate.
5. In `Dataset`, use **Build a dataset entry**: pick a DicTeX segment, type a
   Layer 1 literal transcript, leave Layer 2 empty, choose `Test frozen`, and
   click `Save entry`; confirm the notice reports an `acoustic` save only.
   Paste a transcription (no segment), leave the raw text empty, fill Layer 1
   and Layer 2, and save; confirm the notice reports a `math_transform` save
   only, with a freshly minted `lab_manual_…` identity. Pick another segment,
   fill both layers, and save; confirm the notice reports both `acoustic` and
   `math_transform` for that segment's real identity.
6. Click `Export dataset`; confirm the `<split>.acoustic.jsonl` /
   `<split>.math_transform.jsonl` files from step 5 contain one record each
   per filled layer, that the acoustic-only record has a real, resolved
   `audio_path` under DicTeX's data folder, and that the math_transform-only
   (pasted) record has `audio_ref: null` and `audio_path: null`. Confirm
   DicTeX's `events.jsonl` is still unchanged.
7. Back in `Benchmark`, with `Test frozen` selected, click `Run analysis`
   (needs the venv or `DICTEX_PYTHON`); confirm the segment built in step 5
   appears in the batch outcomes and candidate summary alongside any other
   `Test frozen` segments.
8. Point the data folder at a different directory (or reset it) and confirm
   the segment list refreshes from the new source.

## Global Dictation Hotkey

DicTeX registers this global toggle shortcut:

```text
Win+Alt+Space
```

Behavior:

```text
press once -> start recording
press again -> stop recording, transcribe, copy, paste
```

On Windows, global hotkey dictation pastes into the active application after copying the transcript to the clipboard. On other platforms, the transcript is copied to the clipboard and auto-paste is skipped for now.

The manual `Hold to dictate` button still records and copies to clipboard without auto-pasting.

The UI also exposes diagnostics shortcuts:

- `Open data folder`
- `Open events log`

## STT Engine

The local engine uses `faster-whisper`.

Defaults:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

Override example (from the repository root):

```powershell
$env:DICTEX_STT_MODEL="small"
$env:DICTEX_STT_LANGUAGE="fr"
scripts\npm.cmd run dev
```

### Selecting the STT model from the UI

The active STT model can also be chosen at runtime from the compact selector in
the controls panel (models: `tiny`, `base`, `small`, `large-v3-turbo`, plus any
`DICTEX_STT_BENCHMARK_MODELS` entries). The choice applies to subsequent
dictations; in-flight transcriptions are unaffected.

The selection is persisted in a small local settings file under the Electron
`userData` data directory:

```text
data/settings.json
```

```json
{"sttModel":"large-v3-turbo"}
```

It is a minimal flat JSON object. Model precedence is:

```text
saved UI choice (settings.json) > DICTEX_STT_MODEL env var > built-in default (base)
```

A missing or malformed `settings.json` never crashes the app or blocks
dictation: it degrades to the env var / default with a quiet console
diagnostic. `stt_result` events keep recording the model actually used per
segment.

### GPU (CUDA) STT

To run STT on an NVIDIA GPU instead of CPU (from the repository root):

```powershell
$env:DICTEX_STT_MODEL="large-v3-turbo"
$env:DICTEX_STT_DEVICE="cuda"
$env:DICTEX_STT_COMPUTE_TYPE="float16"
scripts\npm.cmd run dev
```

The Windows `ctranslate2` CUDA wheel bundles cuDNN but not cuBLAS. If the
machine has no system-wide CUDA Toolkit install, `cublas64_12.dll` will be
missing and transcription fails with
`RuntimeError: Library cublas64_12.dll is not found or cannot be loaded`.
Install it via pip instead of the full CUDA Toolkit:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore nvidia-cublas-cu12 nvidia-cudnn-cu12
```

`packages/engine/transcribe.py` prepends that package's `bin` directory to
`PATH` at startup on Windows, so no manual `PATH` changes are needed after
installing it.

On Windows, if Python is not available through `py -3.11`, set:

```powershell
$env:DICTEX_PYTHON="C:\Users\souid\DicTeX\.venv\Scripts\python.exe"
```

In development, the Electron app automatically uses the repository `.venv` Python when it exists.

### Second STT provider (Vosk)

The Python sidecar has a small provider abstraction (`packages/engine/providers/`):
`faster-whisper` is the dictation engine and default benchmark provider; **Vosk**
is a second, benchmark-only provider (a different, Kaldi-based engine family —
see `docs/product-decisions.md`). Vosk is fully optional: without it installed,
dictation and faster-whisper benchmarking are unchanged, and the Vosk candidate
is skipped with a quiet diagnostic.

To enable Vosk benchmark candidates:

1. Install the optional dependency:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements-vosk.txt
   ```

2. Download a French Vosk model (e.g. `vosk-model-small-fr-0.22` from
   <https://alphacephei.com/vosk/models>), unzip it, and point
   `DICTEX_VOSK_MODEL_DIR` at the directory that holds the model folder:

   ```powershell
   $env:DICTEX_VOSK_MODEL_DIR="C:\path\to\vosk-models"
   # so C:\path\to\vosk-models\vosk-model-small-fr-0.22\ exists
   ```

Relevant env vars:

```text
DICTEX_STT_PROVIDER          selects the sidecar provider (default faster-whisper)
DICTEX_VOSK_MODEL_DIR        base directory holding unpacked Vosk model folders
DICTEX_VOSK_BENCHMARK_MODELS comma-separated Vosk model names to benchmark
                             (default vosk-model-small-fr-0.22; empty disables)
```

Model resolution is local-only and never downloads: the sidecar uses `model` as
a path if it exists, else `DICTEX_VOSK_MODEL_DIR/<model>`, else the candidate is
reported unavailable. Vosk needs 16 kHz mono PCM and does not decode compressed
audio, so the sidecar decodes stored segments with PyAV (already installed by
faster-whisper) — no extra decode dependency.

## Local STT Data

The app stores local STT data under Electron's `userData` directory:

```text
data/
  events.jsonl
  audio/
    session_<timestamp>/
      seg_0001.webm
  normalizer/
    dictionary.json
    rules.json
  exports/
    stt-dataset-<timestamp>/
      manifest.json
      <split>.<correction_kind>.jsonl
```

The `exports/` folder holds generated dataset snapshots (see "Corrected Dataset
Export"); it is written from, never rewritten into, the event log.

Each dictation writes at least two events:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_mime_type":"audio/webm;codecs=opus","audio_size_bytes":25412}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_language":"fr","stt_output":"...","corrected_transcript":null}
```

The STT benchmark actions reuse stored audio segments and append one result per tested model:

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830,"score_metric":"cer","score_value":0.12,"score_reference_type":"stt_correction"}
```

STT corrections are append-only events linked to the original segment:

```json
{"event_type":"stt_correction","created_at":"2026-07-05T00:00:00.000Z","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","raw_transcript":"...","corrected_transcript":"...","correction_method":"keyboard"}
```

The important MVP decision is to preserve the audio -> raw STT -> correction -> benchmark score relationship without rewriting earlier events.

## STT Candidate Summary

The `Candidate summary` panel aggregates `stt_benchmark_result` events for a
chosen benchmark set split (`Test frozen` or `Validation`) by candidate
identity (`stage` + `provider` + `model` + `variant`). It is read-only: it
never appends events, it only reads and summarizes what `Run set benchmark`
already logged.

Per candidate it reports:

- **segments**: how many split segments have a logged result for that
  candidate;
- **mean/median CER**: Character Error Rate, the edit distance between the
  candidate transcript and the corrected transcript divided by the corrected
  transcript's length. `0%` is a perfect match; higher is worse. CER is
  case-insensitive and ignores leading/trailing whitespace, but is otherwise
  literal, so it does not know that two spellings mean the same thing;
- **mean/median WER**: Word Error Rate, the same edit-distance idea but over
  whitespace-separated words instead of characters. WER is coarser than CER
  (one wrong letter in a word counts as a whole wrong word) and is more in
  line with how a human would judge a transcript at a glance;
- **mean latency**: average `transcription_duration_ms` across that
  candidate's logged results, so a lower-CER candidate that is much slower is
  still visible, not hidden behind the score;
- **missing**: split segments with no logged result for that candidate. A run
  that crashed mid-flight never appended an `stt_benchmark_result` event, so a
  failed attempt and a segment that was never benchmarked look the same here;
  re-run the set benchmark to fill gaps.

Only the STT stage is scored today; the summary is STT-only by construction
because it groups by `stage`, so a future `math_transform` or `normalization`
candidate would summarize separately once that stage starts scoring results.

## STT Candidate Selection

The `Candidate summary` panel also lets the user mark which STT candidate is
the currently selected base model, so that choice does not have to live only
in memory or in `DICTEX_STT_MODEL`. Selection is manual: choosing the
highest-quality candidate blindly can be wrong if it is much slower, so the
panel keeps mean latency visible next to CER/WER when picking one.

Enter a reason and click `Select` (or `Reselect`) on a candidate's row in the
summary table. This appends an `stt_candidate_selection` event; it never
overwrites or removes prior selections, so the full selection history stays in
`events.jsonl`. The panel reads the latest such event (latest-event-wins, same
rule as every other append-only marker in this file) to show which candidate
is currently selected.

```json
{"event_type":"stt_candidate_selection","created_at":"2026-07-08T00:00:00.000Z","stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr","selection_reason":"best quality/latency tradeoff on test_frozen"}
```

This is a manual record for the user's own reference; it does not change
`DICTEX_STT_MODEL` or any other runtime config, and DicTeX does not act on it
automatically.

## Normalization Pipeline

Before the transcript is copied/pasted, DicTeX runs it through an ordered
text-to-text normalization pipeline (strategic pivot, Phase 2): the personal
dictionary (layer 1) runs first, then the regex math-verbalization rules
(layer 2). Layer 3 (seq2seq model) is added in a later issue without
reshaping the interface.

The personal dictionary is a user-editable JSON file. Empty by default; a
missing or invalid file degrades to passthrough (byte-identical output) with a
quiet diagnostic, never a crash or a blocked dictation. Use the `Open
dictionary` button to create/open it.

```text
data/normalizer/dictionary.json
```

```json
{"version":1,"entries":[{"from":"dic tex","to":"DicTeX"}]}
```

Entries are literal, case-sensitive substring replacements applied in file
order. Malformed individual entries are skipped (with a diagnostic) while valid
entries still apply.

The regex rules layer runs after the dictionary. Unlike the dictionary, it
ships a small default set of conservative French math-verbalization rules that
applies out of the box, even before the rules file exists. Use the `Open
rules` button to create/open it; the seeded file contains the shipped
defaults, editable in place.

```text
data/normalizer/rules.json
```

```json
{"version":1,"rules":[{"pattern":"...","replacement":"$1²","flags":"i"}]}
```

Each rule's `pattern` is a Unicode-aware JS regex source (always matched with
forced `g`/`u` flags, plus any `flags` given); `replacement` may reference
capture groups (`$1`, `$2`, ...). Rules apply in file order. Every default
rule requires a real operand (a run of digits, or a single Unicode letter
standing for a variable) on both sides of the keyword, and rejects a match
where that operand is glued to a surrounding letter/digit — this is what keeps
prose like "de plus en plus" or "je suis moins fatigué" untouched, since
"plus"/"moins" only convert between two such operands. The default set
covers: "x au carré" -> `x²`, "x au cube" -> `x³`, "x puissance n" -> `x^n`
(caret notation, since there is no general Unicode superscript), "racine
(carrée) de x" -> `√x`, "x égal(e) y" -> `x = y`, "plus grand/petit que" ->
`>`/`<`, and "plus"/"moins"/"fois"/"divisé par" -> `+`/`-`/`×`/`/`. A malformed
rules file (bad JSON or shape) disables the whole layer with a passthrough and
a quiet diagnostic; a malformed individual rule (e.g. invalid regex) is
skipped the same way individual dictionary entries are.

The raw `stt_result` event is left untouched. Each dictation appends a separate
append-only `normalization_result` event recording the input, the final output,
and every layer's output, so a wrong insertion can be attributed to a specific
layer:

```json
{"event_type":"normalization_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","input_transcript":"x au carré","output_transcript":"x²","passthrough":false,"layers":[{"layer":"personal_dictionary","input":"x au carré","output":"x au carré","applied":false,"diagnostics":[]},{"layer":"regex_rules","input":"x au carré","output":"x²","applied":true,"diagnostics":[]}],"diagnostics":[]}
```

History shows the raw transcript; the normalized inserted text is shown
distinctly when it differs.

## Corrected Dataset Export

The `Dataset` view exports the corrected STT dataset to local JSONL files for
later Phase 3 normalizer training and Phase 4 STT acoustic fine-tuning. Click
`Export dataset`; nothing is uploaded and the event log is never rewritten. Each
export goes to its own timestamped folder so prior exports are never clobbered:

```text
data/exports/stt-dataset-<timestamp>/
  manifest.json
  test_frozen.acoustic.jsonl
  test_frozen.math_transform.jsonl
  validation.acoustic.jsonl
  ...
```

Files are named `<split>.<correction_kind>.jsonl`. Only segments that have a
benchmark-set membership (`train_candidate_pool` / `validation` / `test_frozen`)
**and** at least one typed correction produce records; frozen test lands in its
own files. The exporter reads every correction event of a segment and keeps the
latest of **each** `correction_kind` (not just the single latest event), so a
segment enriched with chained `acoustic` + `math_transform` corrections yields
one record in each dataset — the acoustic (STT) and math_transform (normalizer)
datasets stay separable. Untyped legacy corrections cannot be routed by kind, so
they are skipped and counted in the manifest and UI rather than dropped
silently.

Each JSONL record is traceable back to its source events:

```json
{"split":"test_frozen","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_path":"C:\\Users\\...\\data\\audio\\session_...\\seg_0001.webm","language":"fr","correction_kind":"acoustic","raw_transcript":"x au carre","corrected_transcript":"x au carré","original_stt_output":"x au carre","stt_engine":"faster-whisper","stt_model":"base","correction_method":"keyboard","correction_created_at":"2026-07-09T00:00:00.000Z","selected_candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"selection_reason":"best tradeoff"}
```

`raw_transcript` / `corrected_transcript` are the transform's input and target
(for `acoustic`, audio -> literal transcript; for `math_transform`, literal text
-> notation). `original_stt_output` preserves the raw STT output even when a
chained correction's own `raw_transcript` is a later literal transcript. The
selected base candidate is the latest `stt_candidate_selection`; export still
proceeds when none has been recorded (`selected_candidate` is null and the UI
notes it). `manifest.json` records per-split / per-kind counts, the total, the
skipped-untyped count, and the selection.
