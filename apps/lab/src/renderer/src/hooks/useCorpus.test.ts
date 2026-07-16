import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReconstructedSegment } from "@dictex/shared";
import { useCorpus } from "./useCorpus.js";
import { segmentFixture, stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import type { DataFolderStatus, LabApi } from "../api.js";

type CorpusFake = {
  /** Segments returned by the next read, keyed by the folder they belong to. */
  segmentsByFolder: Record<string, ReconstructedSegment[]>;
  /** How many times the segment list was read; a write must re-read it. */
  reads: number;
  folder: DataFolderStatus;
  /** What the native picker returns next; `null` is a cancelled dialog. */
  pickResult: DataFolderStatus | null;
};

/**
 * A main process that remembers the folder it was told to use.
 *
 * The hook re-reads the folder status after every reload, so a stub answering a
 * fixed folder would hide whether the new one was persisted at all: the state
 * would look right only until the reload overwrote it.
 */
function corpusFake(stubs: Partial<LabApi> = {}, initialSegments: ReconstructedSegment[] = []) {
  const fake: CorpusFake = {
    segmentsByFolder: { "C:/data": initialSegments },
    reads: 0,
    folder: { path: "C:/data", isDefault: true },
    pickResult: null,
  };

  const api = stubLabApi({
    getDataFolder: async () => fake.folder,
    checkDataFolder: async () => ({ exists: true, eventsFound: true }),
    getSegments: async () => {
      fake.reads += 1;
      return fake.segmentsByFolder[fake.folder.path] ?? [];
    },
    setDataFolder: async (path) => {
      fake.folder = { path, isDefault: false };
      return fake.folder;
    },
    resetDataFolder: async () => {
      fake.folder = { path: "C:/default", isDefault: true };
      return fake.folder;
    },
    pickDataFolder: async () => {
      if (fake.pickResult) {
        fake.folder = fake.pickResult;
      }
      return fake.pickResult;
    },
    ...stubs,
  });

  return { fake, api };
}

async function mountCorpus(api: LabApi) {
  const notices: string[] = [];
  const hook = await renderHook(useCorpus, { api, onNotice: (message) => notices.push(message) });
  return { hook, notices };
}

test("mounting reads the data folder, its status and the segments", async () => {
  const { api } = corpusFake({}, [segmentFixture()]);
  const { hook } = await mountCorpus(api);

  assert.deepEqual(hook.current.dataFolder, { path: "C:/data", isDefault: true });
  assert.deepEqual(hook.current.sourceCheck, { exists: true, eventsFound: true });
  assert.equal(hook.current.segments.length, 1);
  assert.equal(hook.current.isLoadingSegments, false);
  assert.equal(hook.current.segmentsError, "");

  await hook.unmount();
});

test("an unreadable source folder reports the error and keeps the list empty", async () => {
  const { api } = corpusFake({
    getSegments: async () => {
      throw new Error("Events log is unreadable");
    },
  });
  const { hook } = await mountCorpus(api);

  assert.equal(hook.current.segmentsError, "Events log is unreadable");
  assert.deepEqual(hook.current.segments, []);
  assert.equal(hook.current.isLoadingSegments, false);

  await hook.unmount();
});

test("choosing a folder announces it and reloads the segments from the new source", async () => {
  const { fake, api } = corpusFake({}, [segmentFixture({ segmentId: "from_default" })]);
  fake.segmentsByFolder["D:/other"] = [segmentFixture({ segmentId: "from_other" })];
  fake.pickResult = { path: "D:/other", isDefault: false };
  const { hook, notices } = await mountCorpus(api);
  assert.equal(hook.current.segments[0].segmentId, "from_default");

  await flush(() => hook.current.pickDataFolder());

  assert.deepEqual(hook.current.dataFolder, { path: "D:/other", isDefault: false });
  assert.deepEqual(notices, ["DicTeX data folder set to D:/other"]);
  assert.equal(hook.current.segments[0].segmentId, "from_other", "the list comes from the newly chosen folder");
  assert.equal(hook.current.isSavingDataFolder, false);

  await hook.unmount();
});

test("cancelling the folder picker changes nothing and says nothing", async () => {
  // `pickResult` stays null: the native dialog was dismissed.
  const { api } = corpusFake();
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.pickDataFolder());

  assert.deepEqual(hook.current.dataFolder, { path: "C:/data", isDefault: true });
  assert.deepEqual(notices, []);
  assert.equal(hook.current.isSavingDataFolder, false);

  await hook.unmount();
});

