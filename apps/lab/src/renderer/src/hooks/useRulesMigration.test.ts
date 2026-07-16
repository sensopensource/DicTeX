import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type {
  LegacyRuleResolution,
  LegacyRulesMigrationPreview,
  RulesMigrationConfirmation,
  RulesMigrationReceipt,
} from "@dictex/shared";
import { useRulesMigration } from "./useRulesMigration.js";
import { stubLabApi } from "./testing/labApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import "./testing/domEnvironment.js";
import type { LabApi } from "../api.js";

/** jsdom does not implement `confirm`, so the human's answer is stubbed per test. */
function answerConfirm(answer: boolean): void {
  window.confirm = () => answer;
}

afterEach(() => {
  Reflect.deleteProperty(window, "confirm");
});

function preview(overrides: Partial<LegacyRulesMigrationPreview> = {}): LegacyRulesMigrationPreview {
  return {
    state: "ready",
    legacyPath: "C:/data/normalizer/rules.json",
    overlayPath: "C:/data/normalizer/rules-overlay.json",
    legacyVersion: 1,
    legacyHash: "legacy-hash",
    bundledVersion: 3,
    bundledHash: "bundled-hash",
    bundledRuleCount: 226,
    recognizedBundledRules: [],
    personalRules: [],
    ambiguities: [],
    invalidRules: [],
    diagnostics: [],
    expectedEffectiveHash: "effective-hash",
    expectedEffectiveRuleCount: 227,
    ...overrides,
  };
}

const receipt = { schema_version: 1, migration_id: "migration_1" } as unknown as RulesMigrationReceipt;

async function mountMigration(api: LabApi, onMigrated: () => Promise<void> = async () => {}) {
  return renderHook(useRulesMigration, { api, onMigrated });
}

test("reviewing reads the legacy rules with no resolutions yet", async () => {
  let askedResolutions: LegacyRuleResolution[] | undefined;
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        askedResolutions = resolutions;
        return preview();
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());

  assert.deepEqual(askedResolutions, []);
  assert.equal(hook.current.rulesMigrationPreview?.state, "ready");
  assert.equal(hook.current.rulesMigrationError, "");

  await hook.unmount();
});

test("unreadable legacy rules are reported with no preview", async () => {
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async () => {
        throw new Error("rules.json is malformed");
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());

  assert.equal(hook.current.rulesMigrationPreview, null);
  assert.equal(hook.current.rulesMigrationError, "rules.json is malformed");

  await hook.unmount();
});

test("resolving an ambiguity re-previews with that resolution", async () => {
  const asked: LegacyRuleResolution[][] = [];
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        asked.push(resolutions ?? []);
        return preview();
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(2, "keep_personal"));

  assert.deepEqual(asked.at(-1), [{ index: 2, action: "keep_personal" }]);

  await hook.unmount();
});

test("choosing a bundled replacement carries the bundled rule id", async () => {
  const asked: LegacyRuleResolution[][] = [];
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        asked.push(resolutions ?? []);
        return preview();
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(2, "replace:rule-au-carre"));

  assert.deepEqual(asked.at(-1), [{ index: 2, action: "replace_bundled", bundledRuleId: "rule-au-carre" }]);

  await hook.unmount();
});

test("re-answering the same rule replaces its previous resolution", async () => {
  const asked: LegacyRuleResolution[][] = [];
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        asked.push(resolutions ?? []);
        return preview();
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(2, "keep_personal"));
  await flush(() => hook.current.resolveAmbiguousRule(2, "replace:rule-au-carre"));

  assert.deepEqual(
    asked.at(-1),
    [{ index: 2, action: "replace_bundled", bundledRuleId: "rule-au-carre" }],
    "one rule can only hold one answer",
  );

  await hook.unmount();
});

test("an unanswered choice drops that rule's resolution", async () => {
  const asked: LegacyRuleResolution[][] = [];
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        asked.push(resolutions ?? []);
        return preview();
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(2, "keep_personal"));
  await flush(() => hook.current.resolveAmbiguousRule(2, ""));

  assert.deepEqual(asked.at(-1), []);

  await hook.unmount();
});

