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
8. Click `Open events log` and confirm `audio_segment` and `stt_result` events were appended.
9. Click `Open data folder` and confirm the stored audio file exists under `data/audio/session_.../`.
10. Click `Benchmark latest` and confirm `tiny`, `base`, and `small` STT results appear and `stt_benchmark_result` events are appended.

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
```

Each dictation writes at least two events:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_mime_type":"audio/webm;codecs=opus","audio_size_bytes":25412}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_language":"fr","stt_output":"...","corrected_transcript":null}
```

The STT benchmark action reuses the latest stored audio segment and appends one result per tested model:

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830}
```

The correction UX is intentionally not implemented yet. The important MVP decision is to preserve the audio -> STT output link from the beginning.
