import {
  workerConfigsEqual,
  WorkerDiedError,
  WorkerStartError,
  type ResolvedWorkerConfig,
  type WorkerClient,
  type WorkerTranscribeRequest,
  type WorkerTranscription,
} from "./sttWorkerClient.js";

/**
 * Owns the lifecycle of the persistent STT worker for DicTeX dictation: exactly
 * one worker process and one loaded model at a time, an async prewarm, a lazy
 * restart when the requested model changes, bounded crash recovery, and a
 * bounded shutdown. The Lab's one-shot `transcribeWithPython` path is untouched;
 * this is DicTeX-only.
 *
 * All operations are serialized through a single internal chain, so no two
 * generations are ever live at once: a model change stops the old generation
 * fully before starting the new one, and a transcription started during prewarm
 * simply waits for the warm-up to finish rather than racing it.
 *
 * The explicit lifecycle states (`starting`/`ready`/`busy`/`restarting`/
 * `error`/`stopped`) are tracked here; surfacing them in the UI is the next
 * ticket's job (out of scope for #115).
 */
export type WorkerLifecycleState =
  | "starting"
  | "ready"
  | "busy"
  | "restarting"
  | "error"
  | "stopped";

export type SttWorkerStatus = {
  state: WorkerLifecycleState;
  workerGeneration: string | null;
  workerStartupMs: number | null;
  modelLoadMs: number | null;
  lastInferenceDurationMs: number | null;
};

export type SttWorkerGenerationReady = {
  workerGeneration: string;
  sttEngine: string;
  sttModel: string;
  sttDevice: string;
  sttComputeType: string;
  workerStartupMs: number;
  modelLoadMs: number;
};

export type ManagedWorkerTranscription = WorkerTranscription & {
  workerGeneration: string;
  readyWaitMs: number;
};

export type SttWorkerManagerDeps = {
  /** Builds a worker client for a config. Injected so tests use a fake worker. */
  createClient: (config: ResolvedWorkerConfig) => WorkerClient;
  log?: (message: string) => void;
  now?: () => number;
  createGenerationId?: () => string;
  onStatusChange?: (status: SttWorkerStatus) => void;
  onGenerationReady?: (generation: SttWorkerGenerationReady) => void | Promise<void>;
  /** Bound on the graceful stop before a generation is force-killed. */
  shutdownTimeoutMs?: number;
};

export class SttWorkerManager {
  private readonly createClient: (config: ResolvedWorkerConfig) => WorkerClient;
  private readonly log: (message: string) => void;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => number;
  private readonly createGenerationId: () => string;
  private readonly onStatusChange: (status: SttWorkerStatus) => void;
  private readonly onGenerationReady: (generation: SttWorkerGenerationReady) => void | Promise<void>;

  private client: WorkerClient | null = null;
  private clientConfig: ResolvedWorkerConfig | null = null;
  private state: WorkerLifecycleState = "stopped";
  private opChain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private workerGeneration: string | null = null;
  private workerStartupMs: number | null = null;
  private modelLoadMs: number | null = null;
  private lastInferenceDurationMs: number | null = null;
  private generationCounter = 0;

  constructor(deps: SttWorkerManagerDeps) {
    this.createClient = deps.createClient;
    this.log = deps.log ?? (() => {});
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 4000;
    this.now = deps.now ?? (() => Date.now());
    this.createGenerationId = deps.createGenerationId ?? (() => `generation_${Date.now().toString(36)}_${++this.generationCounter}`);
    this.onStatusChange = deps.onStatusChange ?? (() => {});
    this.onGenerationReady = deps.onGenerationReady ?? (() => {});
  }

  getState(): WorkerLifecycleState {
    return this.state;
  }

  getStatus(): SttWorkerStatus {
    return {
      state: this.state,
      workerGeneration: this.workerGeneration,
      workerStartupMs: this.workerStartupMs,
      modelLoadMs: this.modelLoadMs,
      lastInferenceDurationMs: this.lastInferenceDurationMs,
    };
  }

