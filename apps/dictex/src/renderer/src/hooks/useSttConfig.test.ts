import { test } from "node:test";
import assert from "node:assert/strict";

import { stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useSttConfig } from "./useSttConfig.js";

function baseConfig() {
  return { engine: "faster-whisper", model: "base", language: "fr", device: "cpu", computeType: "int8" };
}

test("reads the active config and model catalog on mount", async () => {
  const hook = await renderHook(useSttConfig, {
    api: stubDictexApi({
      getSttConfig: async () => baseConfig(),
      getSttModels: async () => ["tiny", "base", "small"],
    }),
    onNotice: () => {},
  });

  assert.deepEqual(hook.current.sttConfig, baseConfig());
  assert.deepEqual(hook.current.availableSttModels, ["tiny", "base", "small"]);

  await hook.unmount();
});

test("a failed config read reports a notice instead of throwing", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useSttConfig, {
    api: stubDictexApi({
      getSttConfig: async () => {
        throw new Error("boom");
      },
    }),
    onNotice: (message) => notices.push(message),
  });

  assert.equal(hook.current.sttConfig, null);
  assert.deepEqual(notices, ["Could not read STT config"]);

  await hook.unmount();
});

test("changing the model updates the config and reports success", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useSttConfig, {
    api: stubDictexApi({
      getSttConfig: async () => baseConfig(),
      setSttModel: async (model: string) => ({ ...baseConfig(), model }),
    }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.changeSttModel("small"));

  assert.equal(hook.current.sttConfig?.model, "small");
  assert.equal(hook.current.isSettingSttModel, false);
  assert.deepEqual(notices, ["", "STT model set to small (applies to next dictation)"]);

  await hook.unmount();
});

test("a rejected model change reports the error and leaves isSettingSttModel false", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useSttConfig, {
    api: stubDictexApi({
      getSttConfig: async () => baseConfig(),
      setSttModel: async () => {
        throw new Error("worker busy");
      },
    }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.changeSttModel("small"));

  assert.equal(hook.current.isSettingSttModel, false);
  assert.deepEqual(notices, ["", "worker busy"]);

  await hook.unmount();
});

test("changing the model without the preload API reports a restart notice", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useSttConfig, {
    api: stubDictexApi({ getSttConfig: async () => baseConfig() }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.changeSttModel("small"));

  assert.deepEqual(notices, ["Restart DicTeX to load the STT model settings API"]);

  await hook.unmount();
});
