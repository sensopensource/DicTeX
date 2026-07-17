import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPreview,
  deriveOverlayView,
  PREVIEW_CHAR_CAP,
  PREVIEW_SUMMARY_CAP,
  type OverlayInput,
} from "./overlayState.js";

const baseInput: OverlayInput = {
  status: "idle",
  workerState: "ready",
  normalizerEnabled: true,
  pasteState: "none",
  recordingStartedAt: null,
  inputLevel: null,
  rawTranscript: "",
  insertedTranscript: "",
  errorMessage: "",
};

function input(overrides: Partial<OverlayInput>): OverlayInput {
  return { ...baseInput, ...overrides };
}

const live = { insertedDismissed: false };

/* ---- Preview cap --------------------------------------------------------- */

test("preview keeps a short transcript whole and unmarked", () => {
  const preview = buildPreview("x au carré plus deux");

  assert.deepEqual(preview, { kind: "text", text: "x au carré plus deux", truncated: false });
});

test("preview reports an empty transcript rather than an empty string", () => {
  assert.deepEqual(buildPreview(""), { kind: "empty" });
  assert.deepEqual(buildPreview("   \n  "), { kind: "empty" });
});

test("preview collapses the newlines a line-break command inserts", () => {
  const preview = buildPreview("premiere ligne\n\nseconde   ligne");

  assert.deepEqual(preview, { kind: "text", text: "premiere ligne seconde ligne", truncated: false });
});

test("preview truncates past the cap and marks it with an ellipsis", () => {
  const text = "mot ".repeat(60).trim();
  const preview = buildPreview(text);

  assert.equal(preview.kind, "text");
  if (preview.kind !== "text") {
    return;
  }
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.endsWith("…"), true);
  assert.ok(preview.text.length <= PREVIEW_CHAR_CAP + 1, `preview was ${preview.text.length} chars`);
  // Cut on a word boundary, so the visible part never ends mid-word.
  assert.equal(preview.text.endsWith("mot…"), true);
});

test("preview hard-cuts a single long token that offers no word boundary", () => {
  const preview = buildPreview("$".concat("\\frac{1}{x}".repeat(30), "$"));

  assert.equal(preview.kind, "text");
  if (preview.kind !== "text") {
    return;
  }
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.length, PREVIEW_CHAR_CAP + 1);
});

test("preview degrades to a character count past the summary cap", () => {
  const text = "a".repeat(PREVIEW_SUMMARY_CAP + 1);
  const preview = buildPreview(text);

  assert.deepEqual(preview, { kind: "summary", characters: PREVIEW_SUMMARY_CAP + 1 });
});

test("preview summary counts the inserted text, not the collapsed preview string", () => {
  // Whitespace collapsing is a preview concern; the count must describe what
  // actually reached the notebook. Padded so the COLLAPSED length still clears
  // the summary cap, while the raw length is far larger.
  const text = "mot   ".repeat(100);
  const preview = buildPreview(text);

  assert.equal(preview.kind, "summary");
  if (preview.kind !== "summary") {
    return;
  }
  assert.equal(preview.characters, text.length);
});

test("preview counts code points so accents are not double counted", () => {
  const text = `é${"e".repeat(PREVIEW_SUMMARY_CAP)}`;
  const preview = buildPreview(text);

  assert.deepEqual(preview, { kind: "summary", characters: PREVIEW_SUMMARY_CAP + 1 });
});

/* ---- Phase machine ------------------------------------------------------- */

test("a ready worker at rest shows the ready pill", () => {
  assert.deepEqual(deriveOverlayView(input({ workerState: "ready" }), live), { phase: "ready" });
  assert.deepEqual(deriveOverlayView(input({ workerState: "busy" }), live), { phase: "ready" });
});

test("a starting or restarting worker at rest reads as warming up", () => {
  assert.deepEqual(deriveOverlayView(input({ workerState: "starting" }), live), { phase: "warming" });
  assert.deepEqual(deriveOverlayView(input({ workerState: "restarting" }), live), { phase: "warming" });
  assert.deepEqual(deriveOverlayView(input({ workerState: "stopped" }), live), { phase: "warming" });
});

test("an unknown worker state reads as warming rather than ready", () => {
  // Before the first status notification the engine is not usable yet; claiming
  // "ready" would promise a warm model that may still be loading.
  assert.deepEqual(deriveOverlayView(input({ workerState: null }), live), { phase: "warming" });
});

test("a worker error at rest is an error without the audio-kept reassurance", () => {
  assert.deepEqual(deriveOverlayView(input({ workerState: "error" }), live), {
    phase: "error",
    message: "STT engine unavailable",
    audioKept: false,
  });
});

test("recording exposes the start timestamp and a clamped level", () => {
  assert.deepEqual(
    deriveOverlayView(input({ status: "recording", recordingStartedAt: 1000, inputLevel: 0.4 }), live),
    { phase: "recording", startedAt: 1000, level: 0.4 },
  );
});

