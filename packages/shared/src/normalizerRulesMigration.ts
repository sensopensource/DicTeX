import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_RULES,
  DEFAULT_RULES_CONFIG_VERSION,
  PERSONAL_RULES_OVERLAY_VERSION,
  analyzeLegacyRulesSource,
  inspectPersonalRuleOverlay,
  type LegacyRuleClassification,
  type PersonalRuleOverlay,
  type RuleEntry,
} from "./normalizer.js";

export type LegacyRuleResolution = {
  index: number;
  action: "keep_personal" | "replace_bundled";
  bundledRuleId?: string;
};

export type RulesMigrationConfirmation = {
  resolutions: LegacyRuleResolution[];
  expectedLegacyHash: string;
  expectedEffectiveHash: string;
};

export type LegacyRulesMigrationPreview = {
  state: "ready" | "ambiguous" | "invalid" | "already_migrated";
  legacyPath: string;
  overlayPath: string;
  legacyVersion: number | null;
  legacyHash: string;
  bundledVersion: number;
  bundledHash: string;
  bundledRuleCount: number;
  recognizedBundledRules: Array<{ index: number; bundledRuleId: string; historicalVersion: number }>;
  personalRules: Array<{ index: number; id: string }>;
  ambiguities: Array<{
    index: number;
    rule: RuleEntry;
    candidateBundledRuleIds: string[];
    resolution: LegacyRuleResolution | null;
  }>;
  invalidRules: Array<{ index: number; diagnostic: string }>;
  diagnostics: string[];
  expectedEffectiveHash: string | null;
  expectedEffectiveRuleCount: number | null;
};

export type RulesMigrationReceipt = {
  schema_version: 1;
  migration_id: string;
  created_at: string;
  legacy_path: string;
  backup_path: string;
  overlay_path: string;
  receipt_path: string;
  legacy_version: number | null;
  legacy_sha256: string;
  bundled_version: number;
  bundled_sha256: string;
  overlay_sha256: string;
  effective_sha256: string;
};

type MigrationPaths = {
  legacyRulesPath: string;
  overlayPath: string;
};

type MigrationRuntime = {
  now?: () => Date;
  writeOverlayAtomic?: (filePath: string, contents: string, migrationId: string) => Promise<void>;
  expectedLegacyHash?: string;
  expectedEffectiveHash?: string;
};

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function safePersonalId(index: number, rule: RuleEntry): string {
  return `personal-legacy-${index + 1}-${sha256(JSON.stringify(rule)).slice(0, 10)}`;
}

function bundledHash(): string {
  const overlay: PersonalRuleOverlay = {
    version: PERSONAL_RULES_OVERLAY_VERSION,
    bundled_rules_version: DEFAULT_RULES_CONFIG_VERSION,
    disabled_rule_ids: [],
    replacements: [],
    personal_rules: [],
  };
  return inspectPersonalRuleOverlay(overlay).effectiveHash;
}

function resolutionMap(resolutions: readonly LegacyRuleResolution[]): Map<number, LegacyRuleResolution> {
  const map = new Map<number, LegacyRuleResolution>();
  for (const resolution of resolutions) {
    if (map.has(resolution.index)) {
      throw new Error(`Ambiguous rule #${resolution.index + 1} has more than one resolution`);
    }
    map.set(resolution.index, resolution);
  }
  return map;
}

function buildOverlay(
  classifications: readonly LegacyRuleClassification[],
  resolutions: readonly LegacyRuleResolution[],
): PersonalRuleOverlay | null {
  const byIndex = resolutionMap(resolutions);
  const disabledRuleIds = new Set<string>();
  const replacements: PersonalRuleOverlay["replacements"] = [];
  const personalRules: PersonalRuleOverlay["personal_rules"] = [];
  for (const classification of classifications) {
    if (classification.kind === "invalid") {
      return null;
    }
    if (classification.kind === "bundled") {
      continue;
    }
    if (classification.kind === "personal") {
      personalRules.push({
        id: safePersonalId(classification.index, classification.rule),
        order: classification.index,
        ...classification.rule,
      });
      continue;
    }
    const resolution = byIndex.get(classification.index);
    if (!resolution) {
      return null;
    }
    if (resolution.action === "keep_personal") {
      for (const candidateId of classification.candidateBundledRuleIds) {
        disabledRuleIds.add(candidateId);
      }
      personalRules.push({
        id: safePersonalId(classification.index, classification.rule),
        order: classification.index,
        ...classification.rule,
      });
      continue;
    }
    if (
      !resolution.bundledRuleId ||
      !classification.candidateBundledRuleIds.includes(resolution.bundledRuleId)
    ) {
      throw new Error(`Ambiguous rule #${classification.index + 1} must target one of its suggested bundled ids`);
    }
    replacements.push({ rule_id: resolution.bundledRuleId, ...classification.rule });
  }
  return {
    version: PERSONAL_RULES_OVERLAY_VERSION,
    bundled_rules_version: DEFAULT_RULES_CONFIG_VERSION,
    disabled_rule_ids: [...disabledRuleIds].sort(),
    replacements,
    personal_rules: personalRules,
  };
}

