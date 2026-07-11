import assert from "node:assert/strict";
import { test } from "node:test";

import { SttWorkerManager } from "./sttWorkerManager.js";
import {
  WorkerDiedError,
  WorkerRequestError,
  WorkerStartError,
  type ResolvedWorkerConfig,
  type WorkerClient,
  type WorkerReady,
  type WorkerTranscribeRequest,
  type WorkerTranscription,
} from "./sttWorkerClient.js";

const baseConfig: ResolvedWorkerConfig = {
  provider: "faster-whisper",
  model: "base",
  language: "fr",
  device: "cpu",
  computeType: "int8",
};

const smallConfig: ResolvedWorkerConfig = { ...baseConfig, model: "small" };

const request: WorkerTranscribeRequest = { audioPath: "audio/seg_0001.webm", language: "fr" };

function flush(): Promise<void> {
  // Drains the microtask queue so serialized manager ops (a `.then` chain) run.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cannedResult(config: ResolvedWorkerConfig, req: WorkerTranscribeRequest, id: string): WorkerTranscription {
  return {
    id,
    transcript: `${req.audioPath}|${config.model}`,
    audioPath: req.audioPath,
    audioSize: 4,
    sttEngine: config.provider,
    sttModel: config.model,
    sttLanguage: req.language,
    sttLanguageProbability: 0.9,
    audioDurationSeconds: 1.5,
    inferenceDurationMs: 12,
  };
}

/** A controllable fake worker generation. Tests drive its ready/result/crash. */
class FakeWorkerClient implements WorkerClient {
  readonly config: ResolvedWorkerConfig;
  readonly id: string;
  private readonly log: string[];
  private alive = true;
  private resolveReady!: (ready: WorkerReady) => void;
  private rejectReady!: (error: unknown) => void;
  readonly readyPromise: Promise<WorkerReady>;
  readonly transcribeCalls: WorkerTranscribeRequest[] = [];
  shutdownCalls = 0;
  killCalls = 0;
  onTranscribe: ((req: WorkerTranscribeRequest, index: number, self: FakeWorkerClient) => Promise<WorkerTranscription>) | null =
    null;

  constructor(config: ResolvedWorkerConfig, id: string, log: string[]) {
    this.config = config;
    this.id = id;
    this.log = log;
    this.readyPromise = new Promise<WorkerReady>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise.catch(() => {});
  }

  markReady(): void {
    this.resolveReady({
      provider: this.config.provider,
      model: this.config.model,
      device: this.config.device,
      computeType: this.config.computeType,
      language: this.config.language,
      modelLoadMs: 5,
    });
  }

  failReady(error: unknown): void {
    this.alive = false;
    this.rejectReady(error);
  }

  crashOnTranscribe(code = "worker_exited"): void {
    this.onTranscribe = (_req, _index, self) => {
      self.alive = false;
      return Promise.reject(new WorkerDiedError("worker died mid-request", code));
    };
  }

  failRequest(error: WorkerRequestError): void {
    this.onTranscribe = () => Promise.reject(error);
  }

  isAlive(): boolean {
    return this.alive;
  }

  whenReady(): Promise<WorkerReady> {
    return this.readyPromise;
  }

  transcribe(req: WorkerTranscribeRequest): Promise<WorkerTranscription> {
    const index = this.transcribeCalls.length;
    this.transcribeCalls.push(req);
    if (this.onTranscribe) {
      return this.onTranscribe(req, index, this);
    }
    return Promise.resolve(cannedResult(this.config, req, `${this.id}_r${index + 1}`));
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.alive = false;
    this.log.push(`shutdown ${this.id}`);
    return Promise.resolve();
  }

  kill(): void {
    this.killCalls += 1;
    this.alive = false;
    this.log.push(`kill ${this.id}`);
  }
}

type Fleet = {
  created: FakeWorkerClient[];
  log: string[];
  factory: (config: ResolvedWorkerConfig) => FakeWorkerClient;
};

