"""Persistent faster-whisper worker for DicTeX dictation.

The one-shot path (`transcribe.py`) reconstructs the model for every dictation:
each dictation's latency therefore pays Python startup and a full model load,
even when the configuration never changed. This worker loads exactly one
model/device/compute-type triple once, then serves many transcriptions over a
versioned NDJSON protocol on stdin/stdout.

Protocol (one JSON object per line):

  worker -> client (stdout, reserved for protocol only)
    {"type":"ready","protocol_version":1,"engine":{...},"model_load_ms":N}
    {"type":"transcription_result","id":"<id>", <stt fields>, "inference_duration_ms":N}
    {"type":"error","id":<id|null>,"code":"...","message":"...","fatal":<bool>}
    {"type":"shutdown_ack"}

  client -> worker (stdin)
    {"type":"transcribe","id":"<id>","audio_path":"...","language":"fr",
     "prompt_variant":<name|null>, "model":..,"device":..,"compute_type":..}
    {"type":"shutdown"}

Design invariants:
- `ready` is emitted only after the model is actually loaded, and carries the
  effective engine identity plus `model_load_ms`.
- Requests are processed strictly sequentially; there is no model pool and the
  loaded configuration is never silently swapped mid-session. A request naming a
  different model/device/compute-type is rejected, not reloaded.
- stdout carries only protocol lines; every diagnostic goes to stderr.
- A recoverable error (bad request, missing audio, unknown prompt variant, a
  failed transcription) is reported as a non-fatal `error` and leaves the worker
  usable. A model that cannot load is fatal: the worker reports it and exits
  non-zero, and any unexpected exit is detectable by the client as a dead pipe.
"""

import importlib
import importlib.util
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, TextIO

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

if sys.platform == "win32":
    # Mirror transcribe.py: make the bundled cuBLAS DLL discoverable before any
    # provider imports faster-whisper, so CUDA works from the pip package alone.
    try:
        import nvidia.cublas

        _bin_dir = str(Path(nvidia.cublas.__path__[0]) / "bin")
        os.environ["PATH"] = _bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass

from providers import DEFAULT_PROVIDER, ProviderUnavailable, get_provider
from stt_config import (
    DEFAULT_COMPUTE_TYPE,
    DEFAULT_DEVICE,
    DEFAULT_LANGUAGE,
    DEFAULT_MODEL,
    get_env,
    resolve_prompt_variant,
)

PROTOCOL_VERSION = 1

# Test/override hook: when set, the worker loads its provider from this module
# (a dotted import name, or a filesystem path to a .py file) instead of the
# registry. This is how the test suite injects a fake provider with a fake model
# so no real model download, GPU, or network is required in CI. Unset in
# production, where the registry's faster-whisper provider is used.
PROVIDER_MODULE_ENV = "DICTEX_STT_WORKER_PROVIDER_MODULE"


