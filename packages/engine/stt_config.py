"""Shared STT configuration and `initial_prompt` variant resolution.

Both the one-shot dispatcher (`transcribe.py`) and the persistent worker
(`worker.py`) read model/device/compute-type config the same way and resolve
`initial_prompt` variants against the same env-provided table, so a warm worker
request and a cold one-shot call honor an identical prompt contract. Only the
*trigger* differs: the one-shot path names its single variant through
``DICTEX_STT_PROMPT_VARIANT``; the worker names one per request.
"""

import json
import os
from typing import Optional

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


def resolve_prompt_variant(provider, variant_name: Optional[str]) -> Optional[str]:
    """Resolve a named `initial_prompt` variant to its prompt text.

    Returns ``None`` when ``variant_name`` is empty/``None`` — the exact value
    passed to every provider before prompt variants existed, so the no-prompt
    path stays byte-identical.

    Raises ``ValueError`` when a variant IS named but cannot be honored: a
    provider with no prompt concept (e.g. Vosk), or an unknown variant name.
    Callers turn this into a loud failure, never a silent no-op, so a run can
    never mistake "prompt ignored" for "prompt applied".
    """
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
