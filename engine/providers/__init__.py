"""Local STT provider registry for the DicTeX sidecar.

Each provider is a module exposing ``NAME`` and a ``transcribe`` function with
the signature described in :mod:`engine.providers.base`. faster-whisper is the
dictation engine and first benchmark provider; Vosk is the second, optional,
benchmark-only provider. The registry stays as small as the two implementations
require — no plugin discovery, no speculative framework.
"""

from . import base, faster_whisper_provider, vosk_provider

# Keep provider names aligned with the benchmark candidate identity written by
# the app (candidate.provider). "faster-whisper" is the default so dictation and
# every existing flow keep calling the same engine when no provider is set.
_PROVIDERS = {
    faster_whisper_provider.NAME: faster_whisper_provider,
    vosk_provider.NAME: vosk_provider,
}

DEFAULT_PROVIDER = faster_whisper_provider.NAME

ProviderUnavailable = base.ProviderUnavailable
TranscriptionResult = base.TranscriptionResult


def get_provider(name: str):
    """Return the provider module for ``name`` or raise ``KeyError``."""
    return _PROVIDERS[name]


def provider_names():
    return list(_PROVIDERS.keys())
