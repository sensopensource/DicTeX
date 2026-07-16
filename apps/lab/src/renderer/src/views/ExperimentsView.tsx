import React, { useMemo } from "react";
import type {
  BenchmarkCandidateIdentity,
  LegacyRulesMigrationPreview,
  RulesMigrationReceipt,
  SttBenchmarkSetPreview,
  SttBenchmarkSetProgress,
  SttBenchmarkSetSplit,
} from "@dictex/shared";
import {
  formatBenchmarkSetSplit,
  formatCandidateIdentity,
  formatCandidateIdentityKey,
  isSttBenchmarkSetSplit,
} from "@dictex/shared/formatting";
import { NORMALIZER_BENCHMARK_DISPLAY_NAME } from "@dictex/shared/normalizerBenchmark";
import {
  EXPERIMENT_STAGES,
  type ExperimentLaunchPlan,
  type ExperimentStage,
  type ExperimentStageId,
} from "../experimentProtocol.js";
import { CandidateSelector } from "./CandidateSelector.js";
import { LabNavigation, type View } from "./LabNavigation.js";
import type { SttBenchmarkCandidateOption } from "../../../main/candidateCatalog.js";
import type { NormalizerBenchmarkSetPreview } from "../../../main/normalizerBenchmark.js";

/** What a run over the launch form's split would freeze right now, per stage. */
export type ExperimentPreview =
  | ({ stage: "stt" } & SttBenchmarkSetPreview)
  | NormalizerBenchmarkSetPreview;

function formatRulesConfigurationState(state: NormalizerBenchmarkSetPreview["rulesConfiguration"]["state"]): string {
  return {
    bundled: "Bundled",
    current_overlay: "Current overlay",
    legacy_file: "Legacy file",
    migration_required: "Migration required",
    ambiguous: "Ambiguous",
    invalid: "Invalid",
  }[state];
}

type ExperimentsViewProps = {
  candidateCatalog: SttBenchmarkCandidateOption[];
  stageId: ExperimentStageId;
  setStageId: (stageId: ExperimentStageId) => void;
  stage: ExperimentStage;
  split: SttBenchmarkSetSplit;
  setSplit: (split: SttBenchmarkSetSplit) => void;
  preview: ExperimentPreview | null;
  previewError: string;
  selectedCandidates: BenchmarkCandidateIdentity[];
  setSelectedCandidates: React.Dispatch<React.SetStateAction<BenchmarkCandidateIdentity[]>>;
  launchPlan: ExperimentLaunchPlan;
  isRunning: boolean;
  launchProgress: SttBenchmarkSetProgress | null;
  launchError: string;
  launchExperiment: () => void;
  newPromptVariantName: string;
  setNewPromptVariantName: (value: string) => void;
  newPromptVariantDisplayName: string;
  setNewPromptVariantDisplayName: (value: string) => void;
  newPromptVariantText: string;
  setNewPromptVariantText: (value: string) => void;
  isCreatingPromptVariant: boolean;
  createPromptVariantError: string;
  /** Resolves to whether creation succeeded, so the inline form collapses only then. */
  createPromptVariant: () => Promise<boolean>;
  rulesMigrationPreview: LegacyRulesMigrationPreview | null;
  rulesMigrationReceipt: RulesMigrationReceipt | null;
  rulesMigrationError: string;
  isMigratingRules: boolean;
  reviewRulesMigration: () => void;
  resolveAmbiguousRule: (index: number, value: string) => void;
  confirmRulesMigration: () => void;
  openRulesFolder: () => void;
  onNavigate: (view: View) => void;
};

/**
 * The launch form (issue #138): stage, dataset, candidates, protocol, launch —
 * in that order, and nothing else. No summary, no past run, no historical
 * result: what an experiment produced belongs to its run, in Results. The
 * protocol states what will be consumed (`audio`), what it is scored against
 * (`Layer 1`), over which split and on how many members, BEFORE anything runs.
 */
