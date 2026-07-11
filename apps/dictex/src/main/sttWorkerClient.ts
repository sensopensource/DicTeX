import { spawn as childSpawn } from "node:child_process";
import readline from "node:readline";
import { getPythonInvocation } from "@dictex/shared";

/**
 * Client for one generation of the persistent faster-whisper worker
 * (`packages/engine/worker.py`, issue #114). It owns exactly one Python process,
 * speaks the versioned NDJSON protocol on that process's stdin/stdout, and
 * exposes a small typed surface the lifecycle manager (`sttWorkerManager.ts`)
 * drives.
 *
 * A worker loads exactly one model/device/compute-type triple, chosen at spawn
 * time through env vars, and never reloads it: a request naming a different
 * model is rejected, not swapped in. Changing the model is therefore the
 * manager's job (stop this generation, start a new one), not this client's.
 *
 * The transport is injectable so the protocol can be unit-tested over fake
 * streams without spawning Python; production uses `createRealTransport`.
 */

/** The single model/runtime a worker generation is spawned to serve. */
export type ResolvedWorkerConfig = {
  provider: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
  /** Optional named faster-whisper `initial_prompt` variant (#93/#94). */
  promptVariant?: string;
};

/** Engine identity + measured load time reported by the worker's `ready`. */
export type WorkerReady = {
  provider: string;
  model: string;
  device: string;
  computeType: string;
  language: string;
  modelLoadMs: number;
};

/** One transcription request. The client assigns the correlation id itself. */
export type WorkerTranscribeRequest = {
  audioPath: string;
  language: string;
  promptVariant?: string;
};

/** A successful `transcription_result`. Mirrors the worker's success fields. */
export type WorkerTranscription = {
  id: string;
  transcript: string;
  audioPath: string;
  audioSize: number | null;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  sttLanguageProbability: number | null;
  audioDurationSeconds: number | null;
  inferenceDurationMs: number | null;
};

/** The worker failed to become ready (fatal load error or early exit). */
export class WorkerStartError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkerStartError";
  }
}

/**
 * The worker reported a recoverable, request-correlated error (bad request,
 * missing audio, unknown prompt variant, failed transcription, or a rejected
 * model mismatch). The worker stays usable; the request itself failed.
 */
export class WorkerRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkerRequestError";
  }
}

/**
 * The worker process ended (or its pipe failed) while the request was pending.
 * The manager treats this as a crash: restart once and replay once.
 */
export class WorkerDiedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkerDiedError";
  }
}

/** The subset of a worker generation the lifecycle manager depends on. */
export interface WorkerClient {
  readonly config: ResolvedWorkerConfig;
  /** True until the process has exited or failed to spawn. */
  isAlive(): boolean;
  /** Resolves once the model is loaded; rejects with `WorkerStartError`. */
  whenReady(): Promise<WorkerReady>;
  /** Resolves on the correlated result; rejects with a request or died error. */
  transcribe(request: WorkerTranscribeRequest): Promise<WorkerTranscription>;
  /** Ask the worker to stop; force-kill after `timeoutMs`. Resolves on exit. */
  shutdown(timeoutMs: number): Promise<void>;
  /** Force-kill immediately. */
  kill(): void;
}

/** Transport over one already-spawned worker process. */
export interface WorkerTransport {
  /** Write one protocol object (the transport adds the trailing newline). */
  send(message: string): boolean;
  kill(signal?: NodeJS.Signals): void;
  onMessage(cb: (line: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onSpawnError(cb: (error: Error) => void): void;
}

export type WorkerTransportFactory = (params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => WorkerTransport;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const deferred: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      resolve(value);
    },
    reject: (reason) => {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      reject(reason);
    },
  };
  // Never let an unobserved rejection crash the process; every consumer that
  // cares attaches its own handler to `promise`.
  promise.catch(() => {});
  return deferred;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when two configs name the same worker generation (same loaded model). */
export function workerConfigsEqual(a: ResolvedWorkerConfig, b: ResolvedWorkerConfig): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.language === b.language &&
    a.device === b.device &&
    a.computeType === b.computeType &&
    (a.promptVariant ?? null) === (b.promptVariant ?? null)
  );
}

export class SttWorkerClient implements WorkerClient {
  readonly config: ResolvedWorkerConfig;
  private readonly transport: WorkerTransport;
  private readonly log: (message: string) => void;
  private readonly readyDeferred = defer<WorkerReady>();
  private readonly pending = new Map<string, Deferred<WorkerTranscription>>();
  private shutdownDeferred: Deferred<void> | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;
  private ready = false;
  private dead = false;

