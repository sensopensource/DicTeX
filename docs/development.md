# Development

## Requirements

- Node.js LTS
- npm
- Python 3.11
- Git

## Windows TLS Note

On this machine, npm cannot verify the npm registry certificate with Node's bundled CA store. Use Node's system CA mode when running npm:

```text
NODE_OPTIONS=--use-system-ca
```

This makes Node/npm use the Windows certificate store instead of disabling SSL verification.

Do not use `strict-ssl=false` for this project.

The same certificate issue can affect pip. Use:

```powershell
python -m pip install --use-feature=truststore -r engine\requirements.txt
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

Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r engine\requirements.txt
cd app
..\scripts\npm.cmd install
```

Linux/macOS:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r engine/requirements.txt
cd app
../scripts/npm.sh install
```

## Validate

Windows:

```powershell
cd app
..\scripts\npm.cmd run typecheck
..\scripts\npm.cmd run build
```

Linux/macOS:

```sh
cd app
../scripts/npm.sh run typecheck
../scripts/npm.sh run build
```

## Manual MVP Smoke Test

Run this checklist on Windows when validating MVP behavior manually. CI does not cover microphone input, global hotkeys, auto-paste, Python STT, or local model availability.

1. Launch the app:

```powershell
cd app
..\scripts\npm.cmd run dev
```

2. Confirm the app opens to the compact utility UI and shows the global shortcut status.
3. Hold `Hold to dictate`, speak a short French phrase, then release.
4. Confirm the transcript appears in `Last transcript` and the diagnostics show session id, segment id, model, language, latency, and audio duration when available.
5. Confirm the transcript is copied to the clipboard.
6. Press `Win+Alt+Space`, speak a short phrase, then press `Win+Alt+Space` again.
7. Confirm Windows auto-paste inserts the transcript into the previously active text field, or that the UI reports clipboard-only behavior if paste fails.
8. Confirm the recent segment history refreshes and can copy an older transcript.
9. Play a recent segment from history and confirm local audio playback works.
10. Edit `Last transcript`, click `Save correction`, and confirm the history marks the segment as corrected.
11. Click `Open events log` and confirm `audio_segment`, `stt_result`, and `stt_correction` events were appended.
12. Click `Open data folder` and confirm the stored audio file exists under `data/audio/session_.../`.
13. Click `Benchmark latest` and confirm `tiny`, `base`, and `small` STT results appear and `stt_benchmark_result` events are appended.
14. Benchmark a selected history segment and confirm results are associated with that segment id.
15. Add one or more corrected segments to a benchmark set split, then in the `Benchmark set` panel pick `Test frozen` or `Validation` and click `Run set benchmark`. Confirm the progress counts (queued/running/done/failed) advance, one `stt_benchmark_result` per candidate is appended for each set segment, and a single failing segment is reported without aborting the run.
16. In the `Candidate summary` panel, click `Summarize by candidate` for the same split. Confirm one row per STT candidate (`stage:provider/model (variant)`) with segment count, mean/median CER, mean/median WER, mean latency, and a missing-result count, and that the summary is labeled with the split it was computed from.
17. Click `Open dictionary`, add an entry like `{"from":"dic tex","to":"DicTeX"}`, save the file, then dictate a phrase containing "dic tex". Confirm the clipboard/pasted text and the `Inserted (normalized)` line show `DicTeX`, the `Last transcript (raw)` textarea still shows the raw STT output, and a `normalization_result` event was appended while `stt_result.stt_output` kept the raw transcript. Break the JSON on purpose and confirm the next dictation still inserts the raw text with a quiet `Normalizer:` diagnostic instead of failing.
18. Without touching `rules.json`, dictate "deux plus trois" spoken as digits (e.g. "2 plus 3") and confirm the inserted text shows `2 + 3` from the shipped default rules alone. Then dictate an ordinary sentence containing "plus" or "moins" outside a math context (e.g. "je suis de plus en plus fatigué") and confirm it is inserted unchanged. Click `Open rules`, break the JSON on purpose, and confirm the next dictation inserts the (still dictionary-normalized) text unchanged by regex rules with a quiet `Normalizer:` diagnostic instead of failing.
19. In the `STT model` selector (controls panel), pick a different model. Confirm the `Model` diagnostic reflects it, dictate a phrase, and confirm the `stt_result` event records the chosen model. Restart the app and confirm the selector still shows the chosen model (persisted in `data/settings.json`). Corrupt `settings.json` and confirm the app still starts and dictates using the env var / default `base`.
20. In the `Candidate summary` panel, after summarizing a split, type a selection reason and click `Select` on one candidate's row. Confirm a `Selected` badge appears on that row, the banner above the table shows the selected candidate and reason, an `stt_candidate_selection` event was appended to the events log, and selecting a different candidate updates the banner/badge without removing the earlier event.
21. With Vosk not installed, click `Benchmark latest` and confirm faster-whisper results still appear and no Vosk `stt_benchmark_result` event is appended (the skip is a quiet `[benchmark] vosk/... unavailable` console warning only). Then install Vosk and set `DICTEX_VOSK_MODEL_DIR` (see "Second STT provider (Vosk)"), benchmark a corrected segment, and confirm a `stt_benchmark_result` with `provider:"vosk"`, `stt_engine:"vosk"`, a latency, and a CER score is appended alongside the faster-whisper ones, and that the candidate summary lists the Vosk candidate on its own row.
22. Correct at least one segment and add it to a benchmark split, then open the `Dataset` view and click `Export dataset`. Confirm the summary shows the export folder path, a total record count, and per-split / per-kind counts, and that `data/exports/stt-dataset-<timestamp>/` contains a `manifest.json` plus one `<split>.<correction_kind>.jsonl` file per non-empty group (frozen test in its own files). Confirm `events.jsonl` is unchanged (no new events written by the export). With a segment carrying both an `acoustic` and a `math_transform` correction, confirm it produces one record in the `*.acoustic.jsonl` and one in the `*.math_transform.jsonl` file. Export again with no corrected segments in any split and confirm the UI reports nothing to export instead of writing an empty folder.

## Run

Windows:

```powershell
cd app
..\scripts\npm.cmd run dev
```

Linux/macOS:

```sh
cd app
../scripts/npm.sh run dev
```

The app uses a Python sidecar with faster-whisper for local transcription.

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

Override example:

```powershell
$env:DICTEX_STT_MODEL="small"
$env:DICTEX_STT_LANGUAGE="fr"
cd app
..\scripts\npm.cmd run dev
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

