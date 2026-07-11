import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SttWorkerClient,
  WorkerDiedError,
  WorkerRequestError,
  WorkerStartError,
  type ResolvedWorkerConfig,
  type WorkerTransport,
} from "./sttWorkerClient.js";

const config: ResolvedWorkerConfig = {
  provider: "faster-whisper",
  model: "base",
  language: "fr",
  device: "cpu",
  computeType: "int8",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake transport whose stdout/exit the test drives directly. */
class FakeTransport implements WorkerTransport {
  readonly sent: string[] = [];
  readonly killed: NodeJS.Signals[] = [];
  writable = true;
  private messageCb: (line: string) => void = () => {};
  private exitCb: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  private errorCb: (error: Error) => void = () => {};

  send(message: string): boolean {
    if (!this.writable) {
      return false;
    }
    this.sent.push(message);
    return true;
  }

  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? "SIGTERM");
  }

  onMessage(cb: (line: string) => void): void {
    this.messageCb = cb;
  }

  onStderr(): void {}

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCb = cb;
  }

  onSpawnError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  emit(message: Record<string, unknown>): void {
    this.messageCb(JSON.stringify(message));
  }

  emitLine(line: string): void {
    this.messageCb(line);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCb(code, signal);
  }

  spawnError(error: Error): void {
    this.errorCb(error);
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
  }
}

test("ready resolves with the engine identity and load time", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);

  transport.emit({
    type: "ready",
    protocol_version: 1,
    engine: { provider: "faster-whisper", model: "base", device: "cpu", compute_type: "int8", language: "fr" },
    model_load_ms: 42,
  });

  const ready = await client.whenReady();
  assert.equal(ready.model, "base");
  assert.equal(ready.modelLoadMs, 42);
  assert.equal(client.isAlive(), true);
});

test("a transcription result is correlated to its request id", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const pending = client.transcribe({ audioPath: "seg.webm", language: "fr" });
  const sent = transport.lastSent();
  assert.equal(sent.type, "transcribe");
  assert.equal(sent.audio_path, "seg.webm");
  // The loaded model/device/compute-type ride along as the mismatch guard.
  assert.equal(sent.model, "base");
  assert.equal(sent.device, "cpu");
  assert.equal(sent.compute_type, "int8");

  transport.emit({
    type: "transcription_result",
    id: sent.id,
    transcript: "bonjour",
    audio_path: "seg.webm",
    audio_size: 4,
    stt_engine: "faster-whisper",
    stt_model: "base",
    stt_language: "fr",
    stt_language_probability: 0.9,
    stt_duration: 1.5,
    inference_duration_ms: 30,
  });

  const result = await pending;
  assert.equal(result.transcript, "bonjour");
  assert.equal(result.inferenceDurationMs, 30);
  assert.equal(result.audioDurationSeconds, 1.5);
});

test("a recoverable error rejects the request but keeps the worker alive", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const pending = client.transcribe({ audioPath: "missing.webm", language: "fr" });
  const sent = transport.lastSent();
  transport.emit({ type: "error", id: sent.id, code: "audio_not_found", message: "not found", fatal: false });

  await assert.rejects(() => pending, (error: unknown) => {
    assert.ok(error instanceof WorkerRequestError);
    assert.equal(error.code, "audio_not_found");
    return true;
  });
  assert.equal(client.isAlive(), true);
});

test("an incompatible model config is a recoverable request error", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const pending = client.transcribe({ audioPath: "seg.webm", language: "fr" });
  const sent = transport.lastSent();
  transport.emit({ type: "error", id: sent.id, code: "incompatible_model_config", message: "mismatch", fatal: false });

  await assert.rejects(() => pending, WorkerRequestError);
  assert.equal(client.isAlive(), true);
});

test("an unexpected exit fails the in-flight request as a worker death", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const pending = client.transcribe({ audioPath: "seg.webm", language: "fr" });
  transport.exit(1, null);

  await assert.rejects(() => pending, WorkerDiedError);
  assert.equal(client.isAlive(), false);
});

test("a fatal error before ready rejects the start", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);

  transport.emit({ type: "error", id: null, code: "model_load_failed", message: "cannot load", fatal: true });
  transport.exit(1, null);

  await assert.rejects(() => client.whenReady(), WorkerStartError);
  assert.equal(client.isAlive(), false);
});

test("a write failure fails the request as a worker death", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  transport.writable = false;
  await assert.rejects(() => client.transcribe({ audioPath: "seg.webm", language: "fr" }), WorkerDiedError);
});

test("shutdown asks the worker to stop and resolves on exit", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const stopped = client.shutdown(1000);
  assert.equal(transport.lastSent().type, "shutdown");
  transport.exit(0, null);
  await stopped;
  assert.equal(client.isAlive(), false);
});

test("shutdown force-kills the worker after the bounded timeout", async () => {
  const transport = new FakeTransport();
  const client = new SttWorkerClient(config, transport);
  transport.emit({ type: "ready", engine: {}, model_load_ms: 1 });
  await client.whenReady();

  const stopped = client.shutdown(5);
  await delay(30);
  assert.ok(transport.killed.includes("SIGKILL"), "worker is force-killed when it will not stop");
  transport.exit(null, "SIGKILL");
  await stopped;
});
