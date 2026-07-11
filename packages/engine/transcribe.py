import json
import os
import sys
from pathlib import Path

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

if sys.platform == "win32":
    # The Windows ctranslate2 CUDA wheel bundles cuDNN but not cuBLAS, so
    # cublas64_12.dll must be made discoverable ourselves when it's only
    # installed as the nvidia-cublas-cu12 pip package (no system CUDA Toolkit).
    # ctranslate2 loads it via a plain LoadLibraryW call, which only consults
    # PATH, not directories registered through os.add_dll_directory. This runs
    # before any provider imports faster-whisper, so it still applies.
    try:
        import nvidia.cublas

        bin_dir = str(Path(nvidia.cublas.__path__[0]) / "bin")
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass

from providers import DEFAULT_PROVIDER, ProviderUnavailable, get_provider
from stt_config import (
    DEFAULT_COMPUTE_TYPE,
    DEFAULT_DEVICE,
    DEFAULT_LANGUAGE,
    DEFAULT_MODEL,
    PROMPT_VARIANT_ENV,
    get_env,
    resolve_prompt_variant,
)


def resolve_initial_prompt(provider) -> str | None:
    """Resolve the `initial_prompt` text for the env-named variant, if any.

    Reads ``DICTEX_STT_PROMPT_VARIANT`` and delegates to the shared
    ``resolve_prompt_variant`` so the one-shot path and the worker apply the
    same prompt contract; only the trigger (env var vs. per-request field)
    differs. Raises ``ValueError`` for an unknown/unsupported variant.
    """
    return resolve_prompt_variant(provider, os.environ.get(PROMPT_VARIANT_ENV))


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: transcribe.py <audio_path>", file=sys.stderr)
        return 2

    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 1

    audio_size = audio_path.stat().st_size

    provider_name = get_env("DICTEX_STT_PROVIDER", DEFAULT_PROVIDER)
    model_name = get_env("DICTEX_STT_MODEL", DEFAULT_MODEL)
    language = get_env("DICTEX_STT_LANGUAGE", DEFAULT_LANGUAGE)
    device = get_env("DICTEX_STT_DEVICE", DEFAULT_DEVICE)
    compute_type = get_env("DICTEX_STT_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)

    try:
        provider = get_provider(provider_name)
    except KeyError:
        print(f"Unknown STT provider: {provider_name}", file=sys.stderr)
        return 1

    try:
        initial_prompt = resolve_initial_prompt(provider)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    transcribe_kwargs = {
        "model": model_name,
        "language": language,
        "device": device,
        "compute_type": compute_type,
    }
    # Only added to the call when a prompt variant was actually requested and
    # resolved, so the no-prompt call shape (and therefore its output) is
    # completely unchanged from before this feature existed.
    if initial_prompt is not None:
        transcribe_kwargs["initial_prompt"] = initial_prompt

    try:
        result = provider.transcribe(audio_path, **transcribe_kwargs)
    except ProviderUnavailable as exc:
        # Optional provider whose deps/model files are absent: emit a quiet,
        # parseable "unavailable" result and exit 0 so a benchmark run can skip
        # it. faster-whisper dictation never reaches this — its dep is required.
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": provider_name,
                    "model": model_name,
                    "reason": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 0

    # Success output. For faster-whisper this reproduces the original key set and
    # order exactly, so existing flows are byte-for-byte unaffected; Vosk fills
    # the same shape (language_probability is null, duration is derived).
    print(
        json.dumps(
            {
                "transcript": result.transcript,
                "audio_path": str(audio_path),
                "audio_size": audio_size,
                "stt_engine": result.stt_engine,
                "stt_model": result.stt_model,
                "stt_language": result.stt_language,
                "stt_language_probability": result.language_probability,
                "stt_duration": result.audio_duration_seconds,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