test("applying a pasted path trims it, clears the draft and reloads", async () => {
  const { fake, api } = corpusFake();
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.setDataFolderDraft("  D:/pasted  "));
  await flush(() => hook.current.applyDataFolderDraft());

  assert.equal(fake.folder.path, "D:/pasted", "the trimmed path is what reaches the main process");
  assert.equal(hook.current.dataFolderDraft, "");
  assert.deepEqual(hook.current.dataFolder, { path: "D:/pasted", isDefault: false });
  assert.deepEqual(notices, ["DicTeX data folder set to D:/pasted"]);
  assert.equal(fake.reads, 2);

  await hook.unmount();
});

test("applying a blank draft never reaches the main process", async () => {
  const { fake, api } = corpusFake();
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.setDataFolderDraft("   "));
  await flush(() => hook.current.applyDataFolderDraft());

  assert.equal(fake.folder.path, "C:/data");
  assert.equal(fake.reads, 1, "no reload was triggered");
  assert.deepEqual(notices, []);
  assert.equal(hook.current.isSavingDataFolder, false);

  await hook.unmount();
});

test("a rejected folder is announced and leaves the previous one in place", async () => {
  const { api } = corpusFake({
    setDataFolder: async () => {
      throw new Error("Folder does not exist");
    },
  });
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.setDataFolderDraft("D:/missing"));
  await flush(() => hook.current.applyDataFolderDraft());

  assert.deepEqual(notices, ["Folder does not exist"]);
  assert.deepEqual(hook.current.dataFolder, { path: "C:/data", isDefault: true });
  assert.equal(hook.current.isSavingDataFolder, false);

  await hook.unmount();
});

test("resetting announces the default folder and reloads", async () => {
  const { api } = corpusFake();
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.resetDataFolder());

  assert.deepEqual(notices, ["DicTeX data folder reset to default (C:/default)"]);
  assert.deepEqual(hook.current.dataFolder, { path: "C:/default", isDefault: true });

  await hook.unmount();
});

test("Layer 1 opens on the raw STT transcript and targets an acoustic correction", async () => {
  const segment = segmentFixture({ transcript: "x au carré" });
  const { api } = corpusFake({}, [segment]);
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.startSegmentCorrection(segment, "layer1"));

  assert.deepEqual(hook.current.historyCorrectionTarget, {
    sessionId: "session_1",
    segmentId: "segment_1",
    audioRef: "audio/session_1/segment_1.webm",
    rawTranscript: "x au carré",
    correctionKind: "acoustic",
  });
  assert.equal(hook.current.historyCorrectionDraft, "x au carré");
  assert.deepEqual(notices, ["Correction target session_1 / segment_1"]);

  await hook.unmount();
});

test("Layer 2 without a Layer 1 refuses to open a target", async () => {
  const segment = segmentFixture();
  const { api } = corpusFake({}, [segment]);
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.startSegmentCorrection(segment, "layer2"));

  assert.equal(hook.current.historyCorrectionTarget, null);
  assert.equal(hook.current.correctionNotice, "Save Layer 1 before adding Layer 2");
  assert.deepEqual(notices, []);

  await hook.unmount();
});

