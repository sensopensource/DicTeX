import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BUNDLED_RULES,
  DEFAULT_RULES_CONFIG_VERSION,
  HISTORICAL_BUNDLED_RULE_SETS,
  PERSONAL_RULES_OVERLAY_FILENAME,
  analyzeLegacyRulesSource,
  createTranscriptNormalizer,
  type PersonalRuleOverlay,
} from "./normalizer.js";
import { migrateLegacyRules, previewLegacyRulesMigration } from "./normalizerRulesMigration.js";

function makePaths(prefix: string) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    directory,
    dictionaryPath: path.join(directory, "dictionary.json"),
    legacyRulesPath: path.join(directory, "rules.json"),
    overlayPath: path.join(directory, PERSONAL_RULES_OVERLAY_FILENAME),
  };
}

function writeJson(filePath: string, value: unknown): string {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, source, "utf8");
  return source;
}

test("bundled rules have stable unique ids and an old empty overlay automatically consumes the current bundle", async () => {
  const paths = makePaths("dictex-rules-overlay-");
  try {
    assert.equal(new Set(BUNDLED_RULES.map((rule) => rule.id)).size, BUNDLED_RULES.length);
    assert.equal(BUNDLED_RULES.length, 241);
    assert.equal(BUNDLED_RULES.every((rule, order) => rule.order === order), true);

    const options = {
      dictionaryPath: paths.dictionaryPath,
      rulesPath: paths.legacyRulesPath,
      rulesOverlayPath: paths.overlayPath,
    };
    const bundled = await createTranscriptNormalizer(options);
    assert.equal(bundled.rulesConfiguration.state, "bundled");
    assert.equal(bundled.rulesConfiguration.bundledVersion, 6);
    assert.equal(
      bundled.rulesConfiguration.bundledHash,
      "287513e2408dc7b17fe94bb6c659a7bb9cbd792eb59d95fc892a2a7f7e07e7d0",
    );
    assert.equal(bundled.rulesConfiguration.effectiveRuleCount, BUNDLED_RULES.length);
    assert.equal((await bundled.normalize("un sur x")).output, "$\\frac{1}{x}$");

    const oldOverlay: PersonalRuleOverlay = {
      version: 1,
      bundled_rules_version: 1,
      disabled_rule_ids: [],
      replacements: [],
      personal_rules: [],
    };
    writeJson(paths.overlayPath, oldOverlay);
    const upgraded = await createTranscriptNormalizer(options);
    assert.equal(upgraded.rulesConfiguration.state, "current_overlay");
    assert.equal(upgraded.rulesConfiguration.bundledVersion, DEFAULT_RULES_CONFIG_VERSION);
    assert.equal(upgraded.rulesConfiguration.effectiveRuleCount, BUNDLED_RULES.length);
    assert.equal(upgraded.version.rulesHash, bundled.version.rulesHash);
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("the legacy classifier distinguishes shipped, personal, ambiguous and invalid entries", () => {
  const historicalV1 = HISTORICAL_BUNDLED_RULE_SETS.find((set) => set.version === 1);
  assert.ok(historicalV1);
  const exact = analyzeLegacyRulesSource(JSON.stringify({ version: 1, rules: historicalV1.rules }));
  assert.equal(exact.classifications.every((entry) => entry.kind === "bundled"), true);
  const historicalV2 = HISTORICAL_BUNDLED_RULE_SETS.find((set) => set.version === 2);
  assert.ok(historicalV2);
  const exactV2 = analyzeLegacyRulesSource(JSON.stringify({ version: 2, rules: historicalV2.rules }));
  assert.equal(exactV2.classifications.length, 66);
  assert.equal(exactV2.classifications.every((entry) => entry.kind === "bundled"), true);
  const historicalV3 = HISTORICAL_BUNDLED_RULE_SETS.find((set) => set.version === 3);
  assert.ok(historicalV3);
  const exactV3 = analyzeLegacyRulesSource(JSON.stringify({ version: 3, rules: historicalV3.rules }));
  assert.equal(exactV3.classifications.length, 226);
  assert.equal(exactV3.classifications.every((entry) => entry.kind === "bundled"), true);

  const equality = historicalV3.rules.find((rule) => rule.replacement.includes(" = "));
  assert.ok(equality);
  const mixed = analyzeLegacyRulesSource(JSON.stringify({
    version: 2,
    rules: [
      { pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" },
      { pattern: equality.pattern, replacement: "CUSTOM", flags: equality.flags },
      { pattern: "[", replacement: "broken" },
    ],
  }));
  assert.deepEqual(mixed.classifications.map((entry) => entry.kind), ["personal", "ambiguous", "invalid"]);
});

test("an overlay disables and replaces bundled rules by stable id while keeping personal order deterministic", async () => {
  const paths = makePaths("dictex-rules-compose-");
  try {
    const equality = BUNDLED_RULES.find((rule) => rule.id === "equality");
    assert.ok(equality);
    const overlay: PersonalRuleOverlay = {
      version: 1,
      bundled_rules_version: DEFAULT_RULES_CONFIG_VERSION,
      disabled_rule_ids: ["addition"],
      replacements: [{
        rule_id: "equality",
        pattern: equality.pattern,
        replacement: "EQUAL",
        flags: equality.flags,
      }],
      personal_rules: [
        { id: "personal-second", order: 20, pattern: "\\bbeta\\b", replacement: "B", flags: "i" },
        { id: "personal-first", order: 10, pattern: "\\balpha\\b", replacement: "A", flags: "i" },
      ],
    };
    writeJson(paths.overlayPath, overlay);
    const normalizer = await createTranscriptNormalizer({
      dictionaryPath: paths.dictionaryPath,
      rulesPath: paths.legacyRulesPath,
      rulesOverlayPath: paths.overlayPath,
    });
    assert.equal((await normalizer.normalize("x plus y")).output, "x plus y");
    assert.equal((await normalizer.normalize("x égale y")).output, "EQUAL");
    assert.equal((await normalizer.normalize("alpha beta")).output, "A B");
    const effectiveIds = normalizer.pipelineSnapshot.regex_rules.effective_rules.map((rule) => rule.id);
    assert.equal(effectiveIds.includes("addition"), false);
    assert.equal(effectiveIds.indexOf("equality"), BUNDLED_RULES.findIndex((rule) => rule.id === "equality") - 1);
    assert.deepEqual(effectiveIds.slice(-2), ["personal-first", "personal-second"]);
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("migration keeps the legacy source byte-identical, backs it up, activates a lossless overlay and is idempotent", async () => {
  const paths = makePaths("dictex-rules-migrate-");
  try {
    const historicalV1 = HISTORICAL_BUNDLED_RULE_SETS.find((set) => set.version === 1);
    assert.ok(historicalV1);
    const legacySource = writeJson(paths.legacyRulesPath, {
      version: 1,
      rules: [...historicalV1.rules, { pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" }],
    });
    const legacyHash = createHash("sha256").update(legacySource).digest("hex");
    const fixedNow = new Date("2026-07-15T09:10:11.123Z");
    const stamp = fixedNow.toISOString().replace(/[^0-9]/g, "");
    const backupDir = path.join(paths.directory, "rules-backups");
    mkdirSync(backupDir);
    writeFileSync(path.join(backupDir, `rules-${stamp}-${legacyHash.slice(0, 12)}.json`), "collision", "utf8");

    const preview = await previewLegacyRulesMigration({ legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath });
    assert.equal(preview.state, "ready");
    assert.equal(preview.recognizedBundledRules.length, historicalV1.rules.length);
    assert.equal(preview.personalRules.length, 1);
    assert.equal(existsSync(paths.overlayPath), false, "preview performs no write");

    const receipt = await migrateLegacyRules(
      { legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath },
      [],
      { now: () => fixedNow },
    );
    assert.equal(readFileSync(paths.legacyRulesPath, "utf8"), legacySource);
    assert.equal(readFileSync(receipt.backup_path, "utf8"), legacySource);
    assert.match(path.basename(receipt.backup_path), /-1\.json$/u, "backup collision selects a new path");
    assert.equal(JSON.stringify(receipt).includes("bonjour"), false);

    const migrated = await createTranscriptNormalizer({
      dictionaryPath: paths.dictionaryPath,
      rulesPath: paths.legacyRulesPath,
      rulesOverlayPath: paths.overlayPath,
    });
    assert.equal(migrated.rulesConfiguration.state, "current_overlay");
    assert.equal(migrated.rulesConfiguration.personalRuleCount, 1);
    assert.equal(migrated.rulesConfiguration.effectiveRuleCount, BUNDLED_RULES.length + 1);
    assert.equal((await migrated.normalize("bonjour et un sur x")).output, "salut et $\\frac{1}{x}$");
    assert.equal(migrated.version.rulesHash, receipt.effective_sha256);

    const second = await migrateLegacyRules(
      { legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath },
      [],
      { now: () => fixedNow },
    );
    assert.deepEqual(second, receipt);
    assert.equal(readdirSync(backupDir).length, 2);
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("an ambiguous edited shipped rule requires an explicit decision and keep_personal preserves its behavior", async () => {
  const paths = makePaths("dictex-rules-ambiguous-");
  try {
    const historicalV3 = HISTORICAL_BUNDLED_RULE_SETS.find((set) => set.version === 3);
    assert.ok(historicalV3);
    const equality = historicalV3.rules.find((rule) => rule.replacement.includes(" = "));
    assert.ok(equality);
    writeJson(paths.legacyRulesPath, {
      version: 2,
      rules: [{ pattern: equality.pattern, replacement: "CUSTOM", flags: equality.flags }],
    });
    const unresolved = await previewLegacyRulesMigration({ legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath });
    assert.equal(unresolved.state, "ambiguous");
    await assert.rejects(
      migrateLegacyRules({ legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath }),
      /Resolve every ambiguous/u,
    );

    const resolution = [{ index: 0, action: "keep_personal" as const }];
    const resolved = await previewLegacyRulesMigration(
      { legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath },
      resolution,
    );
    assert.equal(resolved.state, "ready");
    await migrateLegacyRules(
      { legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath },
      resolution,
    );
    const overlay = JSON.parse(readFileSync(paths.overlayPath, "utf8")) as PersonalRuleOverlay;
    assert.deepEqual(overlay.disabled_rule_ids, ["equality"]);
    const normalizer = await createTranscriptNormalizer({
      dictionaryPath: paths.dictionaryPath,
      rulesPath: paths.legacyRulesPath,
      rulesOverlayPath: paths.overlayPath,
    });
    assert.equal((await normalizer.normalize("x égale y")).output, "CUSTOM");
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("invalid legacy input is never migrated, while an interrupted atomic write can be retried safely", async () => {
  const invalidPaths = makePaths("dictex-rules-invalid-");
  try {
    writeFileSync(invalidPaths.legacyRulesPath, "", "utf8");
    const invalid = await previewLegacyRulesMigration({ legacyRulesPath: invalidPaths.legacyRulesPath, overlayPath: invalidPaths.overlayPath });
    assert.equal(invalid.state, "invalid");
    await assert.rejects(
      migrateLegacyRules({ legacyRulesPath: invalidPaths.legacyRulesPath, overlayPath: invalidPaths.overlayPath }),
      /invalid/u,
    );
    assert.equal(existsSync(invalidPaths.overlayPath), false);
  } finally {
    rmSync(invalidPaths.directory, { recursive: true, force: true });
  }

  const retryPaths = makePaths("dictex-rules-retry-");
  try {
    const legacySource = writeJson(retryPaths.legacyRulesPath, {
      version: 1,
      rules: [{ pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" }],
    });
    await assert.rejects(
      migrateLegacyRules(
        { legacyRulesPath: retryPaths.legacyRulesPath, overlayPath: retryPaths.overlayPath },
        [],
        { writeOverlayAtomic: async () => { throw new Error("synthetic write failure"); } },
      ),
      /synthetic write failure/u,
    );
    assert.equal(readFileSync(retryPaths.legacyRulesPath, "utf8"), legacySource);
    assert.equal(existsSync(retryPaths.overlayPath), false);
    assert.equal(readdirSync(path.join(retryPaths.directory, "rules-backups")).length, 1);

    const receipt = await migrateLegacyRules({ legacyRulesPath: retryPaths.legacyRulesPath, overlayPath: retryPaths.overlayPath });
    assert.equal(existsSync(receipt.overlay_path), true);
    assert.equal(readdirSync(path.join(retryPaths.directory, "rules-backups")).length, 1);
  } finally {
    rmSync(retryPaths.directory, { recursive: true, force: true });
  }
});

test("confirmation is bound to the reviewed legacy and effective fingerprints", async () => {
  const paths = makePaths("dictex-rules-confirmation-");
  try {
    writeJson(paths.legacyRulesPath, {
      version: 1,
      rules: [{ pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" }],
    });
    const preview = await previewLegacyRulesMigration({
      legacyRulesPath: paths.legacyRulesPath,
      overlayPath: paths.overlayPath,
    });
    assert.equal(preview.state, "ready");
    assert.ok(preview.expectedEffectiveHash);
    writeJson(paths.legacyRulesPath, {
      version: 1,
      rules: [{ pattern: "\\bbonjour\\b", replacement: "hello", flags: "i" }],
    });
    await assert.rejects(
      migrateLegacyRules(
        { legacyRulesPath: paths.legacyRulesPath, overlayPath: paths.overlayPath },
        [],
        {
          expectedLegacyHash: preview.legacyHash,
          expectedEffectiveHash: preview.expectedEffectiveHash,
        },
      ),
      /changed after preview/u,
    );
    assert.equal(existsSync(paths.overlayPath), false);
    assert.equal(existsSync(path.join(paths.directory, "rules-backups")), false);
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("loader states are explicit for missing, empty, invalid, unreadable and legacy sources", async () => {
  const paths = makePaths("dictex-rules-states-");
  try {
    const options = { dictionaryPath: paths.dictionaryPath, rulesPath: paths.legacyRulesPath, rulesOverlayPath: paths.overlayPath };
    assert.equal((await createTranscriptNormalizer(options)).rulesConfiguration.state, "bundled");

    writeFileSync(paths.overlayPath, "", "utf8");
    assert.equal((await createTranscriptNormalizer(options)).rulesConfiguration.state, "invalid");
    writeFileSync(paths.overlayPath, "{ invalid", "utf8");
    assert.equal((await createTranscriptNormalizer(options)).rulesConfiguration.overlayState, "invalid");
    rmSync(paths.overlayPath);
    mkdirSync(paths.overlayPath);
    assert.equal((await createTranscriptNormalizer(options)).rulesConfiguration.overlayState, "unreadable");
    rmSync(paths.overlayPath, { recursive: true });

    writeJson(paths.legacyRulesPath, {
      version: 1,
      rules: [{ pattern: "\\bbonjour\\b", replacement: "salut", flags: "i" }],
    });
    const legacy = await createTranscriptNormalizer(options);
    assert.equal(legacy.rulesConfiguration.state, "migration_required");
    assert.equal(legacy.rulesConfiguration.mode, "legacy");
    assert.equal((await legacy.normalize("bonjour et un sur x")).output, "salut et un sur x");
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});