  /**
   * Start warming a worker for `config` in the background. Never rejects to the
   * caller: a failed prewarm just leaves the manager idle, and the next
   * dictation retries the start. Call it after the window is created so warm-up
   * never blocks startup.
   */
  prewarm(config: ResolvedWorkerConfig): void {
    // Publish preparation synchronously: a renderer or a recording that starts
    // immediately after startup must observe that this generation is warming.
    if (this.state === "stopped") {
      this.setState("starting");
    }
    void this.run(() => this.ensureGeneration(config)).catch((error) => {
      this.log(`[stt-worker] prewarm failed: ${errorMessage(error)}`);
    });
  }

  /**
   * Transcribe one already-stored audio file, ensuring a worker for `config` is
   * ready first. On a mid-request worker crash, restart once and replay once
   * from the same audio file; a second failure is surfaced so the caller can
   * keep the audio and its `audio_segment` for manual retry. A recoverable
   * per-request error (never a crash) is surfaced directly, worker still alive.
   */
  transcribe(config: ResolvedWorkerConfig, request: WorkerTranscribeRequest): Promise<ManagedWorkerTranscription> {
    const submittedAt = this.now();
    const waitingForExistingWarmup = this.state === "starting" || this.state === "restarting";
    return this.run(() => this.transcribeWithRecovery(config, request, waitingForExistingWarmup ? submittedAt : null));
  }

  /**
   * Ask the current worker to stop and force-kill it after the bounded timeout.
   * Not serialized through the op chain: shutdown must be bounded even if a
   * transcription is in flight, and the `disposed` guard stops any in-flight
   * recovery from starting a fresh generation.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    this.client = null;
    this.clientConfig = null;
    this.clearGeneration();
    this.setState("stopped");
    if (!client) {
      return;
    }
    try {
      await client.shutdown(this.shutdownTimeoutMs);
    } catch (error) {
      this.log(`[stt-worker] dispose shutdown error: ${errorMessage(error)}`);
      client.kill();
    }
  }

  /** Serialize an operation after all prior ones, without poisoning the chain. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.opChain.then(operation);
    this.opChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async transcribeWithRecovery(
    config: ResolvedWorkerConfig,
    request: WorkerTranscribeRequest,
    initialReadyWaitStartedAt: number | null,
  ): Promise<ManagedWorkerTranscription> {
    let readyWaitMs = await this.ensureReadyWait(config, initialReadyWaitStartedAt);
    try {
      return this.withGeneration(await this.runTranscribe(request), readyWaitMs);
    } catch (error) {
      if (!(error instanceof WorkerDiedError)) {
        // A recoverable per-request error: the worker is still alive, so this is
        // not the "unexpected worker exit" case. Surface it; do not restart.
        throw error;
      }
      this.log(`[stt-worker] worker died during request (${error.code}); restarting once and replaying.`);
      this.setState("restarting");
      await this.dropClient();
      // Restart once. A load failure here is the second failure: surface it.
      readyWaitMs += await this.ensureReadyWait(config);
      // Replay once from the same stored audio. Any failure is final.
      return this.withGeneration(await this.runTranscribe(request), readyWaitMs);
    }
  }

  private async runTranscribe(request: WorkerTranscribeRequest): Promise<WorkerTranscription> {
    if (!this.client) {
      throw new WorkerDiedError("No STT worker available.", "worker_dead");
    }
    const client = this.client;
    this.setState("busy");
    try {
      const result = await client.transcribe(request);
      this.lastInferenceDurationMs = result.inferenceDurationMs;
      this.emitStatus();
      this.setState("ready");
      return result;
    } catch (error) {
      this.setState(client.isAlive() ? "ready" : "error");
      throw error;
    }
  }

  /**
   * Guarantee a ready worker for `config`. Reuse the current generation when it
   * matches and is alive; otherwise stop the old generation completely (so two
   * models never coexist in VRAM) and start a fresh one, waiting for its model
   * to load.
   */
  private async ensureGeneration(config: ResolvedWorkerConfig): Promise<void> {
    if (this.disposed) {
      throw new WorkerStartError("STT worker manager is disposed.", "disposed");
    }

    if (
      this.client &&
      this.clientConfig &&
      this.client.isAlive() &&
      workerConfigsEqual(this.clientConfig, config)
    ) {
      await this.client.whenReady();
      this.setState("ready");
      return;
    }

    if (this.client) {
      this.setState("restarting");
      await this.stopCurrent();
    }

    this.setState("starting");
    const startupStartedAt = this.now();
    const client = this.createClient(config);
    this.client = client;
    this.clientConfig = config;
    try {
      const ready = await client.whenReady();
      const workerStartupMs = elapsedMs(this.now(), startupStartedAt);
      const generation = this.createGenerationId();
      this.workerGeneration = generation;
      this.workerStartupMs = workerStartupMs;
      this.modelLoadMs = nonNegativeMs(ready.modelLoadMs);
      this.lastInferenceDurationMs = null;
      await this.onGenerationReady({
        workerGeneration: generation,
        sttEngine: ready.provider,
        sttModel: ready.model,
        sttDevice: ready.device,
        sttComputeType: ready.computeType,
        workerStartupMs,
        modelLoadMs: this.modelLoadMs,
      });
      this.setState("ready");
      this.log(
        `[stt-worker] ready: ${ready.provider}/${ready.model} on ${ready.device}/${ready.computeType} ` +
          `(model_load_ms=${ready.modelLoadMs}).`,
      );
    } catch (error) {
      // Readiness is only accepted after its event is published. If startup or
      // publication fails, stop the local client before releasing its reference
      // so a retry can never overlap a loaded but untracked generation.
      if (this.client === client) {
        await this.stopClient(client);
        this.client = null;
        this.clientConfig = null;
        this.clearGeneration();
      }
      if (!this.disposed) {
        this.setState("error");
      }
      throw error;
    }
  }

