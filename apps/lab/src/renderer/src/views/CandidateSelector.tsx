import React, { useMemo, useState } from "react";
import type { BenchmarkCandidateIdentity } from "@dictex/shared";
import {
  candidateOptionMatchesModel,
  formatCandidateIdentityKey,
  getCandidateRuntimeLabels,
  groupCandidateModelsByProvider,
  sameCandidateModel,
  type CandidateModelChoice,
} from "@dictex/shared/formatting";
import { MAX_EXPERIMENT_CANDIDATES } from "../experimentProtocol.js";
import type { SttBenchmarkCandidateOption } from "../../../main/candidateCatalog.js";

/** The 1-3 rule of #126, kept in one place with the launch gate that enforces it. */
const MAX_CANDIDATES = MAX_EXPERIMENT_CANDIDATES;

type CandidateSelectorProps = {
  catalog: SttBenchmarkCandidateOption[];
  selectedCandidates: BenchmarkCandidateIdentity[];
  setSelectedCandidates: React.Dispatch<React.SetStateAction<BenchmarkCandidateIdentity[]>>;
  disabled: boolean;
  newPromptVariantName: string;
  setNewPromptVariantName: (value: string) => void;
  newPromptVariantDisplayName: string;
  setNewPromptVariantDisplayName: (value: string) => void;
  newPromptVariantText: string;
  setNewPromptVariantText: (value: string) => void;
  isCreatingPromptVariant: boolean;
  createPromptVariantError: string;
  createPromptVariant: () => Promise<boolean>;
};

/**
 * Progressive STT candidate selector (issue #126). Replaces the flat checkbox
 * grid: a compact list of the 1-3 selected candidates (each shown by model,
 * runtime and prompt, with Replace/Remove), plus an "add or replace" flow that
 * picks a model first (bounded, scrollable list), then runtime and prompt as
 * separate controls that each collapse once chosen, and shows the selected
 * prompt text read-only. It only ever offers fully-executable identities from
 * the real catalog — it never synthesizes an absent model/runtime/prompt
 * combination. A provider with no `initial_prompt` (Vosk) hides the prompt
 * choice instead of inventing a baseline. Creating a variant is a secondary
 * "New prompt" action beside the prompt choice, not a permanent panel.
 */
