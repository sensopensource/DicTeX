import { test } from "node:test";
import assert from "node:assert/strict";

import type { BenchmarkCandidateIdentity, SttCandidateSelectionRequest } from "@dictex/shared";
import { useCandidateSelection } from "./useCandidateSelection.js";
import { stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import type { LabApi } from "../api.js";

const candidate: BenchmarkCandidateIdentity = {
  stage: "stt",
  provider: "faster-whisper",
  model: "large-v3-turbo",
  variant: "cuda-float16-fr+conventions-litterales-v2",
};

function selectionResponse(request: SttCandidateSelectionRequest) {
  return {
    candidate: request.candidate,
    selectionReason: request.selectionReason,
    createdAt: "2026-07-15T12:00:00.000Z",
  } as never;
}

async function mountSelection(api: LabApi) {
  return renderHook(useCandidateSelection, { api });
}

test("mounting reads the latest selection", async () => {
  const hook = await mountSelection(
    stubLabApi({
      getLatestSttCandidateSelection: async () =>
        ({ candidate, selectionReason: "best CER on validation", createdAt: "2026-07-13T00:00:00.000Z" }) as never,
    }),
  );

  assert.equal(hook.current.currentSelection?.selectionReason, "best CER on validation");

  await hook.unmount();
});

test("an unreadable selection leaves the panel showing none", async () => {
  const hook = await mountSelection(
    stubLabApi({
      getLatestSttCandidateSelection: async () => {
        throw new Error("Lab events log is unreadable");
      },
    }),
  );

  assert.equal(hook.current.currentSelection, null);

  await hook.unmount();
});

test("selecting without a reason is refused before any round trip", async () => {
  // `selectSttCandidate` is left unstubbed: reaching it would throw.
  const hook = await mountSelection(stubLabApi({ getLatestSttCandidateSelection: async () => null }));

  await flush(() => hook.current.selectCandidate(candidate));

  assert.equal(hook.current.selectionError, "Enter a selection reason before marking a candidate selected");
  assert.equal(hook.current.currentSelection, null);

  await hook.unmount();
});

test("a whitespace-only reason is refused too", async () => {
  const hook = await mountSelection(stubLabApi({ getLatestSttCandidateSelection: async () => null }));

  await flush(() => hook.current.editSelectionReasonDraft("   "));
  await flush(() => hook.current.selectCandidate(candidate));

  assert.equal(hook.current.selectionError, "Enter a selection reason before marking a candidate selected");

  await hook.unmount();
});

test("selecting with a reason records the candidate and its trimmed reason", async () => {
  let request: SttCandidateSelectionRequest | null = null;
  const hook = await mountSelection(
    stubLabApi({
      getLatestSttCandidateSelection: async () => null,
      selectSttCandidate: async (received) => {
        request = received;
        return selectionResponse(received);
      },
    }),
  );

  await flush(() => hook.current.editSelectionReasonDraft("  8.57% CER on the 27-segment validation snapshot  "));
  await flush(() => hook.current.selectCandidate(candidate));

  assert.deepEqual(request, {
    candidate,
    selectionReason: "8.57% CER on the 27-segment validation snapshot",
  });
  assert.equal(hook.current.currentSelection?.selectionReason, "8.57% CER on the 27-segment validation snapshot");
  assert.equal(hook.current.selectionReasonDraft, "", "the reason belongs to the recorded selection, not the next one");
  assert.equal(hook.current.isSelectingCandidateKey, "");

  await hook.unmount();
});

test("typing a reason clears the complaint about not having one", async () => {
  const hook = await mountSelection(stubLabApi({ getLatestSttCandidateSelection: async () => null }));

  await flush(() => hook.current.selectCandidate(candidate));
  assert.notEqual(hook.current.selectionError, "");

  await flush(() => hook.current.editSelectionReasonDraft("b"));

  assert.equal(hook.current.selectionError, "");

  await hook.unmount();
});

test("a rejected selection keeps the reason so it can be retried", async () => {
  const hook = await mountSelection(
    stubLabApi({
      getLatestSttCandidateSelection: async () => null,
      selectSttCandidate: async () => {
        throw new Error("Lab events log is not writable");
      },
    }),
  );

  await flush(() => hook.current.editSelectionReasonDraft("best CER"));
  await flush(() => hook.current.selectCandidate(candidate));

  assert.equal(hook.current.selectionError, "Lab events log is not writable");
  assert.equal(hook.current.selectionReasonDraft, "best CER");
  assert.equal(hook.current.currentSelection, null);
  assert.equal(hook.current.isSelectingCandidateKey, "");

  await hook.unmount();
});
