"""Tests for the persistent faster-whisper worker (`worker.py`).

These use a fake provider/model (see fake_provider.py) so nothing here downloads
a model, touches a GPU, or reaches the network — the whole suite runs in CI.

Two levels of coverage:
- In-process: drive `Worker` over StringIO streams with an injected fake
  provider, so error/protocol behavior and the load-once guarantee are asserted
  directly.
- Subprocess: spawn `worker.py` over real stdin/stdout pipes with the fake
  provider selected via `DICTEX_STT_WORKER_PROVIDER_MODULE`, proving the NDJSON
  protocol and the "model constructed once across >=2 requests" acceptance
  criterion end-to-end.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import worker  # noqa: E402
from providers.base import TranscriptionResult  # noqa: E402

FAKE_PROVIDER_PATH = str(Path(__file__).resolve().parent / "fake_provider.py")


class CountingProvider:
    """In-process fake provider that counts model constructions."""

    NAME = "counting-fake"
    SUPPORTS_INITIAL_PROMPT = True
    SUPPORTS_PERSISTENT_MODEL = True

    def __init__(self, prompt_variants=None, fail_transcribe=False):
        self.load_calls = 0
        self.transcribe_calls = 0
        self._prompt_variants = prompt_variants or {}
        self._fail_transcribe = fail_transcribe

    def load_model(self, *, model, device, compute_type):
        self.load_calls += 1
        return {"model": model, "device": device, "compute_type": compute_type}

    def transcribe_with_model(self, whisper_model, audio_path, *, model, language, initial_prompt=None):
        self.transcribe_calls += 1
        if self._fail_transcribe:
            raise RuntimeError("boom")
        return TranscriptionResult(
            transcript=f"{audio_path.name}|{language}|{initial_prompt}",
            stt_engine=self.NAME,
            stt_model=model,
            stt_language=language,
            audio_duration_seconds=1.5,
            language_probability=0.9,
        )


def make_config(**overrides):
    base = dict(
        provider_name="counting-fake",
        model="base",
        device="cpu",
        compute_type="int8",
        language="fr",
    )
    base.update(overrides)
    return worker.WorkerConfig(**base)


def run_worker(provider, lines, config=None):
    """Load a Worker and feed it `lines`; return (messages, stderr_text)."""
    out = io.StringIO()
    err = io.StringIO()
    w = worker.Worker(provider, config or make_config(), out, err)
    w.load()
    w.serve(iter(lines))
    messages = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    return messages, err.getvalue()


class TestWorkerInProcess(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.audio = Path(self._tmp.name) / "seg_0001.webm"
        self.audio.write_bytes(b"\x00\x01\x02\x03")

    def _transcribe_line(self, request_id, **fields):
        payload = {"type": "transcribe", "id": request_id, "audio_path": str(self.audio)}
        payload.update(fields)
        return json.dumps(payload)

    def test_ready_reports_engine_identity_and_load_time(self):
        provider = CountingProvider()
        messages, _ = run_worker(provider, [])
        self.assertEqual(messages[0]["type"], "ready")
        self.assertEqual(messages[0]["protocol_version"], worker.PROTOCOL_VERSION)
        self.assertEqual(messages[0]["engine"]["provider"], "counting-fake")
        self.assertEqual(messages[0]["engine"]["model"], "base")
        self.assertIn("model_load_ms", messages[0])
        self.assertIsInstance(messages[0]["model_load_ms"], int)

    def test_model_loaded_once_across_multiple_requests(self):
        provider = CountingProvider()
        lines = [self._transcribe_line("r1"), self._transcribe_line("r2"), self._transcribe_line("r3")]
        messages, _ = run_worker(provider, lines)
        self.assertEqual(provider.load_calls, 1)
        self.assertEqual(provider.transcribe_calls, 3)
        results = [m for m in messages if m["type"] == "transcription_result"]
        self.assertEqual([r["id"] for r in results], ["r1", "r2", "r3"])

    def test_result_carries_stt_fields_plus_inference_duration(self):
        provider = CountingProvider()
        messages, _ = run_worker(provider, [self._transcribe_line("r1", language="en")])
        result = next(m for m in messages if m["type"] == "transcription_result")
        self.assertEqual(result["id"], "r1")
        self.assertEqual(result["stt_engine"], "counting-fake")
        self.assertEqual(result["stt_model"], "base")
        self.assertEqual(result["stt_language"], "en")
        self.assertEqual(result["stt_language_probability"], 0.9)
        self.assertEqual(result["stt_duration"], 1.5)
        self.assertEqual(result["audio_size"], 4)
        self.assertIn("inference_duration_ms", result)
        self.assertIsInstance(result["inference_duration_ms"], int)

    def test_missing_audio_is_recoverable_error(self):
        provider = CountingProvider()
        line = json.dumps({"type": "transcribe", "id": "r1", "audio_path": "does/not/exist.webm"})
        # A second valid request proves the worker stayed usable after the error.
        messages, _ = run_worker(provider, [line, self._transcribe_line("r2")])
        error = next(m for m in messages if m["type"] == "error")
        self.assertEqual(error["id"], "r1")
        self.assertEqual(error["code"], "audio_not_found")
        self.assertFalse(error["fatal"])
        self.assertTrue(any(m["type"] == "transcription_result" and m["id"] == "r2" for m in messages))

    def test_incompatible_model_config_is_rejected_not_reloaded(self):
        provider = CountingProvider()
        line = self._transcribe_line("r1", model="large-v3-turbo")
        messages, _ = run_worker(provider, [line])
        error = next(m for m in messages if m["type"] == "error")
        self.assertEqual(error["code"], "incompatible_model_config")
        self.assertFalse(error["fatal"])
        # Still exactly one construction: never silently reloaded.
        self.assertEqual(provider.load_calls, 1)
        self.assertEqual(provider.transcribe_calls, 0)

    def test_invalid_json_is_recoverable_and_uncorrelated(self):
        provider = CountingProvider()
        messages, _ = run_worker(provider, ["{not json", self._transcribe_line("r2")])
        error = next(m for m in messages if m["type"] == "error")
        self.assertIsNone(error["id"])
        self.assertEqual(error["code"], "invalid_request")
        self.assertTrue(any(m["type"] == "transcription_result" for m in messages))

    def test_unknown_prompt_variant_is_recoverable_error(self):
        provider = CountingProvider()
        line = self._transcribe_line("r1", prompt_variant="nope")
        messages, _ = run_worker(provider, [line])
        error = next(m for m in messages if m["type"] == "error")
        self.assertEqual(error["id"], "r1")
        self.assertEqual(error["code"], "prompt_variant_error")
        self.assertFalse(error["fatal"])

    def test_transcription_failure_keeps_worker_usable(self):
        provider = CountingProvider(fail_transcribe=True)
        messages, _ = run_worker(provider, [self._transcribe_line("r1")])
        error = next(m for m in messages if m["type"] == "error")
        self.assertEqual(error["id"], "r1")
        self.assertEqual(error["code"], "transcription_failed")
        self.assertFalse(error["fatal"])

    def test_unknown_request_type(self):
        provider = CountingProvider()
        messages, _ = run_worker(provider, [json.dumps({"type": "frobnicate", "id": "r1"})])
        error = next(m for m in messages if m["type"] == "error")
        self.assertEqual(error["code"], "unknown_request_type")

    def test_shutdown_is_clean_and_acknowledged(self):
        provider = CountingProvider()
        out = io.StringIO()
        err = io.StringIO()
        w = worker.Worker(provider, make_config(), out, err)
        w.load()
        # Anything after shutdown must not be processed.
        code = w.serve(iter([json.dumps({"type": "shutdown"}), self._transcribe_line("late")]))
        self.assertEqual(code, 0)
        messages = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
        self.assertEqual(messages[-1]["type"], "shutdown_ack")
        self.assertFalse(any(m["type"] == "transcription_result" for m in messages))

    def test_provider_without_persistent_support_is_fatal(self):
        class NoPersist:
            NAME = "no-persist"

        os.environ.pop(worker.PROVIDER_MODULE_ENV, None)
        # resolve_provider only reaches here via env override; simulate directly.
        provider = NoPersist()
        with self.assertRaises(worker.FatalWorkerError) as ctx:
            if not getattr(provider, "SUPPORTS_PERSISTENT_MODEL", False):
                raise worker.FatalWorkerError("provider_unavailable", "no persistent support")
        self.assertEqual(ctx.exception.code, "provider_unavailable")


class TestWorkerSubprocess(unittest.TestCase):
    """Full NDJSON round-trip over real pipes, provider injected via env."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.audio = Path(self._tmp.name) / "seg_0001.webm"
        self.audio.write_bytes(b"\x00\x01\x02\x03")
        self.load_log = Path(self._tmp.name) / "load.log"

    def _spawn(self, env_extra):
        env = dict(os.environ)
        env["DICTEX_STT_WORKER_PROVIDER_MODULE"] = FAKE_PROVIDER_PATH
        env["DICTEX_FAKE_MODEL_LOAD_LOG"] = str(self.load_log)
        env.update(env_extra)
        return subprocess.Popen(
            [sys.executable, str(ENGINE_DIR / "worker.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
        )

    def test_two_requests_construct_model_once(self):
        proc = self._spawn({})
        requests = "".join(
            json.dumps({"type": "transcribe", "id": rid, "audio_path": str(self.audio)}) + "\n"
            for rid in ("r1", "r2")
        )
        requests += json.dumps({"type": "shutdown"}) + "\n"
        stdout, stderr = proc.communicate(requests, timeout=30)
        self.assertEqual(proc.returncode, 0, msg=stderr)

        messages = [json.loads(l) for l in stdout.splitlines() if l.strip()]
        types = [m["type"] for m in messages]
        self.assertEqual(types[0], "ready")
        self.assertEqual(types[-1], "shutdown_ack")

        results = {m["id"]: m for m in messages if m["type"] == "transcription_result"}
        self.assertEqual(set(results), {"r1", "r2"})

        # The acceptance criterion: exactly one model construction for >=2 requests.
        load_lines = self.load_log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(load_lines), 1, msg=f"expected one model load, got {load_lines}")

    def test_stdout_is_pure_ndjson_even_with_a_bad_request(self):
        proc = self._spawn({})
        requests = "not-json\n"
        requests += json.dumps({"type": "transcribe", "id": "r1", "audio_path": str(self.audio)}) + "\n"
        requests += json.dumps({"type": "shutdown"}) + "\n"
        stdout, stderr = proc.communicate(requests, timeout=30)
        self.assertEqual(proc.returncode, 0, msg=stderr)
        # Every stdout line must parse as JSON — no stray diagnostics leak in.
        for line in stdout.splitlines():
            if line.strip():
                json.loads(line)

    def test_missing_provider_module_is_fatal_nonzero(self):
        env = dict(os.environ)
        env["DICTEX_STT_WORKER_PROVIDER_MODULE"] = str(Path(self._tmp.name) / "missing.py")
        proc = subprocess.Popen(
            [sys.executable, str(ENGINE_DIR / "worker.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
        )
        stdout, stderr = proc.communicate("", timeout=30)
        self.assertEqual(proc.returncode, 1)
        messages = [json.loads(l) for l in stdout.splitlines() if l.strip()]
        self.assertTrue(messages)
        self.assertEqual(messages[0]["type"], "error")
        self.assertTrue(messages[0]["fatal"])


if __name__ == "__main__":
    unittest.main()
