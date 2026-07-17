import assert from "node:assert/strict";
import test from "node:test";
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
