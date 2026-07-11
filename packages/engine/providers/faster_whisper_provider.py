"""faster-whisper STT provider.

This wraps the original single-engine logic unchanged so the dictation path and
existing benchmark flows stay byte-for-byte identical. The cuBLAS DLL path fix
for Windows CUDA lives in ``transcribe.py`` (the dispatcher) and runs before any
provider imports faster-whisper, so it still applies here.
"""

from pathlib import Path
from typing import Optional

from .base import ProviderUnavailable, TranscriptionResult

NAME = "faster-whisper"

# The only local provider with a system-prompt concept (faster-whisper's
# `initial_prompt`, itself a thin wrapper over whisper's decoder prompt).
# `transcribe.py` checks this before ever passing `initial_prompt` through, so
# a prompt variant requested against a provider without this flag fails loudly
# instead of being silently dropped.
SUPPORTS_INITIAL_PROMPT = True

# This provider can keep a loaded model alive across many transcriptions (the
# `load_model` / `transcribe_with_model` split below). The persistent worker
# (`worker.py`) requires this capability; the one-shot `transcribe` composes the
# same two steps, so both paths run byte-for-byte identical transcription logic.
SUPPORTS_PERSISTENT_MODEL = True


def load_model(*, model: str, device: str, compute_type: str):
    """Construct and return a loaded ``WhisperModel``.

    Split out of ``transcribe`` so the persistent worker can pay this cost once
    per process while the one-shot path still constructs a fresh model per call.
    Raises :class:`ProviderUnavailable` when faster-whisper is not installed.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - faster-whisper is required
        raise ProviderUnavailable(f"faster-whisper is not installed: {exc}")

    return WhisperModel(model, device=device, compute_type=compute_type)


def transcribe_with_model(
    whisper_model,
    audio_path: Path,
    *,
    model: str,
    language: str,
    initial_prompt: Optional[str] = None,
) -> TranscriptionResult:
    """Transcribe using an already-loaded model.

    This holds the exact decode call the one-shot path used to run inline, so a
    warm request from the worker and a cold one-shot call produce identical
    output for the same audio and configuration.
    """
    # `initial_prompt=None` is faster-whisper's own default, so a call with no
    # prompt configured is byte-for-byte identical to calling `.transcribe()`
    # without the keyword at all — the no-prompt path is unchanged.
    segments, info = whisper_model.transcribe(
        str(audio_path), language=language, vad_filter=True, initial_prompt=initial_prompt
    )
    transcript = " ".join(segment.text.strip() for segment in segments).strip()

    return TranscriptionResult(
        transcript=transcript,
        stt_engine=NAME,
        stt_model=model,
        stt_language=info.language,
        audio_duration_seconds=info.duration,
        language_probability=info.language_probability,
    )


def transcribe(
    audio_path: Path,
    *,
    model: str,
    language: str,
    device: str,
    compute_type: str,
    initial_prompt: Optional[str] = None,
) -> TranscriptionResult:
    whisper_model = load_model(model=model, device=device, compute_type=compute_type)
    return transcribe_with_model(
        whisper_model,
        audio_path,
        model=model,
        language=language,
        initial_prompt=initial_prompt,
    )
