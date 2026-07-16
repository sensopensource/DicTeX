import { test } from "node:test";
import assert from "node:assert/strict";

import type { BenchmarkRunListEntry, SttBenchmarkRunDetail, SttBenchmarkSetSplit } from "@dictex/shared";
import { useBenchmarkRuns } from "./useBenchmarkRuns.js";
import { stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { LEGACY_RUN_KEY } from "../resultsSelection.js";
import type { LabApi } from "../api.js";

function runEntry(runId: string, split: SttBenchmarkSetSplit): BenchmarkRunListEntry {
  return {
    runId,
    createdAt: "2026-07-15T10:00:00.000Z",
    stage: "stt",
    datasetKind: "acoustic",
    split,
    snapshotSize: 1,
    candidateCount: 1,
    done: 1,
    failed: 0,
    finished: true,
  };
}

function runDetail(runId: string): SttBenchmarkRunDetail {
  return {
    runId,
    createdAt: "2026-07-15T10:00:00.000Z",
    finishedAt: "2026-07-15T10:05:00.000Z",
    stage: "stt",
    datasetKind: "acoustic",
    split: "validation",
    finished: true,
    done: 1,
    failed: 0,
    candidates: [
      { stage: "stt", provider: "faster-whisper", model: "base", variant: "cpu-int8-fr", promptVariant: null },
    ],
    promptDefinitions: [],
    failures: [],
    segments: [],
    summary: [],
  } as unknown as SttBenchmarkRunDetail;
}

async function mountRuns(api: LabApi) {
  return renderHook(useBenchmarkRuns, { api });
}

test("mounting lists the runs of the default split", async () => {
  const hook = await mountRuns(
    stubLabApi({ listBenchmarkRuns: async (split) => [runEntry("run_1", split)] }),
  );

  assert.equal(hook.current.resultsSplit, "validation");
  assert.deepEqual(
    hook.current.runList.map((run) => run.runId),
    ["run_1"],
  );

  await hook.unmount();
});

test("an unreadable run list degrades to an empty list", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => {
        throw new Error("Lab events log is unreadable");
      },
    }),
  );

  assert.deepEqual(hook.current.runList, []);

  await hook.unmount();
});

test("browsing another split reloads its runs and drops the shown run", async () => {
  const asked: SttBenchmarkSetSplit[] = [];
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async (split) => {
        asked.push(split);
        return [runEntry(`run_of_${split}`, split)];
      },
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
    }),
  );

  await flush(() => hook.current.selectResult("run_of_validation"));
  assert.equal(hook.current.results.detail?.runId, "run_of_validation");

  await flush(() => hook.current.selectResultsSplit("test_frozen"));

  assert.equal(hook.current.resultsSplit, "test_frozen");
  assert.equal(hook.current.results.detail, null, "another split's numbers are never kept on screen");
  assert.deepEqual(asked, ["validation", "test_frozen"]);
  assert.deepEqual(
    hook.current.runList.map((run) => run.runId),
    ["run_of_test_frozen"],
  );

  await hook.unmount();
});

test("selecting a run shows that run's own detail", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [runEntry("run_1", "validation"), runEntry("run_2", "validation")],
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
    }),
  );

  await flush(() => hook.current.selectResult("run_1"));
  assert.equal(hook.current.results.detail?.runId, "run_1");

  await flush(() => hook.current.selectResult("run_2"));
  assert.equal(hook.current.results.detail?.runId, "run_2", "runs are never merged");

  await hook.unmount();
});

test("the legacy bucket is summarized for the browsed split", async () => {
  let askedSplit: SttBenchmarkSetSplit | null = null;
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [],
      summarizeLegacySttBenchmarkSet: async (split) => {
        askedSplit = split;
        return { summary: [], segmentCount: 0 } as never;
      },
    }),
  );

  await flush(() => hook.current.selectResult(LEGACY_RUN_KEY));

  assert.equal(askedSplit, "validation");
  assert.equal(hook.current.results.detail, null, "the legacy bucket has no run detail");

  await hook.unmount();
});

