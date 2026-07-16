import { test, mock } from "node:test";
import assert from "node:assert/strict";

import type { ReconstructedSegment } from "@dictex/shared";
import { LAYER2_PREFILL_DEBOUNCE_MS, useDatasetBuilder } from "./useDatasetBuilder.js";
import { segmentFixture, stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import type { LabApi } from "../api.js";
import type { DatasetBuilderSaveRequest } from "../../../main/datasetBuilder.js";

async function mountBuilder(api: LabApi, segments: ReconstructedSegment[] = []) {
  let reloads = 0;
  const hook = await renderHook(useDatasetBuilder, {
    api,
    segments,
    onSaved: () => {
      reloads += 1;
    },
  });
  return { hook, reloads: () => reloads };
}

/** Advances past the prefill debounce and flushes the request it starts. */
async function settleLayer1(): Promise<void> {
  await flush(async () => {
    mock.timers.tick(LAYER2_PREFILL_DEBOUNCE_MS);
  });
}

function prefillApi(prefill: (literal: string) => Promise<string>): LabApi {
  return stubLabApi({ prefillDatasetBuilderLayer2: prefill });
}

test("Layer 2 is prefilled from the pipeline once Layer 1 settles", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const asked: string[] = [];
  const harness = await mountBuilder(
    prefillApi(async (literal) => {
      asked.push(literal);
      return "$x^{2}$ plus deux";
    }),
  );

  await flush(() => harness.hook.current.setBuilderLiteral("x au carré plus deux"));
  assert.deepEqual(asked, [], "nothing is asked before the debounce elapses");

  await settleLayer1();

  assert.deepEqual(asked, ["x au carré plus deux"]);
  assert.equal(harness.hook.current.builderNotationPrefill, "$x^{2}$ plus deux");
  assert.equal(harness.hook.current.builderNotation, "$x^{2}$ plus deux");
  assert.equal(harness.hook.current.isPrefillingLayer2, false);
  assert.equal(harness.hook.current.builderPrefillError, "");

  mock.timers.reset();
  await harness.hook.unmount();
});

test("the pipeline is asked once for a Layer 1 typed in several keystrokes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const asked: string[] = [];
  const harness = await mountBuilder(
    prefillApi(async (literal) => {
      asked.push(literal);
      return `prefilled:${literal}`;
    }),
  );

  await flush(() => harness.hook.current.setBuilderLiteral("x au"));
  await flush(async () => {
    mock.timers.tick(LAYER2_PREFILL_DEBOUNCE_MS - 50);
  });
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await settleLayer1();

  assert.deepEqual(asked, ["x au carré"], "the keystroke in flight is debounced away");

  mock.timers.reset();
  await harness.hook.unmount();
});

test("a human edit to Layer 2 is never overwritten by a later prefill", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await mountBuilder(prefillApi(async (literal) => `prefilled:${literal}`));

  await flush(() => harness.hook.current.setBuilderLiteral("first"));
  await settleLayer1();
  assert.equal(harness.hook.current.builderNotation, "prefilled:first");

  // The human corrects the prefill by hand, then keeps working on Layer 1.
  await flush(() => harness.hook.current.setBuilderNotation("typed by hand"));
  await flush(() => harness.hook.current.setBuilderLiteral("second"));
  await settleLayer1();

  assert.equal(harness.hook.current.builderNotation, "typed by hand", "the human's Layer 2 survives");
  assert.equal(harness.hook.current.builderNotationPrefill, "prefilled:second", "the diff still shows the new prefill");

  mock.timers.reset();
  await harness.hook.unmount();
});

test("an untouched earlier prefill is replaced by the newer one", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await mountBuilder(prefillApi(async (literal) => `prefilled:${literal}`));

  await flush(() => harness.hook.current.setBuilderLiteral("first"));
  await settleLayer1();
  await flush(() => harness.hook.current.setBuilderLiteral("second"));
  await settleLayer1();

  assert.equal(harness.hook.current.builderNotation, "prefilled:second");

  mock.timers.reset();
  await harness.hook.unmount();
});

test("clearing Layer 1 drops the prefill and its diff", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await mountBuilder(prefillApi(async (literal) => `prefilled:${literal}`));

  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await settleLayer1();
  assert.equal(harness.hook.current.builderNotationPrefill, "prefilled:x au carré");

  await flush(() => harness.hook.current.setBuilderLiteral("   "));

  assert.equal(harness.hook.current.builderNotationPrefill, "");
  assert.equal(harness.hook.current.builderPrefillError, "");

  mock.timers.reset();
  await harness.hook.unmount();
});

test("a failed prefill is reported and leaves Layer 2 alone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await mountBuilder(
    prefillApi(async () => {
      throw new Error("Rules overlay is malformed");
    }),
  );

  await flush(() => harness.hook.current.setBuilderNotation("kept"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await settleLayer1();

  assert.equal(harness.hook.current.builderPrefillError, "Rules overlay is malformed");
  assert.equal(harness.hook.current.builderNotation, "kept");
  assert.equal(harness.hook.current.isPrefillingLayer2, false);

  mock.timers.reset();
  await harness.hook.unmount();
});

test("saving without Layer 1 is refused before any round trip", async () => {
  // `saveDatasetBuilderEntry` is left unstubbed: reaching it would throw.
  const harness = await mountBuilder(prefillApi(async () => ""));

  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.equal(harness.hook.current.builderError, "Layer 1 (literal transcript) is required");
  assert.equal(harness.reloads(), 0);

  await harness.hook.unmount();
});