  private async ensureReadyWait(config: ResolvedWorkerConfig, waitStartedAt: number | null = null): Promise<number> {
    const alreadyReady =
      this.state === "ready" &&
      this.client !== null &&
      this.clientConfig !== null &&
      this.client.isAlive() &&
      workerConfigsEqual(this.clientConfig, config);
    if (alreadyReady) {
      return waitStartedAt === null ? 0 : elapsedMs(this.now(), waitStartedAt);
    }
    const startedAt = waitStartedAt ?? this.now();
    await this.ensureGeneration(config);
    return elapsedMs(this.now(), startedAt);
  }

  private withGeneration(result: WorkerTranscription, readyWaitMs: number): ManagedWorkerTranscription {
    if (!this.workerGeneration) {
      throw new WorkerDiedError("STT worker generation is unavailable.", "generation_unavailable");
    }
    return { ...result, workerGeneration: this.workerGeneration, readyWaitMs };
  }

  private clearGeneration(): void {
    this.workerGeneration = null;
    this.workerStartupMs = null;
    this.modelLoadMs = null;
    this.lastInferenceDurationMs = null;
  }

  private setState(state: WorkerLifecycleState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatusChange(this.getStatus());
  }

  /** Stop and await the exit of the current generation, then clear it. */
  private async stopCurrent(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientConfig = null;
    this.clearGeneration();
    if (!client) {
      return;
    }
    try {
      await client.shutdown(this.shutdownTimeoutMs);
    } catch (error) {
      this.log(`[stt-worker] stop error: ${errorMessage(error)}`);
      client.kill();
    }
  }

  /** Drop a generation that already died mid-request; stop it if still alive. */
  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientConfig = null;
    this.clearGeneration();
    if (client && client.isAlive()) {
      await this.stopClient(client);
    }
  }

  private async stopClient(client: WorkerClient): Promise<void> {
    try {
      await client.shutdown(this.shutdownTimeoutMs);
    } catch (error) {
      this.log(`[stt-worker] stop error: ${errorMessage(error)}`);
      client.kill();
    }
  }
}

function elapsedMs(now: number, startedAt: number): number {
  return nonNegativeMs(now - startedAt);
}

function nonNegativeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