function makeFleet(options: { autoReady?: boolean } = {}): Fleet {
  const autoReady = options.autoReady ?? true;
  const created: FakeWorkerClient[] = [];
  const log: string[] = [];
  const factory = (config: ResolvedWorkerConfig): FakeWorkerClient => {
    const client = new FakeWorkerClient(config, `gen${created.length + 1}`, log);
    created.push(client);
    log.push(`create ${client.id} ${config.model}`);
    if (autoReady) {
      client.markReady();
    }
    return client;
  };
  return { created, log, factory };
}

test("two dictations with the same config reuse one generation and load once", async () => {
  const fleet = makeFleet();
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  const first = await manager.transcribe(baseConfig, request);
  const second = await manager.transcribe(baseConfig, request);

  assert.equal(fleet.created.length, 1);
  assert.equal(fleet.created[0].transcribeCalls.length, 2);
  assert.equal(first.sttModel, "base");
  assert.equal(second.sttModel, "base");
  assert.equal(manager.getState(), "ready");
});

test("ready generations and hot requests expose separate, stable measurements", async () => {
  const fleet = makeFleet();
  const readyEvents: { workerGeneration: string; workerStartupMs: number; modelLoadMs: number }[] = [];
  const statuses: string[] = [];
  let generation = 0;
  const manager = new SttWorkerManager({
    createClient: fleet.factory,
    now: () => 100,
    createGenerationId: () => `generation_${++generation}`,
    onGenerationReady: ({ workerGeneration, workerStartupMs, modelLoadMs }) => {
      readyEvents.push({ workerGeneration, workerStartupMs, modelLoadMs });
    },
    onStatusChange: (status) => statuses.push(status.state),
  });

  const first = await manager.transcribe(baseConfig, request);
  const second = await manager.transcribe(baseConfig, request);
  const afterModelChange = await manager.transcribe(smallConfig, request);

  assert.equal(first.workerGeneration, "generation_1");
  assert.equal(second.workerGeneration, "generation_1");
  assert.equal(second.readyWaitMs, 0, "an established ready generation has no readiness wait");
  assert.equal(afterModelChange.workerGeneration, "generation_2");
  assert.deepEqual(
    readyEvents,
    [
      { workerGeneration: "generation_1", workerStartupMs: 0, modelLoadMs: 5 },
      { workerGeneration: "generation_2", workerStartupMs: 0, modelLoadMs: 5 },
    ],
  );
  assert.ok(statuses.includes("starting"));
  assert.ok(statuses.includes("busy"));
  assert.ok(statuses.includes("ready"));
  assert.ok(statuses.includes("restarting"));
});

test("a dictation finishing during prewarm waits for ready then succeeds once", async () => {
  const fleet = makeFleet({ autoReady: false });
  let clock = 0;
  const manager = new SttWorkerManager({ createClient: fleet.factory, now: () => clock });

  manager.prewarm(baseConfig);
  const pending = manager.transcribe(baseConfig, request);
  await flush();

  // The worker is still warming up; the queued dictation has not run yet.
  assert.equal(fleet.created.length, 1);
  assert.equal(manager.getState(), "starting");
  assert.equal(fleet.created[0].transcribeCalls.length, 0);

  clock = 25;
  fleet.created[0].markReady();
  const result = await pending;

  assert.equal(result.transcript, "audio/seg_0001.webm|base");
  assert.equal(fleet.created.length, 1, "model loaded exactly once");
  assert.equal(fleet.created[0].transcribeCalls.length, 1);
  assert.equal(result.readyWaitMs, 25, "the completed audio waited for the prewarming generation");
});

test("changing the model replaces the worker with no overlap of active generations", async () => {
  const fleet = makeFleet();
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  await manager.transcribe(baseConfig, request);
  const result = await manager.transcribe(smallConfig, request);

  assert.equal(fleet.created.length, 2);
  assert.equal(fleet.created[0].shutdownCalls, 1);
  assert.equal(result.sttModel, "small");
  // The old generation is shut down BEFORE the new one is constructed.
  assert.deepEqual(fleet.log, ["create gen1 base", "shutdown gen1", "create gen2 small"]);
});