  constructor(config: ResolvedWorkerConfig, transport: WorkerTransport, log: (message: string) => void = () => {}) {
    this.config = config;
    this.transport = transport;
    this.log = log;
    transport.onMessage((line) => this.handleLine(line));
    transport.onStderr((text) => this.log(`[stt-worker:stderr] ${text.replace(/\s+$/, "")}`));
    transport.onExit((code, signal) => this.handleExit(code, signal));
    transport.onSpawnError((error) => this.handleSpawnError(error));
  }

  isAlive(): boolean {
    return !this.dead;
  }

  whenReady(): Promise<WorkerReady> {
    return this.readyDeferred.promise;
  }

  transcribe(request: WorkerTranscribeRequest): Promise<WorkerTranscription> {
    if (this.dead) {
      return Promise.reject(new WorkerDiedError("STT worker is not running.", "worker_dead"));
    }

    const id = `req_${(this.requestCounter += 1)}`;
    const deferred = defer<WorkerTranscription>();
    this.pending.set(id, deferred);

    // Send the loaded model/device/compute-type back as a guard: the worker
    // rejects a mismatch loudly instead of silently transcribing with the wrong
    // model. They always match here (both derive from `this.config`), so the
    // guard only ever fires on a real desync bug.
    const sent = this.transport.send(
      JSON.stringify({
        type: "transcribe",
        id,
        audio_path: request.audioPath,
        language: request.language || this.config.language,
        model: this.config.model,
        device: this.config.device,
        compute_type: this.config.computeType,
        prompt_variant: request.promptVariant ?? this.config.promptVariant ?? null,
      }),
    );

    if (!sent) {
      this.pending.delete(id);
      this.markDead();
      deferred.reject(new WorkerDiedError("Could not write to the STT worker.", "pipe_closed"));
    }

    return deferred.promise;
  }

  shutdown(timeoutMs: number): Promise<void> {
    if (this.dead) {
      return Promise.resolve();
    }
    if (this.shutdownDeferred) {
      return this.shutdownDeferred.promise;
    }

    const deferred = defer<void>();
    this.shutdownDeferred = deferred;

    const sent = this.transport.send(JSON.stringify({ type: "shutdown" }));
    if (!sent) {
      // The pipe is already gone; skip the graceful wait and force-kill.
      this.transport.kill("SIGKILL");
    } else {
      this.shutdownTimer = setTimeout(() => {
        this.log("[stt-worker] shutdown timed out; killing the worker.");
        this.transport.kill("SIGKILL");
      }, timeoutMs);
      if (typeof this.shutdownTimer.unref === "function") {
        this.shutdownTimer.unref();
      }
    }

    return deferred.promise;
  }

