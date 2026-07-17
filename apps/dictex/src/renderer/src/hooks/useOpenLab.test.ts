import { test } from "node:test";
import assert from "node:assert/strict";

import { stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useOpenLab } from "./useOpenLab.js";

test("a successful launch reports the opening notice", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useOpenLab, {
    api: stubDictexApi({ openLab: async () => ({ ok: true }) }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.openLab());

  assert.equal(hook.current.isOpeningLab, false);
  assert.deepEqual(notices, ["", "Opening DicTeX Lab…"]);

  await hook.unmount();
});

test("a reported failure surfaces its own error message", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useOpenLab, {
    api: stubDictexApi({ openLab: async () => ({ ok: false, error: "Lab build not found" }) }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.openLab());

  assert.deepEqual(notices, ["", "Lab build not found"]);

  await hook.unmount();
});

test("a rejected launch reports the thrown error", async () => {
  const notices: string[] = [];
  const hook = await renderHook(useOpenLab, {
    api: stubDictexApi({
      openLab: async () => {
        throw new Error("IPC channel closed");
      },
    }),
    onNotice: (message) => notices.push(message),
  });

  await flush(() => hook.current.openLab());

  assert.deepEqual(notices, ["", "IPC channel closed"]);

  await hook.unmount();
});
