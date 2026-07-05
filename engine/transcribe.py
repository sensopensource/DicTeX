import json
import os
import sys
from pathlib import Path

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

from faster_whisper import WhisperModel


DEFAULT_MODEL = "base"
DEFAULT_LANGUAGE = "fr"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"


def get_env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: transcribe.py <audio_path>", file=sys.stderr)
        return 2

    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 1

    audio_size = audio_path.stat().st_size

    model_name = get_env("DICTEX_STT_MODEL", DEFAULT_MODEL)
    language = get_env("DICTEX_STT_LANGUAGE", DEFAULT_LANGUAGE)
    device = get_env("DICTEX_STT_DEVICE", DEFAULT_DEVICE)
    compute_type = get_env("DICTEX_STT_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(str(audio_path), language=language, vad_filter=True)
    transcript = " ".join(segment.text.strip() for segment in segments).strip()

    print(
        json.dumps(
            {
                "transcript": transcript,
                "audio_path": str(audio_path),
                "audio_size": audio_size,
                "stt_engine": "faster-whisper",
                "stt_model": model_name,
                "stt_language": info.language,
                "stt_language_probability": info.language_probability,
                "stt_duration": info.duration,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
