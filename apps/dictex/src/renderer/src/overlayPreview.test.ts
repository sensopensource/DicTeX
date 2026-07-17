import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPreview, PREVIEW_SUMMARY_CAP } from "../../main/overlayState.js";
import { formatOverlayPreviewSummary, shouldShowNormalizerOff } from "./overlayPreview.js";

test("long raw and inserted variants keep distinct counts and labels", () => {
  const raw = buildPreview("r".repeat(PREVIEW_SUMMARY_CAP + 11));
  const inserted = buildPreview("i".repeat(PREVIEW_SUMMARY_CAP + 29));

  assert.equal(raw.kind, "summary");
  assert.equal(inserted.kind, "summary");
  if (raw.kind !== "summary" || inserted.kind !== "summary") {
    return;
  }

  assert.equal(formatOverlayPreviewSummary(raw.characters, "raw"), `${PREVIEW_SUMMARY_CAP + 11} raw characters`);
  assert.equal(
    formatOverlayPreviewSummary(inserted.characters, "inserted"),
    `${PREVIEW_SUMMARY_CAP + 29} characters inserted`,
  );
});

test("only an explicit Off run policy shows the raw-STT explanation", () => {
  assert.equal(shouldShowNormalizerOff(false), true);
  assert.equal(shouldShowNormalizerOff(true), false);
  assert.equal(shouldShowNormalizerOff(null), false);
});
