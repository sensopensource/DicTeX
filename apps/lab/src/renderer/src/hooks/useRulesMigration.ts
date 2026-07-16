import { useState } from "react";
import type { LegacyRuleResolution, LegacyRulesMigrationPreview, RulesMigrationReceipt } from "@dictex/shared";
import type { LabApi } from "../api.js";

export type RulesMigration = {
  rulesMigrationPreview: LegacyRulesMigrationPreview | null;
  rulesMigrationReceipt: RulesMigrationReceipt | null;
  rulesMigrationError: string;
  isMigratingRules: boolean;
  reviewRulesMigration: () => Promise<void>;
  resolveAmbiguousRule: (index: number, value: string) => Promise<void>;
  confirmRulesMigration: () => Promise<void>;
  openRulesFolder: () => Promise<void>;
};

/**
 * Reviews and confirms the non-destructive migration of a legacy `rules.json`
 * into the versioned bundled set plus a personal overlay (#150).
 *
 * This is the Lab's one write into DicTeX's own folder, so nothing happens
 * without an explicit human confirmation, and the confirmation carries the
 * hashes the preview was computed from: the main process refuses the write if
 * the rules changed underneath, rather than migrating a file the human never
 * reviewed.
 *
 * @param onMigrated re-reads the Normalizer preview once the overlay is active,
 *   since the pipeline the experiment would run has just changed. It is
 *   deliberately awaited inside the confirmation's own try: a preview that
 *   cannot be re-read after a successful write is reported as a migration
 *   error rather than leaving a stale pipeline announced as current.
 */
export function useRulesMigration({ api, onMigrated }: { api: LabApi; onMigrated: () => Promise<void> }): RulesMigration {
  const [rulesMigrationPreview, setRulesMigrationPreview] = useState<LegacyRulesMigrationPreview | null>(null);
  const [rulesMigrationResolutions, setRulesMigrationResolutions] = useState<LegacyRuleResolution[]>([]);
  const [rulesMigrationReceipt, setRulesMigrationReceipt] = useState<RulesMigrationReceipt | null>(null);
  const [rulesMigrationError, setRulesMigrationError] = useState("");
  const [isMigratingRules, setIsMigratingRules] = useState(false);

  async function reviewRulesMigration(): Promise<void> {
    setRulesMigrationError("");
    setRulesMigrationReceipt(null);
    setRulesMigrationResolutions([]);
    try {
      setRulesMigrationPreview(await api.previewRulesMigration([]));
    } catch (error) {
      setRulesMigrationPreview(null);
      setRulesMigrationError(error instanceof Error ? error.message : "Could not inspect legacy rules");
    }
  }

  async function resolveAmbiguousRule(index: number, value: string): Promise<void> {
    const next = rulesMigrationResolutions.filter((resolution) => resolution.index !== index);
    if (value === "keep_personal") {
      next.push({ index, action: "keep_personal" });
    } else if (value.startsWith("replace:")) {
      next.push({ index, action: "replace_bundled", bundledRuleId: value.slice("replace:".length) });
    }
    setRulesMigrationResolutions(next);
    setRulesMigrationError("");
    try {
      setRulesMigrationPreview(await api.previewRulesMigration(next));
    } catch (error) {
      setRulesMigrationError(error instanceof Error ? error.message : "Could not update the migration preview");
    }
  }

  async function confirmRulesMigration(): Promise<void> {
    if (rulesMigrationPreview?.state !== "ready") {
      return;
    }
    if (!window.confirm("Create a timestamped backup and activate the reviewed personal overlay?")) {
      return;
    }
    setRulesMigrationError("");
    setIsMigratingRules(true);
    try {
      const receipt = await api.migrateRules({
        resolutions: rulesMigrationResolutions,
        expectedLegacyHash: rulesMigrationPreview.legacyHash,
        expectedEffectiveHash: rulesMigrationPreview.expectedEffectiveHash!,
      });
      setRulesMigrationReceipt(receipt);
      setRulesMigrationPreview(null);
      await onMigrated();
    } catch (error) {
      setRulesMigrationError(error instanceof Error ? error.message : "Rules migration failed");
    } finally {
      setIsMigratingRules(false);
    }
  }

  async function openRulesFolder(): Promise<void> {
    try {
      await api.openSourceRulesFolder();
    } catch {
      // Non-fatal convenience.
    }
  }

  return {
    rulesMigrationPreview,
    rulesMigrationReceipt,
    rulesMigrationError,
    isMigratingRules,
    reviewRulesMigration,
    resolveAmbiguousRule,
    confirmRulesMigration,
    openRulesFolder,
  };
}
