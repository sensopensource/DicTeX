"""Vosk STT provider (Kaldi-based, offline, CPU-only).

Vosk is a genuinely different engine family from Whisper, which is the point of
this provider: it makes the benchmark candidate universe multi-provider instead
of "Whisper base vs Whisper small". It is benchmark-only and optional — if the
``vosk`` package or the requested local model directory is absent, transcription
raises :class:`ProviderUnavailable`, which the dispatcher reports as a quiet,
skippable result so faster-whisper flows are never blocked.

Vosk expects 16 kHz mono 16-bit PCM and does not decode compressed audio, so we
reuse PyAV (already installed as a faster-whisper dependency) to decode any
stored segment (webm/opus, wav, ...) to that format. No new decode dependency.
"""

import json
import os
from pathlib import Path
from typing import List, Optional, Tuple

from .base import ProviderUnavailable, TranscriptionResult

NAME = "vosk"

_TARGET_RATE = 16000
# ~0.25 s of 16 kHz mono s16 audio per AcceptWaveform call. Chunking keeps memory
# flat and matches Vosk's streaming recognizer; the exact size is not critical.
_CHUNK_BYTES = _TARGET_RATE * 2 // 4


def _resolve_model_path(model: str) -> str:
    """Resolve a local Vosk model directory from ``model``.

    Resolution is local-only and never downloads:
    1. ``model`` as an absolute/relative path that exists -> use it directly.
    2. ``DICTEX_VOSK_MODEL_DIR/<model>`` if it exists -> use it.
    Otherwise the model is considered absent and the provider is unavailable.
    """
    candidate = Path(model)
    if candidate.is_dir():
        return str(candidate)

    base_dir = os.environ.get("DICTEX_VOSK_MODEL_DIR")
    if base_dir:
        nested = Path(base_dir) / model
        if nested.is_dir():
            return str(nested)

    hint = base_dir or "DICTEX_VOSK_MODEL_DIR (unset)"
    raise ProviderUnavailable(
        f"Vosk model '{model}' not found. Download a Vosk model and either pass "
        f"an absolute path or set DICTEX_VOSK_MODEL_DIR to the directory holding "
        f"model folders (looked under: {hint})."
    )


def _decode_pcm16_mono_16k(audio_path: Path) -> Tuple[bytes, Optional[float]]:
    """Decode any audio file to 16 kHz mono signed-16-bit PCM using PyAV.

    Returns the raw little-endian PCM bytes and the decoded duration in seconds.
    """
    import av
    from av.audio.resampler import AudioResampler

    resampler = AudioResampler(format="s16", layout="mono", rate=_TARGET_RATE)
    chunks: List[bytes] = []
    total_samples = 0

    with av.open(str(audio_path)) as container:
        if not container.streams.audio:
            raise ValueError(f"No audio stream in {audio_path}")
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().tobytes())
                total_samples += resampled.samples
        # Flush any samples buffered inside the resampler.
        for resampled in resampler.resample(None):
            chunks.append(resampled.to_ndarray().tobytes())
            total_samples += resampled.samples

    duration = total_samples / _TARGET_RATE if total_samples else None
    return b"".join(chunks), duration


def transcribe(
    audio_path: Path,
    *,
    model: str,
    language: str,
    device: str,
    compute_type: str,
) -> TranscriptionResult:
    try:
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except ImportError as exc:
        raise ProviderUnavailable(f"vosk is not installed: {exc}")

    # Silence Vosk's noisy Kaldi stderr logging so a benchmark run stays quiet;
    # this must not leak onto stdout, which carries the JSON result.
    SetLogLevel(-1)

    model_path = _resolve_model_path(model)
    pcm, duration = _decode_pcm16_mono_16k(audio_path)

    vosk_model = Model(model_path)
    recognizer = KaldiRecognizer(vosk_model, float(_TARGET_RATE))

    parts: List[str] = []
    for offset in range(0, len(pcm), _CHUNK_BYTES):
        chunk = pcm[offset : offset + _CHUNK_BYTES]
        if recognizer.AcceptWaveform(chunk):
            parts.append(json.loads(recognizer.Result()).get("text", ""))
    parts.append(json.loads(recognizer.FinalResult()).get("text", ""))

    transcript = " ".join(part for part in parts if part).strip()

    return TranscriptionResult(
        transcript=transcript,
        stt_engine=NAME,
        # Report the model as requested (the candidate identity uses this),
        stt_model=model,
        # Vosk does not detect language; echo the requested language so the
        # benchmark candidate variant stays accurate.
        stt_language=language,
        audio_duration_seconds=duration,
        language_probability=None,
    )