test("saving a correction writes the target's pair, closes the editor and reloads", async () => {
  const segment = segmentFixture({ transcript: "x au caré" });
  let written: unknown = null;
  const { fake, api } = corpusFake(
    {
      saveSttCorrection: async (correction) => {
        written = correction;
        return {
          sessionId: correction.sessionId,
          segmentId: correction.segmentId,
          correctionKind: correction.correctionKind,
        } as never;
      },
    },
    [segment],
  );
  const { hook } = await mountCorpus(api);

  await flush(() => hook.current.startSegmentCorrection(segment, "layer1"));
  await flush(() => hook.current.editHistoryCorrectionDraft("x au carré"));
  await flush(() => hook.current.saveSegmentCorrection());

  assert.deepEqual(written, {
    sessionId: "session_1",
    segmentId: "segment_1",
    audioRef: "audio/session_1/segment_1.webm",
    rawTranscript: "x au caré",
    correctedTranscript: "x au carré",
    correctionKind: "acoustic",
    correctionMethod: "keyboard",
  });
  assert.equal(hook.current.correctionNotice, "Saved Acoustic correction for session_1 / segment_1");
  assert.equal(hook.current.historyCorrectionTarget, null);
  assert.equal(hook.current.historyCorrectionDraft, "");
  assert.equal(fake.reads, 2, "the list is re-derived from the logs after the append");

  await hook.unmount();
});

test("a failed save keeps the editor open with its draft", async () => {
  const segment = segmentFixture();
  const { api } = corpusFake(
    {
      saveSttCorrection: async () => {
        throw new Error("Lab events log is not writable");
      },
    },
    [segment],
  );
  const { hook } = await mountCorpus(api);

  await flush(() => hook.current.startSegmentCorrection(segment, "layer1"));
  await flush(() => hook.current.editHistoryCorrectionDraft("corrected"));
  await flush(() => hook.current.saveSegmentCorrection());

  assert.equal(hook.current.correctionNotice, "Lab events log is not writable");
  assert.notEqual(hook.current.historyCorrectionTarget, null);
  assert.equal(hook.current.historyCorrectionDraft, "corrected");
  assert.equal(hook.current.isSavingCorrection, false);

  await hook.unmount();
});

test("editing the draft clears the previous notice", async () => {
  const segment = segmentFixture();
  const { api } = corpusFake({}, [segment]);
  const { hook } = await mountCorpus(api);

  await flush(() => hook.current.startSegmentCorrection(segment, "layer2"));
  assert.equal(hook.current.correctionNotice, "Save Layer 1 before adding Layer 2");

  await flush(() => hook.current.editHistoryCorrectionDraft("anything"));

  assert.equal(hook.current.correctionNotice, "");

  await hook.unmount();
});

test("an uncorrected segment cannot be marked into a split", async () => {
  // `markSttBenchmarkSetMembership` is left unstubbed: reaching it would throw.
  const segment = segmentFixture({ correctedTranscript: null });
  const { api } = corpusFake({}, [segment]);
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.markSttBenchmarkSetMembership(segment, "validation"));

  assert.equal(hook.current.segmentsError, "Correct the transcript before adding it to an STT benchmark set");
  assert.deepEqual(notices, []);

  await hook.unmount();
});

test("marking a corrected segment announces its split and reloads", async () => {
  const segment = segmentFixture({ correctedTranscript: "x au carré" });
  const { fake, api } = corpusFake(
    {
      markSttBenchmarkSetMembership: async (membership) =>
        ({
          sessionId: membership.sessionId,
          segmentId: membership.segmentId,
          split: membership.split,
        }) as never,
    },
    [segment],
  );
  const { hook, notices } = await mountCorpus(api);

  await flush(() => hook.current.markSttBenchmarkSetMembership(segment, "test_frozen"));

  assert.deepEqual(notices, ["Marked session_1 / segment_1 as test frozen"]);
  assert.equal(hook.current.benchmarkSetTargetKey, null);
  assert.equal(fake.reads, 2);

  await hook.unmount();
});

test("a failed split assignment is reported and clears the pending target", async () => {
  const segment = segmentFixture({ correctedTranscript: "x au carré" });
  const { api } = corpusFake(
    {
      markSttBenchmarkSetMembership: async () => {
        throw new Error("Could not append the split event");
      },
    },
    [segment],
  );
  const { hook } = await mountCorpus(api);

  await flush(() => hook.current.markSttBenchmarkSetMembership(segment, "validation"));

  assert.equal(hook.current.segmentsError, "Could not append the split event");
  assert.equal(hook.current.benchmarkSetTargetKey, null);

  await hook.unmount();
});
