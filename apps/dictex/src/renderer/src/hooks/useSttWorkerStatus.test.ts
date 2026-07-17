import { test } from "node:test";
import assert from "node:assert/strict";

import { stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useSttWorkerStatus } from "./useSttWorkerStatus.js";

test("reads the worker status once at mount", async () => {
  const hook = await renderHook(useSttWorkerStatus, {
    api: stubDictexApi({
      getSttWorkerStatus: async () => ({
        state: "ready",
        workerGeneration: "gen-1",
        workerStartupMs: 400,
        modelLoadMs: 300,
        lastInferenceDurationMs: null,
      }),
      onSttWorkerStatus: () => () => {},
    }),
  });

  assert.equal(hook.current?.state, "ready");
  assert.equal(hook.current?.workerGeneration, "gen-1");

  await hook.unmount();
});

test("a push notification updates the status live", async () => {
  let push!: (status: unknown) => void;
  const hook = await renderHook(useSttWorkerStatus, {
    api: stubDictexApi({
      onSttWorkerStatus: (callback) => {
        push = callback as (status: unknown) => void;
        return () => {};
      },
    }),
  });

  assert.equal(hook.current === null, true);

  await flush(() =>
    push({
      state: "restarting",
      workerGeneration: "gen-2",
      workerStartupMs: null,
      modelLoadMs: null,
      lastInferenceDurationMs: null,
    }),
  );

  assert.equal(hook.current?.state, "restarting");

  await hook.unmount();
});

test("unsubscribes from the push notification on unmount", async () => {
  let unsubscribed = false;
  const hook = await renderHook(useSttWorkerStatus, {
    api: stubDictexApi({
      onSttWorkerStatus: () => () => {
        unsubscribed = true;
      },
    }),
  });

  await hook.unmount();

  assert.equal(unsubscribed, true);
});