test("a mid-request crash restarts once and replays once without duplicating work", async () => {
  const fleet = makeFleet();
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  // Warm gen1 first so the crash happens on an established generation.
  await manager.transcribe(baseConfig, request);
  fleet.created[0].crashOnTranscribe();

  const result = await manager.transcribe(baseConfig, request);

  assert.equal(fleet.created.length, 2, "exactly one restart");
  assert.equal(fleet.created[0].transcribeCalls.length, 2, "gen1 got the first attempt");
  assert.equal(fleet.created[1].transcribeCalls.length, 1, "gen2 got exactly one replay");
  assert.equal(result.transcript, "audio/seg_0001.webm|base");
});

test("a second crash surfaces the error instead of restarting again", async () => {
  const fleet = makeFleet();
  // Every generation crashes on its transcribe: the first attempt and the single
  // replay both die, so the failure must be surfaced, not retried a third time.
  const manager = new SttWorkerManager({
    createClient: (config) => {
      const client = fleet.factory(config);
      client.crashOnTranscribe();
      return client;
    },
  });

  await assert.rejects(() => manager.transcribe(baseConfig, request), WorkerDiedError);
  assert.equal(fleet.created.length, 2, "one restart, then the failure is final");
});

test("a recoverable per-request error is surfaced without restarting the worker", async () => {
  const fleet = makeFleet();
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  await manager.transcribe(baseConfig, request);
  fleet.created[0].failRequest(new WorkerRequestError("audio not found", "audio_not_found"));

  await assert.rejects(() => manager.transcribe(baseConfig, request), WorkerRequestError);
  assert.equal(fleet.created.length, 1, "no restart on a recoverable request error");
  assert.equal(fleet.created[0].isAlive(), true);
});

test("a failed start surfaces and a later dictation can still start a fresh worker", async () => {
  const fleet = makeFleet({ autoReady: false });
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  const failing = manager.transcribe(baseConfig, request);
  await flush();
  fleet.created[0].failReady(new WorkerStartError("model load failed", "model_load_failed"));
  await assert.rejects(() => failing, WorkerStartError);

  const retry = manager.transcribe(baseConfig, request);
  await flush();
  assert.equal(fleet.created.length, 2, "a fresh generation is started after a failed one");
  fleet.created[1].markReady();
  const result = await retry;
  assert.equal(result.sttModel, "base");
});

test("a failed ready-event publication stops the loaded worker before retrying", async () => {
  const fleet = makeFleet();
  let publicationAttempts = 0;
  const manager = new SttWorkerManager({
    createClient: fleet.factory,
    onGenerationReady: () => {
      publicationAttempts += 1;
      if (publicationAttempts === 1) {
        return Promise.reject(new Error("event append failed"));
      }
    },
  });

  await assert.rejects(() => manager.transcribe(baseConfig, request), /event append failed/);
  assert.equal(fleet.created[0].shutdownCalls, 1, "the loaded worker is stopped after publication fails");
  assert.equal(fleet.created.filter((client) => client.isAlive()).length, 0, "no untracked generation remains alive");

  const result = await manager.transcribe(baseConfig, request);

  assert.equal(result.sttModel, "base");
  assert.equal(fleet.created.length, 2, "retry starts exactly one fresh generation");
  assert.equal(fleet.created.filter((client) => client.isAlive()).length, 1, "at most one generation remains alive");
  assert.deepEqual(fleet.log, ["create gen1 base", "shutdown gen1", "create gen2 base"]);
});

test("dispose shuts down the current worker and blocks further starts", async () => {
  const fleet = makeFleet();
  const manager = new SttWorkerManager({ createClient: fleet.factory });

  await manager.transcribe(baseConfig, request);
  await manager.dispose();

  assert.equal(fleet.created[0].shutdownCalls, 1);
  assert.equal(manager.getState(), "stopped");
  await assert.rejects(() => manager.transcribe(baseConfig, request), WorkerStartError);
});