test("a pasted entry with no Layer 2 is refused with the rule that explains why", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await mountBuilder(prefillApi(async () => ""));

  await flush(() => harness.hook.current.setBuilderRawTranscript("some raw text"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await settleLayer1();
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.match(harness.hook.current.builderError, /a pasted \(no-audio\) entry needs Layer 2/);
  assert.equal(harness.reloads(), 0);

  mock.timers.reset();
  await harness.hook.unmount();
});

test("a segment mode save with no picked segment is refused", async () => {
  const harness = await mountBuilder(prefillApi(async () => ""), [segmentFixture()]);

  await flush(() => harness.hook.current.setBuilderMode("segment"));
  await flush(() => harness.hook.current.setBuilderSegmentKey("session_9/segment_9"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.equal(harness.hook.current.builderError, "Pick a DicTeX segment first");

  await harness.hook.unmount();
});

test("a picked segment saves its real identity and raw transcript as the acoustic pair", async () => {
  const segment = segmentFixture({ transcript: "x au caré" });
  let request: DatasetBuilderSaveRequest | null = null;
  const harness = await mountBuilder(
    stubLabApi({
      prefillDatasetBuilderLayer2: async () => "",
      saveDatasetBuilderEntry: async (received) => {
        request = received;
        return {
          sessionId: "session_1",
          segmentId: "segment_1",
          audioRef: "audio/session_1/segment_1.webm",
          split: received.split,
          savedAcoustic: true,
          savedMathTransform: false,
        };
      },
    }),
    [segment],
  );

  await flush(() => harness.hook.current.setBuilderMode("segment"));
  await flush(() => harness.hook.current.setBuilderSegmentKey("session_1/segment_1"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await flush(() => harness.hook.current.setBuilderSplit("test_frozen"));
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.deepEqual(request, {
    source: {
      mode: "segment",
      sessionId: "session_1",
      segmentId: "segment_1",
      audioRef: "audio/session_1/segment_1.webm",
    },
    rawTranscript: "x au caré",
    literalTranscript: "x au carré",
    notationTranscript: "",
    split: "test_frozen",
  });
  assert.equal(harness.hook.current.builderNotice, "Saved Acoustic -> test frozen (session_1 / segment_1)");
  assert.equal(harness.reloads(), 1);

  await harness.hook.unmount();
});

test("a successful paste save clears the whole form and its prefill", async () => {
  const harness = await mountBuilder(
    stubLabApi({
      prefillDatasetBuilderLayer2: async () => "$x^{2}$",
      saveDatasetBuilderEntry: async (received) => ({
        sessionId: "lab_manual_1",
        segmentId: "entry_abc",
        audioRef: null,
        split: received.split,
        savedAcoustic: false,
        savedMathTransform: true,
      }),
    }),
  );

  await flush(() => harness.hook.current.setBuilderRawTranscript("raw"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await flush(() => harness.hook.current.setBuilderNotation("$x^{2}$"));
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.equal(harness.hook.current.builderNotice, "Saved Math notation -> train pool (lab_manual_1 / entry_abc)");
  assert.equal(harness.hook.current.builderRawTranscript, "");
  assert.equal(harness.hook.current.builderLiteral, "");
  assert.equal(harness.hook.current.builderNotation, "");
  assert.equal(harness.hook.current.builderNotationPrefill, "");
  assert.equal(harness.reloads(), 1);

  await harness.hook.unmount();
});

test("a segment save keeps Layer 1 and the picked segment for the next layer", async () => {
  const segment = segmentFixture();
  const harness = await mountBuilder(
    stubLabApi({
      prefillDatasetBuilderLayer2: async () => "",
      saveDatasetBuilderEntry: async (received) => ({
        sessionId: "session_1",
        segmentId: "segment_1",
        audioRef: "audio/session_1/segment_1.webm",
        split: received.split,
        savedAcoustic: true,
        savedMathTransform: false,
      }),
    }),
    [segment],
  );

  await flush(() => harness.hook.current.setBuilderMode("segment"));
  await flush(() => harness.hook.current.setBuilderSegmentKey("session_1/segment_1"));
  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.equal(harness.hook.current.builderLiteral, "x au carré", "Layer 1 stays, it is Layer 2's input");
  assert.equal(harness.hook.current.builderSegmentKey, "session_1/segment_1");

  await harness.hook.unmount();
});

test("a rejected save reports the error and keeps the form intact", async () => {
  const harness = await mountBuilder(
    stubLabApi({
      prefillDatasetBuilderLayer2: async () => "",
      saveDatasetBuilderEntry: async () => {
        throw new Error("Lab events log is not writable");
      },
    }),
  );

  await flush(() => harness.hook.current.setBuilderLiteral("x au carré"));
  await flush(() => harness.hook.current.setBuilderNotation("$x^{2}$"));
  await flush(() => harness.hook.current.saveDatasetBuilderEntry());

  assert.equal(harness.hook.current.builderError, "Lab events log is not writable");
  assert.equal(harness.hook.current.builderNotation, "$x^{2}$");
  assert.equal(harness.hook.current.builderLiteral, "x au carré");
  assert.equal(harness.hook.current.isSavingBuilderEntry, false);
  assert.equal(harness.reloads(), 0);

  await harness.hook.unmount();
});
