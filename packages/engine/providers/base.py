"""Shared types for STT providers.

The abstraction is intentionally minimal: a provider is a module with a ``NAME``
and a ``transcribe(audio_path, *, model, language, device, compute_type)``
function returning a :class:`TranscriptionResult`. A provider whose Python
dependencies or local model files are absent raises :class:`ProviderUnavailable`
so the dispatcher can report it as a quiet, skippable "unavailable" result
rather than a hard failure.
"""

from dataclasses import dataclass
from typing import Optional


class ProviderUnavailable(Exception):
    """A provider's dependencies or model files are absent.

    This is not an error in the transcription itself; the dispatcher turns it
    into an ``{"available": false, ...}`` result and exits 0 so a benchmark run
    skips the provider without aborting. The faster-whisper dictation path
    never hits this in practice — its dependency is required.
    """


@dataclass
class TranscriptionResult:
    transcript: str
    stt_engine: str
    stt_model: str
    stt_language: str
    audio_duration_seconds: Optional[float] = None
    language_probability: Optional[float] = None