export function CandidateSelector({
  catalog,
  selectedCandidates,
  setSelectedCandidates,
  disabled,
  newPromptVariantName,
  setNewPromptVariantName,
  newPromptVariantDisplayName,
  setNewPromptVariantDisplayName,
  newPromptVariantText,
  setNewPromptVariantText,
  isCreatingPromptVariant,
  createPromptVariantError,
  createPromptVariant,
}: CandidateSelectorProps): React.ReactElement {
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [draftModel, setDraftModel] = useState<CandidateModelChoice | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<string | null>(null);
  const [draftCandidateKey, setDraftCandidateKey] = useState<string | null>(null);
  const [openControl, setOpenControl] = useState<"model" | "runtime" | "prompt" | null>(null);
  const [showNewPrompt, setShowNewPrompt] = useState(false);

  const optionByKey = useMemo(() => {
    const map = new Map<string, SttBenchmarkCandidateOption>();
    for (const option of catalog) {
      map.set(formatCandidateIdentityKey(option.candidate), option);
    }
    return map;
  }, [catalog]);
  const providers = useMemo(() => groupCandidateModelsByProvider(catalog), [catalog]);
  const modelOptions = useMemo(
    () => (draftModel ? catalog.filter((option) => candidateOptionMatchesModel(option, draftModel)) : []),
    [catalog, draftModel],
  );
  const runtimeOptions = useMemo(() => getCandidateRuntimeLabels(modelOptions), [modelOptions]);
  const supportsPrompt = modelOptions.length > 0 && modelOptions[0].supportsPrompt;
  const promptOptions = useMemo(
    () => modelOptions.filter((option) => option.runtimeLabel === draftRuntime),
    [modelOptions, draftRuntime],
  );

  const selectedKeys = selectedCandidates.map((candidate) => formatCandidateIdentityKey(candidate));
  const draftOption = draftCandidateKey ? optionByKey.get(draftCandidateKey) ?? null : null;
  // A resolved draft already in the selection (other than the slot being
  // replaced) would be a duplicate identity — block confirming it.
  const draftIsDuplicate =
    draftCandidateKey !== null &&
    selectedKeys.some(
      (key, index) => key === draftCandidateKey && !(replaceIndex !== null && index === replaceIndex),
    );
  const atAddLimit = replaceIndex === null && selectedCandidates.length >= MAX_CANDIDATES;

  function resetDraft(): void {
    setDraftModel(null);
    setDraftRuntime(null);
    setDraftCandidateKey(null);
    setOpenControl(null);
    setShowNewPrompt(false);
  }

  function startPick(index: number | null): void {
    setReplaceIndex(index);
    resetDraft();
    setIsPicking(true);
    setOpenControl("model");
  }

  function cancelPick(): void {
    setIsPicking(false);
    setReplaceIndex(null);
    resetDraft();
  }

  function chooseModel(model: CandidateModelChoice): void {
    const options = catalog.filter((option) => candidateOptionMatchesModel(option, model));
    const runtimes = getCandidateRuntimeLabels(options);
    const soleRuntime = runtimes.length === 1 ? runtimes[0] : null;
    const providerSupportsPrompt = options.length > 0 && options[0].supportsPrompt;
    setDraftModel(model);
    setDraftRuntime(soleRuntime);
    setShowNewPrompt(false);
    // A provider with no prompt concept (Vosk) has a single baseline candidate
    // per runtime; resolve it directly so the pick is immediately confirmable.
    if (!providerSupportsPrompt && soleRuntime) {
      const baseline = options.find((option) => option.runtimeLabel === soleRuntime) ?? null;
      setDraftCandidateKey(baseline ? formatCandidateIdentityKey(baseline.candidate) : null);
    } else {
      setDraftCandidateKey(null);
    }
    setOpenControl(null);
  }

  function chooseRuntime(runtime: string): void {
    setDraftRuntime(runtime);
    setDraftCandidateKey(null);
    setOpenControl(null);
  }

  function choosePrompt(candidateKey: string): void {
    setDraftCandidateKey(candidateKey);
    setOpenControl(null);
  }

  function confirmDraft(): void {
    if (!draftOption || draftIsDuplicate || atAddLimit) {
      return;
    }
    const chosen = draftOption.candidate;
    setSelectedCandidates((current) => {
      if (replaceIndex !== null) {
        return current.map((candidate, index) => (index === replaceIndex ? chosen : candidate));
      }
      return [...current, chosen];
    });
    cancelPick();
  }

  function removeCandidate(index: number): void {
    setSelectedCandidates((current) => current.filter((_, i) => i !== index));
  }

  async function submitNewPrompt(): Promise<void> {
    const created = await createPromptVariant();
    if (created) {
      // The catalog now carries the new variant under the current model; reopen
      // the prompt list so it can be picked right away.
      setShowNewPrompt(false);
      setOpenControl("prompt");
    }
  }

  if (catalog.length === 0) {
    return <p className="empty-state">No STT benchmark candidates configured.</p>;
  }

  const canCreatePrompt =
    !isCreatingPromptVariant &&
    newPromptVariantName.trim().length > 0 &&
    newPromptVariantDisplayName.trim().length > 0 &&
    newPromptVariantText.trim().length > 0;

  return (
    <div className="candidate-selector">
      <ul className="candidate-chips" aria-label="Selected STT candidates (1-3)">
        {selectedCandidates.map((candidate, index) => {
          const option = optionByKey.get(formatCandidateIdentityKey(candidate));
          return (
            <li className="candidate-chip" key={`${formatCandidateIdentityKey(candidate)}-${index}`}>
              <div className="candidate-chip-labels">
                <strong>{option ? option.modelLabel : candidate.model}</strong>
                <span className="candidate-chip-meta">
                  {option ? option.runtimeLabel : candidate.variant ?? ""} · {option ? option.variantLabel : "?"}
                </span>
              </div>
              <div className="candidate-chip-actions">
                <button className="secondary-button" disabled={disabled} onClick={() => startPick(index)}>
                  Replace
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled || selectedCandidates.length <= 1}
                  title={selectedCandidates.length <= 1 ? "Keep at least one candidate" : undefined}
                  onClick={() => removeCandidate(index)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {!isPicking && (
        <div className="candidate-add">
          <button
            className="secondary-button"
            disabled={disabled || selectedCandidates.length >= MAX_CANDIDATES}
            onClick={() => startPick(null)}
          >
            Add a candidate
          </button>
          {selectedCandidates.length >= MAX_CANDIDATES && (
            <span className="candidate-hint">Maximum 3 — replace or remove one to add another.</span>
          )}
        </div>
      )}

      {isPicking && (
        <div className="candidate-picker">
          <div className="candidate-picker-header">
            <strong>{replaceIndex !== null ? `Replace candidate ${replaceIndex + 1}` : "Add a candidate"}</strong>
            <button className="secondary-button" disabled={disabled} onClick={cancelPick}>
              Cancel
            </button>
          </div>

          <div className="candidate-control">
            <button
              className="candidate-control-toggle"
              aria-expanded={openControl === "model"}
              disabled={disabled}
              onClick={() => setOpenControl(openControl === "model" ? null : "model")}
            >
              Model: {draftModel ? draftModel.modelLabel : "choose…"}
            </button>
            {openControl === "model" && (
              <div className="candidate-option-list" role="listbox" aria-label="Model">
                {providers.map((group) => (
                  <div className="candidate-option-group" key={group.providerLabel}>
                    <span className="candidate-option-group-label">{group.providerLabel}</span>
                    {group.models.map((model) => (
                      <button
                        key={`${model.providerLabel}/${model.modelLabel}`}
                        type="button"
                        role="option"
                        aria-selected={draftModel !== null && sameCandidateModel(draftModel, model)}
                        className="candidate-option"
                        onClick={() => chooseModel(model)}
                      >
                        {model.modelLabel}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {draftModel && (
            <div className="candidate-control-row">
              <div className="candidate-control">
                <button
                  className="candidate-control-toggle"
                  aria-expanded={openControl === "runtime"}
                  disabled={disabled || runtimeOptions.length <= 1}
                  onClick={() => setOpenControl(openControl === "runtime" ? null : "runtime")}
                >
                  Runtime: {draftRuntime ?? "choose…"}
                </button>
                {openControl === "runtime" && runtimeOptions.length > 1 && (
                  <div className="candidate-option-list" role="listbox" aria-label="Runtime variant">
                    {runtimeOptions.map((runtime) => (
                      <button
                        key={runtime}
                        type="button"
                        role="option"
                        aria-selected={draftRuntime === runtime}
                        className="candidate-option"
                        onClick={() => chooseRuntime(runtime)}
                      >
                        {runtime}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {supportsPrompt ? (
                <div className="candidate-control">
                  <div className="candidate-control-head">
                    <button
                      className="candidate-control-toggle"
                      aria-expanded={openControl === "prompt"}
                      disabled={disabled || !draftRuntime}
                      onClick={() => setOpenControl(openControl === "prompt" ? null : "prompt")}
                    >
                      Prompt: {draftOption ? draftOption.variantLabel : "choose…"}
                    </button>
                    <button
                      className="secondary-button candidate-new-prompt"
                      disabled={disabled}
                      aria-expanded={showNewPrompt}
                      onClick={() => setShowNewPrompt((value) => !value)}
                    >
                      New prompt
                    </button>
                  </div>
                  {openControl === "prompt" && draftRuntime && (
                    <div className="candidate-option-list" role="listbox" aria-label="Prompt">
                      {promptOptions.map((option) => {
                        const key = formatCandidateIdentityKey(option.candidate);
                        return (
                          <button
                            key={key}
                            type="button"
                            role="option"
                            aria-selected={draftCandidateKey === key}
                            className="candidate-option"
                            onClick={() => choosePrompt(key)}
                          >
                            {option.variantLabel}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="candidate-no-prompt">No prompt — this provider has no initial_prompt.</p>
              )}
            </div>
          )}

          {showNewPrompt && supportsPrompt && (
            <div className="prompt-variant-form">
              <input
                aria-label="New prompt variant id"
                placeholder="id (e.g. prompt-v3-fr-math)"
                value={newPromptVariantName}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantName(event.target.value)}
              />
              <input
                aria-label="New prompt variant display name"
                placeholder="Display name"
                value={newPromptVariantDisplayName}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantDisplayName(event.target.value)}
              />
              <textarea
                aria-label="New prompt variant text"
                placeholder="Prompt text (short, vocabulary/context-oriented)"
                value={newPromptVariantText}
                disabled={isCreatingPromptVariant}
                onChange={(event) => setNewPromptVariantText(event.target.value)}
              />
              <div className="candidate-new-prompt-actions">
                <button className="secondary-button" disabled={!canCreatePrompt} onClick={() => void submitNewPrompt()}>
                  {isCreatingPromptVariant ? "Creating" : "Create prompt variant"}
                </button>
                <button
                  className="secondary-button"
                  disabled={isCreatingPromptVariant}
                  onClick={() => setShowNewPrompt(false)}
                >
                  Cancel
                </button>
              </div>
              {createPromptVariantError && <pre className="error">{createPromptVariantError}</pre>}
            </div>
          )}

          {draftModel && supportsPrompt && draftCandidateKey !== null && (
            draftOption && draftOption.promptText ? (
              <div className="candidate-prompt-preview">
                <span className="candidate-prompt-preview-label">Prompt text</span>
                <p className="candidate-prompt-preview-text">{draftOption.promptText}</p>
              </div>
            ) : (
              <p className="candidate-prompt-preview-empty">Baseline — no initial_prompt.</p>
            )
          )}

          <div className="candidate-picker-footer">
            <button
              className="secondary-button"
              disabled={disabled || !draftOption || draftIsDuplicate || atAddLimit}
              onClick={confirmDraft}
            >
              {replaceIndex !== null ? "Replace candidate" : "Add candidate"}
            </button>
            {draftIsDuplicate && <span className="candidate-hint">Already selected.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
