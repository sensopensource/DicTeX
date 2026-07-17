import { test } from "node:test";
import assert from "node:assert/strict";

import { stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useNormalizerSetting } from "./useNormalizerSetting.js";

test("starts unknown (null) until the persisted setting is read", async () => {
  const hook = await renderHook(useNormalizerSetting, {
    api: stubDictexApi({ getNormalizerEnabled: async () => true }),
    onNotice: () => {},
  });

  assert.equal(hook.current.normalizerEnabled, true);

  await hook.unmount();
});

test("a failed read reports a notice and leaves the setting null", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useNormalizerSetting, {
    api: stubDictexApi({
      getNormalizerEnabled: async () => {
        throw new Error("boom");
      },
    }),
    onNotice: (message) => notices.push(message),
  });

  assert.equal(hook.current.normalizerEnabled, null);
  assert.deepEqual(notices, ["Could not read normalizer setting"]);

  await hook.unmount();
});

test("toggling off reports the disabled-path notice", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useNormalizerSetting, {
    api: stubDictexApi({
      getNormalizerEnabled: async () => true,
      setNormalizerEnabled: async (enabled: boolean) => enabled,
    }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.changeNormalizerEnabled(false));

  assert.equal(hook.current.normalizerEnabled, false);
  assert.equal(hook.current.isSettingNormalizer, false);
  assert.deepEqual(notices, [
    "",
    "Normalizer disabled (raw STT and literal command words apply to the next dictation)",
  ]);

  await hook.unmount();
});