export function ExperimentsView({
  candidateCatalog,
  stageId,
  setStageId,
  stage,
  split,
  setSplit,
  preview,
  previewError,
  selectedCandidates,
  setSelectedCandidates,
  launchPlan,
  isRunning,
  launchProgress,
  launchError,
  launchExperiment,
  newPromptVariantName,
  setNewPromptVariantName,
  newPromptVariantDisplayName,
  setNewPromptVariantDisplayName,
  newPromptVariantText,
  setNewPromptVariantText,
  isCreatingPromptVariant,
  createPromptVariantError,
  createPromptVariant,
  rulesMigrationPreview,
  rulesMigrationReceipt,
  rulesMigrationError,
  isMigratingRules,
  reviewRulesMigration,
  resolveAmbiguousRule,
  confirmRulesMigration,
  openRulesFolder,
  onNavigate,
}: ExperimentsViewProps): React.ReactElement {
  const normalizerPreview = preview?.stage === "math_transform" ? preview : null;
  const optionByKey = useMemo(() => {
    const map = new Map<string, SttBenchmarkCandidateOption>();
    for (const option of candidateCatalog) {
      map.set(formatCandidateIdentityKey(option.candidate), option);
    }
    return map;
  }, [candidateCatalog]);

  return (
    <>
      <header className="titlebar">
        <div>
          <p className="eyebrow">DicTeX Lab</p>
          <h1>Experiments</h1>
        </div>
        <div className="status-pill">{stage.flow}</div>
      </header>

      <LabNavigation activeView="experiments" onNavigate={onNavigate} />

      <section className="panel experiment-panel" aria-busy={isRunning}>
        <div className="panel-header">
          <div>
            <h2>New experiment</h2>
            <p>Announce the protocol, then launch it. The run it creates opens in Results.</p>
          </div>
        </div>

        <ol className="experiment-flow">
          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">1</span>
              <h3>Stage</h3>
            </div>
            <div className="stage-choices">
              {EXPERIMENT_STAGES.map((option) => (
                <button
                  aria-pressed={option.id === stageId}
                  className={`stage-choice ${option.id === stageId ? "stage-choice-selected" : ""}`}
                  disabled={!option.available || isRunning}
                  key={option.id}
                  title={option.unavailableReason ?? undefined}
                  onClick={() => setStageId(option.id)}
                >
                  <strong>{option.label}</strong>
                  <span className="stage-choice-flow">{option.flow}</span>
                  {!option.available && <span className="stage-choice-unavailable">Not runnable yet</span>}
                </button>
              ))}
            </div>
            <p className="experiment-step-note">
              STT and Normalizer are runnable. End to end stays announced until its own input and metric contract exists.
            </p>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">2</span>
              <h3>Dataset</h3>
            </div>
            <div className="actions">
              <select
                aria-label="Split to evaluate"
                className="secondary-select"
                disabled={isRunning}
                value={split}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (isSttBenchmarkSetSplit(value)) {
                    setSplit(value);
                  }
                }}
              >
                <option value="validation">Validation</option>
                <option value="test_frozen">Test frozen</option>
              </select>
              <span className="experiment-step-note">
                {preview
                  ? stage.id === "normalizer"
                    ? `${preview.evaluableSegments} evaluable math_transform pair${preview.evaluableSegments === 1 ? "" : "s"}`
                    : `${preview.evaluableSegments} evaluable member${preview.evaluableSegments === 1 ? "" : "s"} · ${preview.scorableSegments} with a Layer 1 reference`
                  : "Reading the corpus…"}
              </span>
            </div>
            {previewError && <pre className="error">{previewError}</pre>}
            <p className="experiment-step-note">
              {stage.id === "normalizer"
                ? "A member is the latest Layer 1 -> Layer 2 pair from one math_transform correction; audio is not required."
                : "A member is a corpus segment of this split with real audio."} Validation is what a decision is made on;
              test frozen is read once, after every decision.
            </p>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">3</span>
              <h3>Candidates</h3>
            </div>
            {stage.id === "normalizer" ? (
              normalizerPreview ? (
                <article className="normalizer-candidate-card">
                  <strong>{normalizerPreview.candidate.displayName}</strong>
                  <span>dictex · deterministic-pipeline</span>
                  <code>{formatCandidateIdentity(normalizerPreview.candidate.candidate)}</code>
                  <dl className="normalizer-version">
                    <div>
                      <dt>Rules state</dt>
                      <dd>
                        <span className={`rules-state rules-state-${normalizerPreview.rulesConfiguration.state}`}>
                          {formatRulesConfigurationState(normalizerPreview.rulesConfiguration.state)}
                        </span>
                        {normalizerPreview.rulesConfiguration.mode === "legacy" && (
                          <span className="rules-state rules-state-legacy">Legacy file</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Bundled rules</dt>
                      <dd>v{normalizerPreview.rulesConfiguration.bundledVersion} · {normalizerPreview.rulesConfiguration.bundledRuleCount}</dd>
                    </div>
                    <div>
                      <dt>Bundled rules SHA-256</dt>
                      <dd><code>{normalizerPreview.rulesConfiguration.bundledHash}</code></dd>
                    </div>
                    {normalizerPreview.rulesConfiguration.legacyHash && (
                      <div>
                        <dt>Legacy local source</dt>
                        <dd>v{normalizerPreview.rulesConfiguration.legacyVersion ?? "?"} · <code>{normalizerPreview.rulesConfiguration.legacyHash}</code></dd>
                      </div>
                    )}
                    {normalizerPreview.rulesConfiguration.overlayHash && (
                      <div>
                        <dt>Personal overlay SHA-256</dt>
                        <dd><code>{normalizerPreview.rulesConfiguration.overlayHash}</code></dd>
                      </div>
                    )}
                    <div>
                      <dt>Personal rules</dt>
                      <dd>{normalizerPreview.rulesConfiguration.personalRuleCount}</dd>
                    </div>
                    <div>
                      <dt>Effective rules</dt>
                      <dd>{normalizerPreview.rulesConfiguration.effectiveRuleCount}</dd>
                    </div>
                    <div>
                      <dt>Dictionary SHA-256</dt>
                      <dd><code>{normalizerPreview.candidate.version.dictionaryHash}</code></dd>
                    </div>
                    <div>
                      <dt>Effective rules SHA-256</dt>
                      <dd><code>{normalizerPreview.rulesConfiguration.effectiveHash}</code></dd>
                    </div>
                  </dl>
                  {normalizerPreview.rulesConfiguration.warning && (
                    <p className="rules-warning">
                      {normalizerPreview.rulesConfiguration.warning} A run is still allowed as a reproducible legacy baseline,
                      but it does not use the current bundled rules.
                    </p>
                  )}
                  <div className="rules-actions">
                    {normalizerPreview.rulesConfiguration.mode === "legacy" && (
                      <button className="secondary-button" disabled={isRunning || isMigratingRules} onClick={reviewRulesMigration}>
                        Review migration
                      </button>
                    )}
                    <button className="secondary-button" onClick={openRulesFolder}>Open rules folder</button>
                  </div>
                  {rulesMigrationError && <pre className="error">{rulesMigrationError}</pre>}
                  {rulesMigrationPreview && (
                    <section className="rules-migration-preview" aria-label="Rules migration preview">
                      <h4>Migration preview</h4>
                      <dl className="protocol-summary protocol-summary-wide">
                        <div><dt>Local legacy</dt><dd>v{rulesMigrationPreview.legacyVersion ?? "?"} · <code>{rulesMigrationPreview.legacyHash}</code></dd></div>
                        <div><dt>Bundled target</dt><dd>v{rulesMigrationPreview.bundledVersion} · {rulesMigrationPreview.bundledRuleCount} rules</dd></div>
                        <div><dt>Recognized shipped copies</dt><dd>{rulesMigrationPreview.recognizedBundledRules.length}</dd></div>
                        <div><dt>Personal rules kept</dt><dd>{rulesMigrationPreview.personalRules.length}</dd></div>
                        <div><dt>Ambiguities</dt><dd>{rulesMigrationPreview.ambiguities.length}</dd></div>
                        <div><dt>Invalid rules</dt><dd>{rulesMigrationPreview.invalidRules.length}</dd></div>
                        <div><dt>Expected effective SHA-256</dt><dd><code>{rulesMigrationPreview.expectedEffectiveHash ?? "Resolve issues first"}</code></dd></div>
                      </dl>
                      {rulesMigrationPreview.ambiguities.map((ambiguity) => {
                        const value = ambiguity.resolution?.action === "keep_personal"
                          ? "keep_personal"
                          : ambiguity.resolution?.action === "replace_bundled"
                            ? `replace:${ambiguity.resolution.bundledRuleId}`
                            : "";
                        return (
                          <label className="rules-ambiguity" key={ambiguity.index}>
                            <span>Rule #{ambiguity.index + 1}: <code>{ambiguity.rule.pattern}</code></span>
                            <select value={value} onChange={(event) => resolveAmbiguousRule(ambiguity.index, event.target.value)}>
                              <option value="">Choose explicitly…</option>
                              <option value="keep_personal">Keep personal and disable suggested bundled matches</option>
                              {ambiguity.candidateBundledRuleIds.map((id) => (
                                <option value={`replace:${id}`} key={id}>Replace bundled rule {id}</option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                      {rulesMigrationPreview.invalidRules.map((invalid) => (
                        <p className="rules-warning" key={invalid.index}>Rule #{invalid.index + 1}: {invalid.diagnostic}</p>
                      ))}
                      <button
                        className="primary-button"
                        disabled={rulesMigrationPreview.state !== "ready" || isMigratingRules}
                        onClick={confirmRulesMigration}
                      >
                        {isMigratingRules ? "Migrating…" : "Confirm migration"}
                      </button>
                    </section>
                  )}
                  {rulesMigrationReceipt && (
                    <section className="notice rules-migration-receipt">
                      <strong>Migration complete.</strong>
                      <span>Backup: <code>{rulesMigrationReceipt.backup_path}</code></span>
                      <span>Overlay SHA-256: <code>{rulesMigrationReceipt.overlay_sha256}</code></span>
                      <span>Effective SHA-256: <code>{rulesMigrationReceipt.effective_sha256}</code></span>
                    </section>
                  )}
                </article>
              ) : (
                <p className="empty-state">Reading the current deterministic pipeline…</p>
              )
            ) : (
              <CandidateSelector
                catalog={candidateCatalog}
                selectedCandidates={selectedCandidates}
                setSelectedCandidates={setSelectedCandidates}
                disabled={isRunning}
                newPromptVariantName={newPromptVariantName}
                setNewPromptVariantName={setNewPromptVariantName}
                newPromptVariantDisplayName={newPromptVariantDisplayName}
                setNewPromptVariantDisplayName={setNewPromptVariantDisplayName}
                newPromptVariantText={newPromptVariantText}
                setNewPromptVariantText={setNewPromptVariantText}
                isCreatingPromptVariant={isCreatingPromptVariant}
                createPromptVariantError={createPromptVariantError}
                createPromptVariant={createPromptVariant}
              />
            )}
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">4</span>
              <h3>Protocol</h3>
            </div>
            <dl className="protocol-summary">
              <div>
                <dt>Stage</dt>
                <dd>{stage.label}</dd>
              </div>
              <div>
                <dt>Input</dt>
                <dd>{stage.input}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{stage.target}</dd>
              </div>
              <div>
                <dt>Transform</dt>
                <dd className="protocol-flow">{stage.flow}</dd>
              </div>
              <div>
                <dt>Dataset</dt>
                <dd>{formatBenchmarkSetSplit(split)}</dd>
              </div>
              <div>
                <dt>Evaluable members</dt>
                <dd>
                  {preview
                    ? stage.id === "normalizer"
                      ? `${preview.evaluableSegments} Layer 1 -> Layer 2 pairs`
                      : `${preview.evaluableSegments} (${preview.scorableSegments} scorable)`
                    : "reading the corpus…"}
                </dd>
              </div>
              <div className="protocol-summary-wide">
                <dt>Snapshot</dt>
                <dd>
                  Frozen automatically when the run starts: its members and their {stage.id === "normalizer"
                    ? "Layer 1 inputs, Layer 2 targets and correction dates"
                    : "Layer 1 references"} are copied into the run, so a later correction never moves its numbers. There is
                  nothing to create by hand.
                </dd>
              </div>
              <div className="protocol-summary-wide">
                <dt>Candidates</dt>
                <dd>
                  {selectedCandidates.length === 0 ? (
                    "None selected yet."
                  ) : (
                    <ul className="protocol-candidates">
                      {selectedCandidates.map((candidate) => {
                        const option = optionByKey.get(formatCandidateIdentityKey(candidate));
                        return (
                          <li className="protocol-candidate" key={formatCandidateIdentityKey(candidate)}>
                            <strong>
                              {candidate.stage === "math_transform"
                                ? NORMALIZER_BENCHMARK_DISPLAY_NAME
                                : option
                                  ? option.modelLabel
                                  : candidate.model}
                            </strong>
                            {option && (
                              <span className="protocol-candidate-meta">
                                {option.runtimeLabel} · {option.variantLabel}
                              </span>
                            )}
                            <code className="protocol-candidate-identity">{formatCandidateIdentity(candidate)}</code>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </dd>
              </div>
            </dl>
          </li>

          <li className="experiment-step">
            <div className="experiment-step-head">
              <span className="experiment-step-index">5</span>
              <h3>Launch</h3>
            </div>
            <div className="actions">
              <button className="secondary-button" disabled={!launchPlan.canLaunch} onClick={launchExperiment}>
                {isRunning
                  ? "Running"
                  : normalizerPreview?.rulesConfiguration.mode === "legacy"
                    ? "Run legacy baseline"
                    : "Run experiment"}
              </button>
              {launchPlan.blockedReason && <span className="experiment-step-note">{launchPlan.blockedReason}</span>}
            </div>

            {launchPlan.warning && <p className="notice">{launchPlan.warning}</p>}
            {launchError && <pre className="error">{launchError}</pre>}

            {launchProgress && (
              <div className="batch-progress">
                <div className="batch-progress-counts">
                  <span className="batch-count">Total {launchProgress.total}</span>
                  <span className="batch-count">Queued {launchProgress.queued}</span>
                  <span className="batch-count">Running {launchProgress.running}</span>
                  <span className="batch-count batch-count-done">Done {launchProgress.done}</span>
                  <span className="batch-count batch-count-failed">Failed {launchProgress.failed}</span>
                </div>
                {launchProgress.current && (
                  <p
                    className="batch-current"
                    title={`${launchProgress.current.sessionId} / ${launchProgress.current.segmentId}`}
                  >
                    Running {launchProgress.current.sessionId} / {launchProgress.current.segmentId}
                  </p>
                )}
                {launchProgress.lastOutcome && (
                  <p
                    className={
                      launchProgress.lastOutcome.status === "failed" ? "batch-last batch-last-failed" : "batch-last"
                    }
                  >
                    {launchProgress.lastOutcome.status === "failed"
                      ? `Failed ${launchProgress.lastOutcome.sessionId} / ${launchProgress.lastOutcome.segmentId}: ${launchProgress.lastOutcome.error ?? "error"}`
                      : `Done ${launchProgress.lastOutcome.sessionId} / ${launchProgress.lastOutcome.segmentId} (${launchProgress.lastOutcome.resultCount} candidates)`}
                  </p>
                )}
              </div>
            )}
          </li>
        </ol>
      </section>
    </>
  );
}
