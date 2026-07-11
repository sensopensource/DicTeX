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

export type SttWorkerManagerDeps = {
  /** Builds a worker client for a config. Injected so tests use a fake worker. */
  createClient: (config: ResolvedWorkerConfig) => WorkerClient;
  log?: (message: string) => void;
  /** Bound on the graceful stop before a generation is force-killed. */
  shutdownTimeoutMs?: number;
};

export class SttWorkerManager {
  private readonly createClient: (config: ResolvedWorkerConfig) => WorkerClient;
  private readonly log: (message: string) => void;
  private readonly shutdownTimeoutMs: number;

  private client: WorkerClient | null = null;
  private clientConfig: ResolvedWorkerConfig | null = null;
  private state: WorkerLifecycleState = "stopped";
  private opChain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(deps: SttWorkerManagerDeps) {
    this.createClient = deps.createClient;
    this.log = deps.log ?? (() => {});
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 4000;
  }

  getState(): WorkerLifecycleState {
    return this.state;
  }

  /**
   * Start warming a worker for `config` in the background. Never rejects to the
   * caller: a failed prewarm just leaves the manager idle, and the next
   * dictation retries the start. Call it after the window is created so warm-up
   * never blocks startup.
   */
  prewarm(config: ResolvedWorkerConfig): void {
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
  transcribe(config: ResolvedWorkerConfig, request: WorkerTranscribeRequest): Promise<WorkerTranscription> {
    return this.run(() => this.transcribeWithRecovery(config, request));
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
    this.state = "stopped";
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
  ): Promise<WorkerTranscription> {
    await this.ensureGeneration(config);
    try {
      return await this.runTranscribe(request);
    } catch (error) {
      if (!(error instanceof WorkerDiedError)) {
        // A recoverable per-request error: the worker is still alive, so this is
        // not the "unexpected worker exit" case. Surface it; do not restart.
        throw error;
      }
      this.log(`[stt-worker] worker died during request (${error.code}); restarting once and replaying.`);
      this.state = "restarting";
      await this.dropClient();
      // Restart once. A load failure here is the second failure: surface it.
      await this.ensureGeneration(config);
      // Replay once from the same stored audio. Any failure is final.
      return await this.runTranscribe(request);
    }
  }

  private async runTranscribe(request: WorkerTranscribeRequest): Promise<WorkerTranscription> {
    if (!this.client) {
      throw new WorkerDiedError("No STT worker available.", "worker_dead");
    }
    const client = this.client;
    this.state = "busy";
    try {
      const result = await client.transcribe(request);
      this.state = "ready";
      return result;
    } catch (error) {
      this.state = client.isAlive() ? "ready" : "error";
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
      this.state = "ready";
      return;
    }

    if (this.client) {
      this.state = "restarting";
      await this.stopCurrent();
    }

    this.state = "starting";
    const client = this.createClient(config);
    this.client = client;
    this.clientConfig = config;
    try {
      const ready = await client.whenReady();
      this.state = "ready";
      this.log(
        `[stt-worker] ready: ${ready.provider}/${ready.model} on ${ready.device}/${ready.computeType} ` +
          `(model_load_ms=${ready.modelLoadMs}).`,
      );
    } catch (error) {
      this.state = "error";
      // The generation never came up; drop it so a later attempt starts clean.
      if (this.client === client) {
        this.client = null;
        this.clientConfig = null;
      }
      throw error;
    }
  }

  /** Stop and await the exit of the current generation, then clear it. */
  private async stopCurrent(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientConfig = null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
