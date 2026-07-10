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


def transcribe(
    audio_path: Path,
    *,
    model: str,
    language: str,
    device: str,
    compute_type: str,
    initial_prompt: Optional[str] = None,
) -> TranscriptionResult:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - faster-whisper is required
        raise ProviderUnavailable(f"faster-whisper is not installed: {exc}")

    whisper_model = WhisperModel(model, device=device, compute_type=compute_type)
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
