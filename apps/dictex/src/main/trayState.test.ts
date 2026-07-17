import assert from "node:assert/strict";
import test from "node:test";
import { persistTrayNormalizerSetting } from "./trayNormalizerSetting.js";
import { deriveTrayState } from "./trayState.js";

test("tray reflects recording from the dictation owner", () => {
  assert.equal(deriveTrayState({ dictationStatus: "recording", workerState: "ready" }), "recording");
});

test("tray reflects errors from either existing state owner", () => {
  assert.equal(deriveTrayState({ dictationStatus: "error", workerState: "ready" }), "error");
  assert.equal(deriveTrayState({ dictationStatus: "idle", workerState: "error" }), "error");
});

test("tray is ready for non-recording non-error states", () => {
  assert.equal(deriveTrayState({ dictationStatus: "transcribing", workerState: "busy" }), "ready");
});

test("tray restores the visible normalizer state after persistence fails and retries coherently", async () => {
  let activeEnabled = true;
  let visibleChecked = true;
  let shouldFail = true;
  const attemptedValues: boolean[] = [];

  const setFromTray = async () => {
    return persistTrayNormalizerSetting({
      currentEnabled: activeEnabled,
      nextEnabled: !activeEnabled,
      persist: async (nextEnabled) => {
        attemptedValues.push(nextEnabled);
        if (shouldFail) {
          throw new Error("settings unavailable");
        }
      },
      synchronize: (nextEnabled) => {
        activeEnabled = nextEnabled;
        visibleChecked = nextEnabled;
      },
    });
  };

  await assert.rejects(setFromTray(), /settings unavailable/);
  assert.equal(activeEnabled, true);
  assert.equal(visibleChecked, true);

  shouldFail = false;
  assert.equal(await setFromTray(), false);
  assert.equal(activeEnabled, false);
  assert.equal(visibleChecked, false);
  assert.deepEqual(attemptedValues, [false, false]);
});