export async function previewLegacyRulesMigration(
  paths: MigrationPaths,
  resolutions: readonly LegacyRuleResolution[] = [],
): Promise<LegacyRulesMigrationPreview> {
  const legacySource = await readFile(paths.legacyRulesPath, "utf8");
  const legacyHash = sha256(legacySource);
  const analysis = analyzeLegacyRulesSource(legacySource);
  const byIndex = resolutionMap(resolutions);
  const overlay = analysis.validTopLevel ? buildOverlay(analysis.classifications, resolutions) : null;
  const inspected = overlay ? inspectPersonalRuleOverlay(overlay) : null;
  const ambiguities = analysis.classifications
    .filter((entry): entry is Extract<LegacyRuleClassification, { kind: "ambiguous" }> => entry.kind === "ambiguous")
    .map((entry) => ({
      index: entry.index,
      rule: entry.rule,
      candidateBundledRuleIds: entry.candidateBundledRuleIds,
      resolution: byIndex.get(entry.index) ?? null,
    }));
  const invalidRules = analysis.classifications
    .filter((entry): entry is Extract<LegacyRuleClassification, { kind: "invalid" }> => entry.kind === "invalid")
    .map((entry) => ({ index: entry.index, diagnostic: entry.diagnostic }));
  const unresolved = ambiguities.some((entry) => entry.resolution === null);
  const state = !analysis.validTopLevel || invalidRules.length > 0
    ? "invalid"
    : unresolved
      ? "ambiguous"
      : "ready";
  return {
    state,
    legacyPath: paths.legacyRulesPath,
    overlayPath: paths.overlayPath,
    legacyVersion: analysis.legacyVersion,
    legacyHash,
    bundledVersion: DEFAULT_RULES_CONFIG_VERSION,
    bundledHash: bundledHash(),
    bundledRuleCount: BUNDLED_RULES.length,
    recognizedBundledRules: analysis.classifications
      .filter((entry): entry is Extract<LegacyRuleClassification, { kind: "bundled" }> => entry.kind === "bundled")
      .map((entry) => ({ index: entry.index, bundledRuleId: entry.bundledRuleId, historicalVersion: entry.historicalVersion })),
    personalRules: analysis.classifications
      .filter((entry): entry is Extract<LegacyRuleClassification, { kind: "personal" }> => entry.kind === "personal")
      .map((entry) => ({ index: entry.index, id: safePersonalId(entry.index, entry.rule) })),
    ambiguities,
    invalidRules,
    diagnostics: analysis.diagnostics,
    expectedEffectiveHash: state === "ready" ? inspected?.effectiveHash ?? null : null,
    expectedEffectiveRuleCount: state === "ready" ? inspected?.effectiveRuleCount ?? null : null,
  };
}