test("recording clamps an out-of-range or missing level to a drawable number", () => {
  const above = deriveOverlayView(input({ status: "recording", recordingStartedAt: 1, inputLevel: 4 }), live);
  const below = deriveOverlayView(input({ status: "recording", recordingStartedAt: 1, inputLevel: -2 }), live);
  const missing = deriveOverlayView(input({ status: "recording", recordingStartedAt: 1, inputLevel: null }), live);
  const broken = deriveOverlayView(input({ status: "recording", recordingStartedAt: 1, inputLevel: Number.NaN }), live);

  assert.deepEqual(above, { phase: "recording", startedAt: 1, level: 1 });
  assert.deepEqual(below, { phase: "recording", startedAt: 1, level: 0 });
  // The VU tap is optional: without it the HUD still shows the chronometer.
  assert.deepEqual(missing, { phase: "recording", startedAt: 1, level: 0 });
  assert.deepEqual(broken, { phase: "recording", startedAt: 1, level: 0 });
});

test("recording wins over a worker that is still warming", () => {
  // The microphone is live; that is the truth worth showing, and dictation is
  // designed to wait for the worker rather than lose the audio.
  const view = deriveOverlayView(
    input({ status: "recording", recordingStartedAt: 5, workerState: "starting" }),
    live,
  );

  assert.equal(view.phase, "recording");
});

test("transcribing is its own phase", () => {
  assert.deepEqual(deriveOverlayView(input({ status: "transcribing" }), live), { phase: "transcribing" });
});

test("a dictation error keeps the audio-kept reassurance and Home's message", () => {
  assert.deepEqual(deriveOverlayView(input({ status: "error", errorMessage: "Transcription failed" }), live), {
    phase: "error",
    message: "Transcription failed",
    audioKept: true,
  });
});

test("a dictation error without a message still says something", () => {
  const view = deriveOverlayView(input({ status: "error", errorMessage: "" }), live);

  assert.deepEqual(view, { phase: "error", message: "Dictation failed", audioKept: true });
});

/* ---- Inserted ------------------------------------------------------------ */

test("a pasted dictation shows both variants and offers the toggle", () => {
  const view = deriveOverlayView(
    input({
      status: "done",
      pasteState: "pasted",
      rawTranscript: "x au carré",
      insertedTranscript: "$x^{2}$",
    }),
    live,
  );

  assert.deepEqual(view, {
    phase: "inserted",
    raw: { kind: "text", text: "x au carré", truncated: false },
    normalized: { kind: "text", text: "$x^{2}$", truncated: false },
    hasNormalized: true,
    normalizerEnabled: true,
    paste: "pasted",
  });
});

test("a clipboard-only dictation reports clipboard-only", () => {
  const view = deriveOverlayView(
    input({ status: "done", pasteState: "clipboard-only", rawTranscript: "a", insertedTranscript: "a" }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  assert.equal(view.paste, "clipboard-only");
});

test("a dictation with no paste attempt reads as clipboard-only, never as pasted", () => {
  // The manual button copies without pasting; the toast must not claim an insert
  // that never happened.
  const view = deriveOverlayView(
    input({ status: "done", pasteState: "none", rawTranscript: "a", insertedTranscript: "a" }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  assert.equal(view.paste, "clipboard-only");
});

test("the normalizer being off leaves nothing to toggle", () => {
  const view = deriveOverlayView(
    input({
      status: "done",
      normalizerEnabled: false,
      pasteState: "pasted",
      rawTranscript: "x au carré",
      insertedTranscript: "x au carré",
    }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  assert.equal(view.hasNormalized, false);
  assert.equal(view.normalizerEnabled, false);
});

test("a pipeline that changed nothing leaves nothing to toggle", () => {
  const view = deriveOverlayView(
    input({
      status: "done",
      normalizerEnabled: true,
      rawTranscript: "il reste trois exemples",
      insertedTranscript: "il reste trois exemples",
    }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  assert.equal(view.hasNormalized, false);
});

test("an unread normalizer setting does not claim the normalizer is off", () => {
  const view = deriveOverlayView(
    input({ status: "done", normalizerEnabled: null, rawTranscript: "a", insertedTranscript: "b" }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  // Settings written before #105 default to enabled; the HUD follows that.
  assert.equal(view.normalizerEnabled, true);
  assert.equal(view.hasNormalized, true);
});

test("a long dictation degrades both variants independently", () => {
  const view = deriveOverlayView(
    input({
      status: "done",
      rawTranscript: "a".repeat(PREVIEW_SUMMARY_CAP + 1),
      insertedTranscript: "court",
    }),
    live,
  );

  assert.equal(view.phase, "inserted");
  if (view.phase !== "inserted") {
    return;
  }
  assert.deepEqual(view.raw, { kind: "summary", characters: PREVIEW_SUMMARY_CAP + 1 });
  assert.deepEqual(view.normalized, { kind: "text", text: "court", truncated: false });
});

test("the inserted card gives way to the resting phase once dismissed", () => {
  const done = input({ status: "done", pasteState: "pasted", rawTranscript: "a", insertedTranscript: "b" });

  // Home's status stays "done" until the next dictation, so the dismissal is
  // what lets the HUD fade back to its pill after the paste.
  assert.deepEqual(deriveOverlayView({ ...done, workerState: "ready" }, { insertedDismissed: true }), {
    phase: "ready",
  });
  assert.deepEqual(deriveOverlayView({ ...done, workerState: "restarting" }, { insertedDismissed: true }), {
    phase: "warming",
  });
});

test("dismissing the inserted card never suppresses a later error", () => {
  const view = deriveOverlayView(
    input({ status: "error", errorMessage: "boom" }),
    { insertedDismissed: true },
  );

  assert.deepEqual(view, { phase: "error", message: "boom", audioKept: true });
});
