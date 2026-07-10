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


DEFAULT_MODEL = "base"
DEFAULT_LANGUAGE = "fr"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"

# A named faster-whisper `initial_prompt` variant, threaded through as a new
# candidate `variant` at constant stage/provider/model (see #93 and
# docs/dataset-and-normalization-design.md §6) — no schema change needed.
PROMPT_VARIANT_ENV = "DICTEX_STT_PROMPT_VARIANT"
# The variant-name -> prompt-text table itself, one place, JSON-encoded (not a
# comma-separated list like DICTEX_STT_BENCHMARK_MODELS) because prompt text
# may itself contain commas.
PROMPT_VARIANTS_ENV = "DICTEX_STT_PROMPT_VARIANTS"


def get_env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def get_prompt_variants() -> dict:
    """Parse named `initial_prompt` variants from ``DICTEX_STT_PROMPT_VARIANTS``:
    a JSON object mapping variant name -> prompt text. Missing, empty, or
    malformed JSON quietly yields no variants rather than crashing the sidecar
    (mirrors the tolerant parsing of DICTEX_STT_BENCHMARK_MODELS on the TS side).
    """
    raw = os.environ.get(PROMPT_VARIANTS_ENV)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        str(name): str(text)
        for name, text in parsed.items()
        if isinstance(name, str) and name.strip() and isinstance(text, str) and text
    }


def resolve_initial_prompt(provider) -> str | None:
    """Resolve the `initial_prompt` text for the requested prompt variant, if any.

    Returns ``None`` when no variant is requested (``DICTEX_STT_PROMPT_VARIANT``
    unset/empty) — the exact value passed to every provider before this feature
    existed, so the no-prompt path stays byte-identical.

    Raises ``ValueError`` (turned into a loud non-zero exit by ``main()``) when
    a variant IS requested but cannot be honored: an unknown variant name, or a
    provider with no prompt concept (Vosk). This is a hard failure, never a
    silent no-op, so a benchmark run can never mistake "prompt ignored" for
    "prompt applied".
    """
    variant_name = os.environ.get(PROMPT_VARIANT_ENV)
    if not variant_name:
        return None

    if not getattr(provider, "SUPPORTS_INITIAL_PROMPT", False):
        raise ValueError(
            f"STT prompt variant '{variant_name}' was requested, but provider "
            f"'{provider.NAME}' has no initial_prompt concept and cannot honor it."
        )

    variants = get_prompt_variants()
    if variant_name not in variants:
        raise ValueError(
            f"Unknown STT prompt variant '{variant_name}'. Define it in "
            f"{PROMPT_VARIANTS_ENV} as a JSON object mapping variant name to "
            f'prompt text, e.g. {{"prompt-v3-fr-math": "..."}}.'
        )
    return variants[variant_name]


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
