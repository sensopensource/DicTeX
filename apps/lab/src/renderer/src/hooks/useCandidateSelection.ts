import { useEffect, useState } from "react";
import type { BenchmarkCandidateIdentity, SttCandidateSelectionResponse } from "@dictex/shared";
import { formatCandidateIdentityKey } from "@dictex/shared/formatting";
import type { LabApi } from "../api.js";

export type CandidateSelection = {
  currentSelection: SttCandidateSelectionResponse | null;
  selectionReasonDraft: string;
  editSelectionReasonDraft: (draft: string) => void;
  selectionError: string;
  isSelectingCandidateKey: string;
  selectCandidate: (candidate: BenchmarkCandidateIdentity) => Promise<void>;
};

/**
 * Marks one STT candidate as the current base, with the reason that decided it.
 *
 * The reason is required rather than optional: a selection without one records
 * that a candidate won, but not what it won on, and the roadmap's evaluation
 * discipline asks every choice to state its reference and metric. The check
 * happens before the round trip so an empty reason never reaches the log.
 *
 * This stays outside `useBenchmarkRuns`: selecting a base is a decision that
 * outlives the run that motivated it, and it belongs to the STT stage only,
 * while run reading is stage-aware.
 */
export function useCandidateSelection({ api }: { api: LabApi }): CandidateSelection {
  const [currentSelection, setCurrentSelection] = useState<SttCandidateSelectionResponse | null>(null);
  const [selectionReasonDraft, setSelectionReasonDraft] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [isSelectingCandidateKey, setIsSelectingCandidateKey] = useState("");

  useEffect(() => {
    void api.getLatestSttCandidateSelection().then(setCurrentSelection).catch(() => {
      // Non-fatal; the panel shows none selected.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Typing a reason clears the complaint about not having one. */
  function editSelectionReasonDraft(draft: string): void {
    setSelectionReasonDraft(draft);
    setSelectionError("");
  }

  async function selectCandidate(candidate: BenchmarkCandidateIdentity): Promise<void> {
    if (selectionReasonDraft.trim() === "") {
      setSelectionError("Enter a selection reason before marking a candidate selected");
      return;
    }

    const candidateKey = formatCandidateIdentityKey(candidate);
    setSelectionError("");
    setIsSelectingCandidateKey(candidateKey);
    try {
      const selection = await api.selectSttCandidate({
        candidate,
        selectionReason: selectionReasonDraft.trim(),
      });
      setCurrentSelection(selection);
      setSelectionReasonDraft("");
    } catch (selectionSaveError) {
      setSelectionError(
        selectionSaveError instanceof Error ? selectionSaveError.message : "Could not save candidate selection",
      );
    } finally {
      setIsSelectingCandidateKey("");
    }
  }

  return {
    currentSelection,
    selectionReasonDraft,
    editSelectionReasonDraft,
    selectionError,
    isSelectingCandidateKey,
    selectCandidate,
  };
}