To run STT on an NVIDIA GPU instead of CPU:

```powershell
$env:DICTEX_STT_MODEL="large-v3-turbo"
$env:DICTEX_STT_DEVICE="cuda"
$env:DICTEX_STT_COMPUTE_TYPE="float16"
cd app
..\scripts\npm.cmd run dev
```

The Windows `ctranslate2` CUDA wheel bundles cuDNN but not cuBLAS. If the
machine has no system-wide CUDA Toolkit install, `cublas64_12.dll` will be
missing and transcription fails with
`RuntimeError: Library cublas64_12.dll is not found or cannot be loaded`.
Install it via pip instead of the full CUDA Toolkit:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore nvidia-cublas-cu12 nvidia-cudnn-cu12
```

`engine/transcribe.py` prepends that package's `bin` directory to `PATH` at
startup on Windows, so no manual `PATH` changes are needed after installing
it.

On Windows, if Python is not available through `py -3.11`, set:

```powershell
$env:DICTEX_PYTHON="C:\Users\souid\DicTeX\.venv\Scripts\python.exe"
```

In development, the Electron app automatically uses the repository `.venv` Python when it exists.

### Second STT provider (Vosk)

The Python sidecar has a small provider abstraction (`engine/providers/`):
`faster-whisper` is the dictation engine and default benchmark provider; **Vosk**
is a second, benchmark-only provider (a different, Kaldi-based engine family —
see `docs/product-decisions.md`). Vosk is fully optional: without it installed,
dictation and faster-whisper benchmarking are unchanged, and the Vosk candidate
is skipped with a quiet diagnostic.

To enable Vosk benchmark candidates:

1. Install the optional dependency:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r engine\requirements-vosk.txt
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