class FatalWorkerError(Exception):
    """A terminal condition: the worker cannot continue and must exit non-zero.

    Carries a structured `code` so the client sees the same `error` shape it
    gets for recoverable failures, just with `fatal: true`.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class WorkerConfig:
    provider_name: str
    model: str
    device: str
    compute_type: str
    language: str


def config_from_env() -> WorkerConfig:
    return WorkerConfig(
        provider_name=get_env("DICTEX_STT_PROVIDER", DEFAULT_PROVIDER),
        model=get_env("DICTEX_STT_MODEL", DEFAULT_MODEL),
        device=get_env("DICTEX_STT_DEVICE", DEFAULT_DEVICE),
        compute_type=get_env("DICTEX_STT_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE),
        language=get_env("DICTEX_STT_LANGUAGE", DEFAULT_LANGUAGE),
    )


def _load_provider_module(spec: str):
    """Import a provider module from a dotted name or a filesystem path."""
    if spec.endswith(".py") or os.path.sep in spec or (os.path.altsep and os.path.altsep in spec):
        module_spec = importlib.util.spec_from_file_location("_dictex_worker_provider", spec)
        if module_spec is None or module_spec.loader is None:
            raise FatalWorkerError(
                "provider_unavailable", f"Cannot load provider module from path: {spec}"
            )
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module
    return importlib.import_module(spec)


def resolve_provider(provider_name: str):
    """Resolve the worker's provider, honoring the test override env var.

    Requires the provider to support a persistent (load-once) model; the worker
    exists precisely to keep one model alive, so a provider without that
    capability is a terminal misconfiguration.
    """
    override = os.environ.get(PROVIDER_MODULE_ENV)
    if override:
        try:
            provider = _load_provider_module(override)
        except FatalWorkerError:
            raise
        except Exception as exc:  # noqa: BLE001 - any import failure is terminal
            raise FatalWorkerError(
                "provider_unavailable", f"Cannot load provider module '{override}': {exc}"
            )
    else:
        try:
            provider = get_provider(provider_name)
        except KeyError:
            raise FatalWorkerError(
                "provider_unavailable", f"Unknown STT provider: {provider_name}"
            )

    if not getattr(provider, "SUPPORTS_PERSISTENT_MODEL", False):
        raise FatalWorkerError(
            "provider_unavailable",
            f"Provider '{getattr(provider, 'NAME', provider_name)}' does not support a "
            "persistent model and cannot back the DicTeX worker.",
        )
    return provider


class Worker:
    def __init__(
        self,
        provider,
        config: WorkerConfig,
        out_stream: TextIO,
        err_stream: TextIO,
    ):
        self._provider = provider
        self._config = config
        self._out = out_stream
        self._err = err_stream
        self._model = None

    def _emit(self, message: dict) -> None:
        # stdout is reserved for the protocol; one compact JSON object per line.
        self._out.write(json.dumps(message, ensure_ascii=False) + "\n")
        self._out.flush()

    def _log(self, message: str) -> None:
        # Non-protocol diagnostics go to stderr, never stdout.
        self._err.write(message + "\n")
        self._err.flush()

    def _emit_error(self, request_id: Optional[str], code: str, message: str, fatal: bool) -> None:
        self._emit(
            {
                "type": "error",
                "id": request_id,
                "code": code,
                "message": message,
                "fatal": fatal,
            }
        )

    def load(self) -> None:
        """Load the single model and emit `ready`. Raises FatalWorkerError."""
        config = self._config
        started = time.perf_counter()
        try:
            self._model = self._provider.load_model(
                model=config.model,
                device=config.device,
                compute_type=config.compute_type,
            )
        except ProviderUnavailable as exc:
            raise FatalWorkerError("provider_unavailable", str(exc))
        except Exception as exc:  # noqa: BLE001 - any load failure is terminal
            raise FatalWorkerError(
                "model_load_failed", f"Failed to load model: {exc}"
            )
        model_load_ms = int(round((time.perf_counter() - started) * 1000))

        self._emit(
            {
                "type": "ready",
                "protocol_version": PROTOCOL_VERSION,
                "engine": {
                    "provider": getattr(self._provider, "NAME", config.provider_name),
                    "model": config.model,
                    "device": config.device,
                    "compute_type": config.compute_type,
                    "language": config.language,
                },
                "model_load_ms": model_load_ms,
            }
        )

    def _handle_transcribe(self, request: dict) -> None:
        request_id = request.get("id")
        if not isinstance(request_id, str) or not request_id:
            self._emit_error(
                None, "invalid_request", "transcribe request is missing a string 'id'.", False
            )
            return

        audio_path_raw = request.get("audio_path")
        if not isinstance(audio_path_raw, str) or not audio_path_raw:
            self._emit_error(
                request_id, "invalid_request", "transcribe request is missing 'audio_path'.", False
            )
            return

        # A request must never silently reload a different model: reject any
        # model/device/compute-type that differs from the loaded triple.
        for field, loaded in (
            ("model", self._config.model),
            ("device", self._config.device),
            ("compute_type", self._config.compute_type),
        ):
            requested = request.get(field)
            if requested is not None and requested != loaded:
                self._emit_error(
                    request_id,
                    "incompatible_model_config",
                    f"Request asked for {field}='{requested}' but the worker loaded "
                    f"'{loaded}'. The worker never reloads a model mid-session.",
                    False,
                )
                return

        audio_path = Path(audio_path_raw)
        if not audio_path.exists():
            self._emit_error(
                request_id, "audio_not_found", f"Audio file not found: {audio_path}", False
            )
            return

        language = request.get("language")
        if not isinstance(language, str) or not language:
            language = self._config.language

        prompt_variant = request.get("prompt_variant")
        try:
            initial_prompt = resolve_prompt_variant(self._provider, prompt_variant)
        except ValueError as exc:
            self._emit_error(request_id, "prompt_variant_error", str(exc), False)
            return

        audio_size = audio_path.stat().st_size
        started = time.perf_counter()
        try:
            result = self._provider.transcribe_with_model(
                self._model,
                audio_path,
                model=self._config.model,
                language=language,
                initial_prompt=initial_prompt,
            )
        except Exception as exc:  # noqa: BLE001 - a failed request must not kill the worker
            self._emit_error(
                request_id, "transcription_failed", f"Transcription failed: {exc}", False
            )
            return
        inference_duration_ms = int(round((time.perf_counter() - started) * 1000))

        # Same STT data as the one-shot path, plus the worker-measured inference
        # duration. Keys mirror transcribe.py's success output.
        self._emit(
            {
                "type": "transcription_result",
                "id": request_id,
                "transcript": result.transcript,
                "audio_path": str(audio_path),
                "audio_size": audio_size,
                "stt_engine": result.stt_engine,
                "stt_model": result.stt_model,
                "stt_language": result.stt_language,
                "stt_language_probability": result.language_probability,
                "stt_duration": result.audio_duration_seconds,
                "inference_duration_ms": inference_duration_ms,
            }
        )

    def _handle_line(self, line: str) -> bool:
        """Process one input line. Returns False when the worker should stop."""
        stripped = line.strip()
        if not stripped:
            return True
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError as exc:
            self._emit_error(None, "invalid_request", f"Invalid JSON request: {exc}", False)
            return True
        if not isinstance(request, dict):
            self._emit_error(None, "invalid_request", "Request must be a JSON object.", False)
            return True

        request_type = request.get("type")
        if request_type == "transcribe":
            self._handle_transcribe(request)
            return True
        if request_type == "shutdown":
            self._emit({"type": "shutdown_ack"})
            return False

        self._emit_error(
            request.get("id") if isinstance(request.get("id"), str) else None,
            "unknown_request_type",
            f"Unknown request type: {request_type!r}",
            False,
        )
        return True

    def serve(self, in_stream: TextIO) -> int:
        """Serve requests until an explicit shutdown or EOF on stdin."""
        for line in in_stream:
            if not self._handle_line(line):
                break
        return 0


def main() -> int:
    config = config_from_env()
    out_stream = sys.stdout
    err_stream = sys.stderr
    try:
        provider = resolve_provider(config.provider_name)
    except FatalWorkerError as exc:
        # No worker instance yet: emit the fatal error shape directly.
        out_stream.write(
            json.dumps(
                {"type": "error", "id": None, "code": exc.code, "message": exc.message, "fatal": True},
                ensure_ascii=False,
            )
            + "\n"
        )
        out_stream.flush()
        err_stream.write(exc.message + "\n")
        err_stream.flush()
        return 1

    worker = Worker(provider, config, out_stream, err_stream)
    try:
        worker.load()
    except FatalWorkerError as exc:
        worker._emit_error(None, exc.code, exc.message, True)
        worker._log(exc.message)
        return 1

    return worker.serve(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