test("confirming writes the hashes the reviewed preview was computed from", async () => {
  answerConfirm(true);
  let confirmation: RulesMigrationConfirmation | null = null;
  let refreshed = 0;
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async () => preview(),
      migrateRules: async (received) => {
        confirmation = received;
        return receipt;
      },
    }),
    async () => {
      refreshed += 1;
    },
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(1, "keep_personal"));
  await flush(() => hook.current.confirmRulesMigration());

  assert.deepEqual(confirmation, {
    resolutions: [{ index: 1, action: "keep_personal" }],
    expectedLegacyHash: "legacy-hash",
    expectedEffectiveHash: "effective-hash",
  });
  assert.equal(hook.current.rulesMigrationReceipt, receipt);
  assert.equal(hook.current.rulesMigrationPreview, null, "a consumed preview is never left reviewable");
  assert.equal(refreshed, 1, "the pipeline an experiment would run is re-read");
  assert.equal(hook.current.isMigratingRules, false);

  await hook.unmount();
});

test("declining the confirmation writes nothing", async () => {
  answerConfirm(false);
  // `migrateRules` is left unstubbed: reaching it would throw.
  const hook = await mountMigration(stubLabApi({ previewRulesMigration: async () => preview() }));

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.confirmRulesMigration());

  assert.equal(hook.current.rulesMigrationReceipt, null);
  assert.equal(hook.current.rulesMigrationPreview?.state, "ready", "the preview stays reviewable");

  await hook.unmount();
});

test("a preview that is not ready cannot be confirmed", async () => {
  // Neither `confirm` nor `migrateRules` is stubbed: reaching either would throw.
  const hook = await mountMigration(
    stubLabApi({ previewRulesMigration: async () => preview({ state: "ambiguous", expectedEffectiveHash: null }) }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.confirmRulesMigration());

  assert.equal(hook.current.rulesMigrationReceipt, null);

  await hook.unmount();
});

test("a rejected migration is reported and keeps the preview reviewable", async () => {
  answerConfirm(true);
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async () => preview(),
      migrateRules: async () => {
        throw new Error("Legacy rules changed since this preview");
      },
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.confirmRulesMigration());

  assert.equal(hook.current.rulesMigrationError, "Legacy rules changed since this preview");
  assert.equal(hook.current.rulesMigrationReceipt, null);
  assert.equal(hook.current.rulesMigrationPreview?.state, "ready");
  assert.equal(hook.current.isMigratingRules, false);

  await hook.unmount();
});

test("a preview that cannot be re-read after the write is reported, not silently stale", async () => {
  answerConfirm(true);
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async () => preview(),
      migrateRules: async () => receipt,
    }),
    async () => {
      throw new Error("Could not read the corpus for this split");
    },
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.confirmRulesMigration());

  assert.equal(hook.current.rulesMigrationError, "Could not read the corpus for this split");
  assert.equal(hook.current.rulesMigrationReceipt, receipt, "the write itself did succeed");
  assert.equal(hook.current.isMigratingRules, false);

  await hook.unmount();
});

test("reviewing again clears the previous receipt and its resolutions", async () => {
  answerConfirm(true);
  const asked: LegacyRuleResolution[][] = [];
  const hook = await mountMigration(
    stubLabApi({
      previewRulesMigration: async (resolutions) => {
        asked.push(resolutions ?? []);
        return preview();
      },
      migrateRules: async () => receipt,
    }),
  );

  await flush(() => hook.current.reviewRulesMigration());
  await flush(() => hook.current.resolveAmbiguousRule(1, "keep_personal"));
  await flush(() => hook.current.confirmRulesMigration());
  assert.equal(hook.current.rulesMigrationReceipt, receipt);

  await flush(() => hook.current.reviewRulesMigration());

  assert.equal(hook.current.rulesMigrationReceipt, null);
  assert.deepEqual(asked.at(-1), [], "a fresh review starts from no answers");

  await hook.unmount();
});
