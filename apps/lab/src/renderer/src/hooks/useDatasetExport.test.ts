import { test } from "node:test";
import assert from "node:assert/strict";

import type { SttDatasetExportSummary } from "@dictex/shared";
import { useDatasetExport } from "./useDatasetExport.js";
import { stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import type { LabApi } from "../api.js";

const summary = { exportDir: "C:/exports/dataset", files: [] } as unknown as SttDatasetExportSummary;

async function mountExport(api: LabApi) {
  return renderHook(useDatasetExport, { api });
}

test("exporting reports where the dataset went", async () => {
  const hook = await mountExport(stubLabApi({ exportSttDataset: async () => summary }));

  await flush(() => hook.current.exportSttDataset());

  assert.equal(hook.current.datasetExportSummary?.exportDir, "C:/exports/dataset");
  assert.equal(hook.current.datasetExportError, "");
  assert.equal(hook.current.isExportingDataset, false);

  await hook.unmount();
});

test("a failed export is reported and clears the busy flag", async () => {
  const hook = await mountExport(
    stubLabApi({
      exportSttDataset: async () => {
        throw new Error("Export folder is not writable");
      },
    }),
  );

  await flush(() => hook.current.exportSttDataset());

  assert.equal(hook.current.datasetExportError, "Export folder is not writable");
  assert.equal(hook.current.isExportingDataset, false);

  await hook.unmount();
});

test("opening the folder after an export opens that export's folder", async () => {
  let opened: string | undefined = "not called";
  const hook = await mountExport(
    stubLabApi({
      exportSttDataset: async () => summary,
      openExportFolder: async (exportDir) => {
        opened = exportDir;
        return true;
      },
    }),
  );

  await flush(() => hook.current.exportSttDataset());
  await flush(() => hook.current.openExportFolder());

  assert.equal(opened, "C:/exports/dataset");

  await hook.unmount();
});

test("opening the folder before any export falls back to the default folder", async () => {
  let opened: string | undefined = "not called";
  const hook = await mountExport(
    stubLabApi({
      openExportFolder: async (exportDir) => {
        opened = exportDir;
        return true;
      },
    }),
  );

  await flush(() => hook.current.openExportFolder());

  assert.equal(opened, undefined, "no folder argument means the main process picks the default");

  await hook.unmount();
});
