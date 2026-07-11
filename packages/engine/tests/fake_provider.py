"""A fake, dependency-free STT provider for worker tests.

It satisfies the persistent-provider contract (`load_model` +
`transcribe_with_model`) with no model download, GPU, or network, so the worker
can be exercised end-to-end in CI. `load_model` records each construction to the
file named by ``DICTEX_FAKE_MODEL_LOAD_LOG`` (when set) so a subprocess test can
prove the model is built exactly once across many requests.
"""

import os
from pathlib import Path

from providers.base import TranscriptionResult

NAME = "fake-stt"
SUPPORTS_INITIAL_PROMPT = True
SUPPORTS_PERSISTENT_MODEL = True


class _FakeModel:
    def __init__(self, model: str, device: str, compute_type: str):
        self.model = model
        self.device = device
        self.compute_type = compute_type


def load_model(*, model: str, device: str, compute_type: str) -> _FakeModel:
    log_path = os.environ.get("DICTEX_FAKE_MODEL_LOAD_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(f"{model}|{device}|{compute_type}\n")
    return _FakeModel(model, device, compute_type)


def transcribe_with_model(
    whisper_model: _FakeModel,
    audio_path: Path,
    *,
    model: str,
    language: str,
    initial_prompt=None,
) -> TranscriptionResult:
    # Deterministic, so a test can correlate a result back to its request by the
    # audio name, language, and resolved prompt.
    transcript = f"fake:{audio_path.name}|lang={language}|prompt={initial_prompt}"
    return TranscriptionResult(
        transcript=transcript,
        stt_engine=NAME,
        stt_model=model,
        stt_language=language,
        audio_duration_seconds=1.5,
        language_probability=0.99,
    )
