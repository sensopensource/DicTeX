"""faster-whisper STT provider.

This wraps the original single-engine logic unchanged so the dictation path and
existing benchmark flows stay byte-for-byte identical. The cuBLAS DLL path fix
for Windows CUDA lives in ``transcribe.py`` (the dispatcher) and runs before any
provider imports faster-whisper, so it still applies here.
"""

from pathlib import Path

from .base import ProviderUnavailable, TranscriptionResult

NAME = "faster-whisper"


def transcribe(
    audio_path: Path,
    *,
    model: str,
    language: str,
    device: str,
    compute_type: str,
) -> TranscriptionResult:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - faster-whisper is required
        raise ProviderUnavailable(f"faster-whisper is not installed: {exc}")

    whisper_model = WhisperModel(model, device=device, compute_type=compute_type)
    segments, info = whisper_model.transcribe(str(audio_path), language=language, vad_filter=True)
    transcript = " ".join(segment.text.strip() for segment in segments).strip()

    return TranscriptionResult(
        transcript=transcript,
        stt_engine=NAME,
        stt_model=model,
        stt_language=info.language,
        audio_duration_seconds=info.duration,
        language_probability=info.language_probability,
    )
