import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: transcribe.py <audio_path>", file=sys.stderr)
        return 2

    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 1

    audio_size = audio_path.stat().st_size

    # Placeholder until faster-whisper is wired in. Keeping the Python boundary now
    # validates the Electron -> local engine -> clipboard loop.
    print(
        json.dumps(
            {
                "transcript": f"fake transcript from DicTeX local engine ({audio_size} bytes received)",
                "audio_path": str(audio_path),
                "audio_size": audio_size,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
