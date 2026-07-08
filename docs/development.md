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
16. Click `Open dictionary`, add an entry like `{"from":"dic tex","to":"DicTeX"}`, save the file, then dictate a phrase containing "dic tex". Confirm the clipboard/pasted text and the `Inserted (normalized)` line show `DicTeX`, the `Last transcript (raw)` textarea still shows the raw STT output, and a `normalization_result` event was appended while `stt_result.stt_output` kept the raw transcript. Break the JSON on purpose and confirm the next dictation still inserts the raw text with a quiet `Normalizer:` diagnostic instead of failing.

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

On Windows, if Python is not available through `py -3.11`, set:

```powershell
$env:DICTEX_PYTHON="C:\Users\souid\DicTeX\.venv\Scripts\python.exe"
```

In development, the Electron app automatically uses the repository `.venv` Python when it exists.

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
```

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

## Normalization Pipeline

Before the transcript is copied/pasted, DicTeX runs it through an ordered
text-to-text normalization pipeline (strategic pivot, Phase 2). Layer 1 is a
deterministic personal dictionary; layers 2 (regex rules) and 3 (seq2seq model)
are added in later issues without reshaping the interface.

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

The raw `stt_result` event is left untouched. Each dictation appends a separate
append-only `normalization_result` event recording the input, the final output,
and every layer's output, so a wrong insertion can be attributed to a specific
layer:

```json
{"event_type":"normalization_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","input_transcript":"dic tex","output_transcript":"DicTeX","passthrough":false,"layers":[{"layer":"personal_dictionary","input":"dic tex","output":"DicTeX","applied":true,"diagnostics":[]}],"diagnostics":[]}
```

History shows the raw transcript; the normalized inserted text is shown
distinctly when it differs.
