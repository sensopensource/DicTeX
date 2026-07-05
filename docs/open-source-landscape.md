# Open Source Landscape

DicTeX should reuse existing open source building blocks where possible.

## Speech-To-Text

- whisper.cpp: local Whisper inference, useful for packaging.
- faster-whisper: practical Python implementation for MVP experiments.
- WhisperX: alignment and timestamps, useful for linking corrections to audio.
- sherpa-onnx: offline speech stack based on ONNX Runtime.
- Silero VAD: voice activity detection.

## Local LLM Runtime

- Ollama: simplest local model runner for early experiments.
- llama.cpp: lower-level local model runtime for packaging.
- vLLM: useful later for hosted GPU inference.

## Math Rendering And Validation

- KaTeX: fast browser math rendering.
- MathJax: broader math rendering support.
- SymPy: symbolic validation and manipulation.
- latex2sympy2: LaTeX to SymPy conversion.

## UI

- Tauri: lightweight desktop application shell.
- React: UI layer.
- TipTap: rich document editor.
- CodeMirror: structured text and LaTeX editing.

## Learning And Fine-Tuning Later

- Hugging Face Datasets.
- PEFT.
- TRL.
- Unsloth.
- Axolotl.

## Positioning

Existing projects cover parts of the pipeline, but DicTeX aims to combine:

- local-first mathematical dictation;
- paragraph/math distinction;
- fast correction;
- structured correction logs;
- improvement over time.