export async function migrateLegacyRules(
  paths: MigrationPaths,
  resolutions: readonly LegacyRuleResolution[] = [],
  runtime: MigrationRuntime = {},
): Promise<RulesMigrationReceipt> {
  const preview = await previewLegacyRulesMigration(paths, resolutions);
  if (preview.state === "invalid") {
    throw new Error("Legacy rules are invalid; repair rules.json before migration");
  }
  if (preview.state === "ambiguous") {
    throw new Error("Resolve every ambiguous legacy rule before migration");
  }
  if (
    runtime.expectedLegacyHash !== undefined &&
    runtime.expectedLegacyHash !== preview.legacyHash
  ) {
    throw new Error("Legacy rules changed after preview; review the migration again");
  }
  if (
    runtime.expectedEffectiveHash !== undefined &&
    runtime.expectedEffectiveHash !== preview.expectedEffectiveHash
  ) {
    throw new Error("The effective rules changed after preview; review the migration again");
  }

  const legacySource = await readFile(paths.legacyRulesPath, "utf8");
  if (sha256(legacySource) !== preview.legacyHash) {
    throw new Error("Legacy rules changed while migration was being prepared; review the migration again");
  }
  const analysis = analyzeLegacyRulesSource(legacySource);
  const overlay = buildOverlay(analysis.classifications, resolutions);
  if (!overlay) {
    throw new Error("Could not build a lossless personal overlay");
  }
  const overlaySource = `${JSON.stringify(overlay, null, 2)}\n`;
  const effective = inspectPersonalRuleOverlay(overlay);
  const migrationId = sha256(`${preview.legacyHash}:${effective.effectiveHash}`).slice(0, 24);
  const normalizerDir = path.dirname(paths.overlayPath);
  const backupDir = path.join(normalizerDir, "rules-backups");
  const receiptDir = path.join(normalizerDir, "rules-migrations");
  const receiptPath = path.join(receiptDir, `migration-${migrationId}.json`);

  try {
    const existingReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as RulesMigrationReceipt;
    if (existingReceipt.migration_id === migrationId && existingReceipt.effective_sha256 === effective.effectiveHash) {
      return existingReceipt;
    }
  } catch {
    // Missing or interrupted receipt: recover from the overlay and backup below.
  }

  await mkdir(backupDir, { recursive: true });
  await mkdir(receiptDir, { recursive: true });
  const now = runtime.now?.() ?? new Date();
  const stamp = now.toISOString().replace(/[^0-9]/g, "");
  let backupPath = await findMatchingBackup(backupDir, preview.legacyHash);
  if (!backupPath) {
    backupPath = await writeUniqueBackup(
      backupDir,
      `rules-${stamp}-${preview.legacyHash.slice(0, 12)}`,
      legacySource,
    );
  }

  if (sha256(await readFile(paths.legacyRulesPath, "utf8")) !== preview.legacyHash) {
    throw new Error("Legacy rules changed before activation; the reviewed backup was kept, but no overlay was activated");
  }

  let overlayAlreadyActivated = false;
  try {
    overlayAlreadyActivated = sha256(await readFile(paths.overlayPath, "utf8")) === sha256(overlaySource);
  } catch {
    // Overlay absent: normal migration path.
  }
  if (!overlayAlreadyActivated) {
    try {
      await readFile(paths.overlayPath, "utf8");
      throw new Error("rules-overlay.json already exists with different content; refusing to overwrite it");
    } catch (error) {
      if (error instanceof Error && error.message.includes("different content")) {
        throw error;
      }
    }
    const writer = runtime.writeOverlayAtomic ?? writeAtomic;
    await writer(paths.overlayPath, overlaySource, migrationId);
  }

  const receipt: RulesMigrationReceipt = {
    schema_version: 1,
    migration_id: migrationId,
    created_at: now.toISOString(),
    legacy_path: paths.legacyRulesPath,
    backup_path: backupPath,
    overlay_path: paths.overlayPath,
    receipt_path: receiptPath,
    legacy_version: preview.legacyVersion,
    legacy_sha256: preview.legacyHash,
    bundled_version: preview.bundledVersion,
    bundled_sha256: preview.bundledHash,
    overlay_sha256: sha256(overlaySource),
    effective_sha256: effective.effectiveHash,
  };
  await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, `${migrationId}-receipt`);
  return receipt;
}

async function writeExclusiveSynced(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeUniqueBackup(directory: string, baseName: string, contents: string): Promise<string> {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const discriminator = suffix === 0 ? "" : `-${suffix}`;
    const candidate = path.join(directory, `${baseName}${discriminator}.json`);
    try {
      await writeExclusiveSynced(candidate, contents);
      return candidate;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not allocate a collision-free legacy rules backup path");
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeAtomic(filePath: string, contents: string, migrationId: string): Promise<void> {
  // A unique name makes a retry independent from a stale temporary file left
  // by a process interruption before rename.
  const temporaryPath = `${filePath}.tmp-${migrationId}-${process.pid}-${randomUUID()}`;
  try {
    await writeExclusiveSynced(temporaryPath, contents);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function findMatchingBackup(directory: string, expectedHash: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of entries.sort()) {
    const candidate = path.join(directory, entry);
    try {
      if (sha256(await readFile(candidate, "utf8")) === expectedHash) {
        return candidate;
      }
    } catch {
      // Ignore unrelated/unreadable backup entries.
    }
  }
  return null;
}