test("an unreadable run is reported under its own key", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [runEntry("run_1", "validation")],
      getBenchmarkRunDetail: async () => {
        throw new Error("Run snapshot is corrupt");
      },
    }),
  );

  await flush(() => hook.current.selectResult("run_1"));

  assert.equal(hook.current.results.error, "Run snapshot is corrupt");
  assert.equal(hook.current.results.detail, null);

  await hook.unmount();
});

test("a launch shows its new run: the split, the list and the selection move together", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async (split) => [runEntry(`fresh_run_${split}`, split)],
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
    }),
  );

  await flush(() => hook.current.showRun("test_frozen", "fresh_run_test_frozen"));

  assert.equal(hook.current.resultsSplit, "test_frozen");
  assert.deepEqual(
    hook.current.runList.map((run) => run.runId),
    ["fresh_run_test_frozen"],
  );
  assert.equal(hook.current.results.detail?.runId, "fresh_run_test_frozen");

  await hook.unmount();
});

test("exporting the selected run reports where it went", async () => {
  let exportedRunId = "";
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [runEntry("run_1", "validation")],
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
      exportBenchmarkRun: async (runId) => {
        exportedRunId = runId;
        return { exportDir: "C:/exports/run_1" } as never;
      },
    }),
  );

  await flush(() => hook.current.selectResult("run_1"));
  await flush(() => hook.current.exportSelectedRun());

  assert.equal(exportedRunId, "run_1");
  assert.equal(hook.current.runExportSummary?.exportDir, "C:/exports/run_1");
  assert.equal(hook.current.runExportError, "");
  assert.equal(hook.current.isExportingRun, false);

  await hook.unmount();
});

test("exporting with no run selected never reaches the main process", async () => {
  // `exportBenchmarkRun` is left unstubbed: reaching it would throw.
  const hook = await mountRuns(stubLabApi({ listBenchmarkRuns: async () => [] }));

  await flush(() => hook.current.exportSelectedRun());

  assert.equal(hook.current.runExportSummary, null);
  assert.equal(hook.current.runExportError, "");

  await hook.unmount();
});

test("a failed export is reported and leaves no stale summary", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [runEntry("run_1", "validation")],
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
      exportBenchmarkRun: async () => {
        throw new Error("Export folder is not writable");
      },
    }),
  );

  await flush(() => hook.current.selectResult("run_1"));
  await flush(() => hook.current.exportSelectedRun());

  assert.equal(hook.current.runExportError, "Export folder is not writable");
  assert.equal(hook.current.runExportSummary, null);
  assert.equal(hook.current.isExportingRun, false);

  await hook.unmount();
});

test("selecting another run drops the previous run's export summary", async () => {
  const hook = await mountRuns(
    stubLabApi({
      listBenchmarkRuns: async () => [runEntry("run_1", "validation"), runEntry("run_2", "validation")],
      getBenchmarkRunDetail: async (runId) => runDetail(runId),
      exportBenchmarkRun: async (runId) => ({ exportDir: `C:/exports/${runId}` }) as never,
    }),
  );

  await flush(() => hook.current.selectResult("run_1"));
  await flush(() => hook.current.exportSelectedRun());
  assert.equal(hook.current.runExportSummary?.exportDir, "C:/exports/run_1");

  await flush(() => hook.current.selectResult("run_2"));

  assert.equal(hook.current.runExportSummary, null, "run_1's export folder is never shown under run_2");

  await hook.unmount();
});

test("opening the export folder before an export never reaches the main process", async () => {
  // `openExportFolder` is left unstubbed: reaching it would throw.
  const hook = await mountRuns(stubLabApi({ listBenchmarkRuns: async () => [] }));

  await flush(() => hook.current.openRunExportFolder());

  await hook.unmount();
});