  kill(): void {
    if (!this.dead) {
      this.transport.kill("SIGKILL");
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[stt-worker] ignored unparseable protocol line: ${line}`);
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }

    const record = message as Record<string, unknown>;
    switch (record.type) {
      case "ready":
        this.handleReady(record);
        return;
      case "transcription_result":
        this.handleResult(record);
        return;
      case "error":
        this.handleError(record);
        return;
      case "shutdown_ack":
        // The process exit resolves the shutdown promise; the ack only tells us
        // the graceful stop is under way.
        this.log("[stt-worker] shutdown acknowledged.");
        return;
      default:
        this.log(`[stt-worker] ignored unknown message type: ${String(record.type)}`);
    }
  }

  private handleReady(record: Record<string, unknown>): void {
    this.ready = true;
    const engine = (typeof record.engine === "object" && record.engine !== null ? record.engine : {}) as Record<
      string,
      unknown
    >;
    this.readyDeferred.resolve({
      provider: asString(engine.provider, this.config.provider),
      model: asString(engine.model, this.config.model),
      device: asString(engine.device, this.config.device),
      computeType: asString(engine.compute_type, this.config.computeType),
      language: asString(engine.language, this.config.language),
      modelLoadMs: asNumberOrNull(record.model_load_ms) ?? 0,
    });
  }

  private handleResult(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" ? record.id : null;
    const deferred = id ? this.pending.get(id) : undefined;
    if (!id || !deferred) {
      this.log(`[stt-worker] result for unknown request id: ${String(record.id)}`);
      return;
    }
    this.pending.delete(id);
    deferred.resolve({
      id,
      transcript: asString(record.transcript, ""),
      audioPath: asString(record.audio_path, ""),
      audioSize: asNumberOrNull(record.audio_size),
      sttEngine: asString(record.stt_engine, "unknown"),
      sttModel: asString(record.stt_model, "unknown"),
      sttLanguage: asString(record.stt_language, "unknown"),
      sttLanguageProbability: asNumberOrNull(record.stt_language_probability),
      audioDurationSeconds: asNumberOrNull(record.stt_duration),
      inferenceDurationMs: asNumberOrNull(record.inference_duration_ms),
    });
  }

  private handleError(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" ? record.id : null;
    const code = asString(record.code, "worker_error");
    const message = asString(record.message, "STT worker error");
    const fatal = record.fatal === true;

    if (id && this.pending.has(id)) {
      const deferred = this.pending.get(id)!;
      this.pending.delete(id);
      // Per-request errors are non-fatal; a fatal error correlated to a request
      // means the worker is dying, so recover instead of surfacing it.
      deferred.reject(
        fatal ? new WorkerDiedError(message, code) : new WorkerRequestError(message, code),
      );
      return;
    }

    if (!this.ready) {
      // A fatal startup error (provider/model load) arrives before `ready`.
      this.readyDeferred.reject(new WorkerStartError(message, code));
      return;
    }

    this.log(`[stt-worker] uncorrelated ${fatal ? "fatal " : ""}error ${code}: ${message}`);
    if (fatal) {
      this.markDead();
      this.failPending(new WorkerDiedError(message, code));
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasDead = this.dead;
    this.markDead();
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    const reason = `STT worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    this.readyDeferred.reject(new WorkerStartError(reason, "worker_exited"));
    this.failPending(new WorkerDiedError(reason, "worker_exited"));
    if (this.shutdownDeferred) {
      this.shutdownDeferred.resolve();
    }
    if (!wasDead) {
      this.log(reason);
    }
  }

  private handleSpawnError(error: Error): void {
    this.markDead();
    const message = `STT worker failed to start: ${error.message}`;
    this.readyDeferred.reject(new WorkerStartError(message, "spawn_failed"));
    this.failPending(new WorkerDiedError(message, "spawn_failed"));
    if (this.shutdownDeferred) {
      this.shutdownDeferred.resolve();
    }
  }

  private markDead(): void {
    this.dead = true;
    this.ready = false;
  }

  private failPending(error: WorkerDiedError): void {
    for (const deferred of this.pending.values()) {
      deferred.reject(error);
    }
    this.pending.clear();
  }
}

/** Spawns a real worker process and frames its stdio as the transport. */
export const createRealTransport: WorkerTransportFactory = ({ command, args, cwd, env }) => {
  const child = childSpawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = readline.createInterface({ input: child.stdout });

  return {
    send(message: string): boolean {
      if (!child.stdin.writable) {
        return false;
      }
      try {
        return child.stdin.write(`${message}\n`);
      } catch {
        return false;
      }
    },
    kill(signal?: NodeJS.Signals): void {
      if (!child.killed) {
        child.kill(signal ?? "SIGTERM");
      }
    },
    onMessage(cb: (line: string) => void): void {
      lines.on("line", cb);
    },
    onStderr(cb: (text: string) => void): void {
      child.stderr.on("data", (chunk: string) => cb(chunk));
    },
    onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
      child.on("exit", cb);
    },
    onSpawnError(cb: (error: Error) => void): void {
      child.on("error", cb);
    },
  };
};

export type CreateSttWorkerClientDeps = {
  repoRoot: string;
  workerPath: string;
  log?: (message: string) => void;
  transportFactory?: WorkerTransportFactory;
};

/**
 * Builds a real `SttWorkerClient`: resolves the Python interpreter the same way
 * `transcribeWithPython` does (`DICTEX_PYTHON` > repo `.venv` > platform
 * default) and spawns `worker.py` with the config carried in env vars, matching
 * the one-shot sidecar's env shape so warm and cold paths stay consistent.
 */
export function createSttWorkerClient(
  config: ResolvedWorkerConfig,
  deps: CreateSttWorkerClientDeps,
): SttWorkerClient {
  const factory = deps.transportFactory ?? createRealTransport;
  const python = getPythonInvocation(deps.repoRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    PYTHONIOENCODING: "utf-8",
    DICTEX_STT_PROVIDER: config.provider,
    DICTEX_STT_MODEL: config.model,
    DICTEX_STT_LANGUAGE: config.language,
    DICTEX_STT_DEVICE: config.device,
    DICTEX_STT_COMPUTE_TYPE: config.computeType,
  };
  // The prompt-variant *name* travels per request (worker.py resolves it against
  // the inherited DICTEX_STT_PROMPT_VARIANTS table), never as spawn env, so the
  // no-prompt dictation path keeps the worker's env byte-identical to a plain run.
  const transport = factory({
    command: python.command,
    args: [...python.argsPrefix, deps.workerPath],
    cwd: deps.repoRoot,
    env,
  });
  return new SttWorkerClient(config, transport, deps.log);
}
