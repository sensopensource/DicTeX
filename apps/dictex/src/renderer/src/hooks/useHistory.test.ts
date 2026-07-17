import { test } from "node:test";
import assert from "node:assert/strict";

import { segmentFixture, stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useHistory } from "./useHistory.js";

test("loads recent segments on mount", async () => {
  const hook = await renderHook(useHistory, {
    api: stubDictexApi({ getRecentSegments: async () => [segmentFixture()] }),
    onNotice: () => {},
  });

  assert.equal(hook.current.recentSegments.length, 1);
  assert.equal(hook.current.historyError, "");

  await hook.unmount();
});

test("without the preload API it reports a restart notice instead of throwing", async () => {
  const hook = await renderHook(useHistory, {
    api: stubDictexApi({}),
    onNotice: () => {},
  });

  assert.equal(hook.current.historyError, "Restart DicTeX to load the history preload API");
  assert.deepEqual(hook.current.recentSegments, []);

  await hook.unmount();
});

test("a failed load reports the error", async () => {
  const hook = await renderHook(useHistory, {
    api: stubDictexApi({
      getRecentSegments: async () => {
        throw new Error("data folder missing");
      },
    }),
    onNotice: () => {},
  });

  assert.equal(hook.current.historyError, "data folder missing");

  await hook.unmount();
});

test("copying the inserted transcript prefers the normalized text and reports the segment identity", async () => {
  const notices: string[] = [];
  const writes: string[] = [];
  const originalClipboard = (globalThis as { navigator: { clipboard?: unknown } }).navigator.clipboard;
  (globalThis as { navigator: { clipboard: unknown } }).navigator.clipboard = {
    writeText: async (text: string) => {
      writes.push(text);
    },
  };

  const hook = await renderHook(useHistory, {
    api: stubDictexApi({ getRecentSegments: async () => [] }),
    onNotice: (message) => notices.push(message),
  });

  const segment = segmentFixture({ normalizedTranscript: "$x^2$" });
  await flush(() => hook.current.copyHistoryTranscript(segment, "inserted"));

  assert.deepEqual(writes, ["$x^2$"]);
  assert.deepEqual(notices, ["Copied inserted transcript for session_1 / segment_1"]);

  await hook.unmount();
  (globalThis as { navigator: { clipboard: unknown } }).navigator.clipboard = originalClipboard;
});

test("copying the raw transcript always uses the literal STT output", async () => {
  const writes: string[] = [];
  (globalThis as { navigator: { clipboard: unknown } }).navigator.clipboard = {
    writeText: async (text: string) => {
      writes.push(text);
    },
  };

  const hook = await renderHook(useHistory, {
    api: stubDictexApi({ getRecentSegments: async () => [] }),
    onNotice: () => {},
  });

  const segment = segmentFixture({ transcript: "x au carré", normalizedTranscript: "$x^2$" });
  await flush(() => hook.current.copyHistoryTranscript(segment, "raw"));

  assert.deepEqual(writes, ["x au carré"]);

  await hook.unmount();
});
