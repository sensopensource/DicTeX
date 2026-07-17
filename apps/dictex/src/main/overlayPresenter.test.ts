import assert from "node:assert/strict";
import { test } from "node:test";

import { OverlayPresenter, sanitizeHomeOverlayState, type HomeOverlayState } from "./overlayPresenter.js";
import { INSERTED_VISIBLE_MS, type OverlayView } from "./overlayState.js";

type Harness = {
  presenter: OverlayPresenter;
  views: OverlayView[];
  /** Run the pending dismiss timer, if the presenter armed one. */
  runTimer: () => void;
  pendingTimers: () => number;
};

function createHarness(): Harness {
  const views: OverlayView[] = [];
  let nextHandle = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();

  const presenter = new OverlayPresenter({
    emit: (view) => views.push(view),
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    presenter,
    views,
    runTimer: () => {
      const entries = [...timers.entries()];
      assert.equal(entries.length, 1, "expected exactly one armed timer");
      const [handle, timer] = entries[0];
      assert.equal(timer.delayMs, INSERTED_VISIBLE_MS);
      timers.delete(handle);
      timer.callback();
    },
    pendingTimers: () => timers.size,
  };
}

const homeIdle: HomeOverlayState = {
  status: "idle",
  pasteState: "none",
  recordingStartedAt: null,
  inputLevel: null,
  rawTranscript: "",
  insertedTranscript: "",
  errorMessage: "",
};

const homeDone: HomeOverlayState = {
  status: "done",
  pasteState: "pasted",
  recordingStartedAt: null,
  inputLevel: null,
  rawTranscript: "x au carré",
  insertedTranscript: "$x^{2}$",
  errorMessage: "",
};

test("each owner's state survives the other owner's update", () => {
  const { presenter, views } = createHarness();

  presenter.setWorkerState("ready");
  presenter.setNormalizerEnabled(false);
  presenter.updateFromHome(homeDone);

  const view = views.at(-1);
  assert.equal(view?.phase, "inserted");
  if (view?.phase !== "inserted") {
    return;
  }
  // Home's publish must not clear what the main process owns, and vice versa.
  assert.equal(view.normalizerEnabled, false);
  assert.equal(view.paste, "pasted");
});

test("an unchanged view is not re-emitted", () => {
  const { presenter, views } = createHarness();

  presenter.setWorkerState("ready");
  const afterFirst = views.length;

  presenter.setWorkerState("ready");
  presenter.updateFromHome(homeIdle);

  // `busy` and `ready` both render as the ready pill, so it stays one emission.
  presenter.setWorkerState("busy");

  assert.equal(views.length, afterFirst);
});

test("a level that does not change the rendered view stays off the wire", () => {
  const { presenter, views } = createHarness();
  presenter.setWorkerState("ready");
  presenter.updateFromHome({ ...homeIdle, status: "recording", recordingStartedAt: 10, inputLevel: 0.5 });
  const afterRecording = views.length;

  presenter.updateFromHome({ ...homeIdle, status: "recording", recordingStartedAt: 10, inputLevel: 0.5 });

  assert.equal(views.length, afterRecording);
});

test("a changed level is emitted", () => {
  const { presenter, views } = createHarness();
  presenter.setWorkerState("ready");
  presenter.updateFromHome({ ...homeIdle, status: "recording", recordingStartedAt: 10, inputLevel: 0.5 });

  presenter.updateFromHome({ ...homeIdle, status: "recording", recordingStartedAt: 10, inputLevel: 0.9 });

  assert.deepEqual(views.at(-1), { phase: "recording", startedAt: 10, level: 0.9 });
});

test("the inserted card is armed on done and collapses when its timer fires", () => {
  const { presenter, views, runTimer } = createHarness();
  presenter.setWorkerState("ready");

  presenter.updateFromHome(homeDone);
  assert.equal(views.at(-1)?.phase, "inserted");

  runTimer();

  assert.deepEqual(views.at(-1), { phase: "ready" });
});

test("a new recording cancels the pending dismissal and re-opens the next card", () => {
  const { presenter, views, runTimer, pendingTimers } = createHarness();
  presenter.setWorkerState("ready");

  presenter.updateFromHome(homeDone);
  assert.equal(pendingTimers(), 1);

  presenter.updateFromHome({ ...homeIdle, status: "recording", recordingStartedAt: 5 });
  assert.equal(pendingTimers(), 0, "the previous dismissal must not fire during the new dictation");

  // The next dictation gets a full card, not one inherited as already dismissed.
  presenter.updateFromHome({ ...homeDone, insertedTranscript: "$y$" });
  assert.equal(views.at(-1)?.phase, "inserted");

  runTimer();
  assert.deepEqual(views.at(-1), { phase: "ready" });
});

test("a dismissed card reflects the worker state it collapses back into", () => {
  const { presenter, views, runTimer } = createHarness();

  presenter.updateFromHome(homeDone);
  presenter.setWorkerState("restarting");
  runTimer();

  assert.deepEqual(views.at(-1), { phase: "warming" });
});

test("staying on done does not re-arm the timer on every publish", () => {
  const { presenter, pendingTimers } = createHarness();
  presenter.setWorkerState("ready");

  presenter.updateFromHome(homeDone);
  presenter.updateFromHome(homeDone);
  presenter.updateFromHome(homeDone);

  assert.equal(pendingTimers(), 1);
});

test("resend repeats the current view for a freshly loaded window", () => {
  const { presenter, views } = createHarness();
  presenter.setWorkerState("ready");
  const afterFirst = views.length;

  // A new window has no history, so the de-duplication must not silence it.
  presenter.resend();

  assert.equal(views.length, afterFirst + 1);
  assert.deepEqual(views.at(-1), { phase: "ready" });
});

test("dispose cancels a pending dismissal", () => {
  const { presenter, pendingTimers } = createHarness();

  presenter.updateFromHome(homeDone);
  presenter.dispose();

  assert.equal(pendingTimers(), 0);
});

/* ---- IPC boundary -------------------------------------------------------- */

test("a well-formed published state passes through unchanged", () => {
  assert.deepEqual(sanitizeHomeOverlayState({ ...homeDone }), homeDone);
});

test("a payload without a usable status is rejected outright", () => {
  assert.equal(sanitizeHomeOverlayState(null), null);
  assert.equal(sanitizeHomeOverlayState("recording"), null);
  assert.equal(sanitizeHomeOverlayState({}), null);
  assert.equal(sanitizeHomeOverlayState({ ...homeDone, status: "chatting" }), null);
});

test("unusable fields degrade to their empty value rather than throwing", () => {
  const sanitized = sanitizeHomeOverlayState({
    status: "done",
    pasteState: "teleported",
    recordingStartedAt: Number.NaN,
    inputLevel: "loud",
    rawTranscript: 42,
    insertedTranscript: null,
    errorMessage: undefined,
  });

  assert.deepEqual(sanitized, {
    status: "done",
    // An unknown paste outcome must not be read as a successful insert.
    pasteState: "none",
    recordingStartedAt: null,
    inputLevel: null,
    rawTranscript: "",
    insertedTranscript: "",
    errorMessage: "",
  });
});

test("a sanitized payload is safe to derive a view from", () => {
  const { presenter, views } = createHarness();
  const sanitized = sanitizeHomeOverlayState({ status: "error", errorMessage: "boom" });

  assert.notEqual(sanitized, null);
  presenter.updateFromHome(sanitized as HomeOverlayState);

  assert.deepEqual(views.at(-1), { phase: "error", message: "boom", audioKept: true });
});
