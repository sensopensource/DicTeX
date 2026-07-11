import { test } from "node:test";
import assert from "node:assert/strict";

import type { LocalEvent } from "@dictex/shared";
import {
  collectExistingPromptVariantNames,
  listPromptVariants,
  usableLocalPromptVariants,
  validateNewPromptVariant,
} from "./promptVariants.js";

/**
 * Pure-logic coverage for issue #121 (Lab-defined immutable STT prompt
 * variants): creation validation (empty/invalid id, duplicates against both
 * local and external namespaces) and the local/external merge used by the
 * renderer list and by the candidate catalog. The IPC wiring in ./index.ts is
 * exercised manually per docs/development.md, not here.
 */

function withEnv(entries: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(entries)) {
    previous[key] = process.env[key];
    const value = entries[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("validateNewPromptVariant: accepts a well-formed request", () => {
  const result = validateNewPromptVariant(
    { name: "prompt-v3-fr-math", displayName: "Math (FR)", promptText: "x carré, intégrale" },
    new Set(),
  );
  assert.deepEqual(result, { name: "prompt-v3-fr-math", displayName: "Math (FR)", promptText: "x carré, intégrale" });
});

test("validateNewPromptVariant: rejects an empty or invalid id", () => {
  assert.throws(() => validateNewPromptVariant({ name: "", displayName: "d", promptText: "t" }, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: "   ", displayName: "d", promptText: "t" }, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: "has space", displayName: "d", promptText: "t" }, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: "é-accent", displayName: "d", promptText: "t" }, new Set()));
});

test("validateNewPromptVariant: rejects an empty display name or prompt text", () => {
  assert.throws(() => validateNewPromptVariant({ name: "v1", displayName: "", promptText: "t" }, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: "v1", displayName: "d", promptText: "" }, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: "v1", displayName: "  ", promptText: "t" }, new Set()));
});

test("validateNewPromptVariant: rejects a name already in use, without altering anything", () => {
  assert.throws(() =>
    validateNewPromptVariant({ name: "v1", displayName: "d", promptText: "t" }, new Set(["v1"])),
  );
});

test("validateNewPromptVariant: rejects a malformed request shape", () => {
  assert.throws(() => validateNewPromptVariant(null, new Set()));
  assert.throws(() => validateNewPromptVariant({ name: 5, displayName: "d", promptText: "t" }, new Set()));
});

test("collectExistingPromptVariantNames: merges external (env) and local (event) names", () => {
  withEnv({ DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "ext-1": "text" }) }, () => {
    const events: LocalEvent[] = [
      { event_type: "stt_prompt_variant_defined", variant_name: "local-1", display_name: "Local", prompt_text: "t" },
    ];
    const names = collectExistingPromptVariantNames(events);
    assert.ok(names.has("ext-1"));
    assert.ok(names.has("local-1"));
    assert.equal(names.size, 2);
  });
});

test("listPromptVariants: distinguishes local (immutable, editable=false) from external (read-only) sources", () => {
  withEnv({ DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ "ext-1": "external text" }) }, () => {
    const events: LocalEvent[] = [
      {
        event_type: "stt_prompt_variant_defined",
        created_at: "2026-07-11T00:00:00.000Z",
        variant_name: "local-1",
        display_name: "Local one",
        prompt_text: "local text",
      },
    ];

    const list = listPromptVariants(events);
    const external = list.find((entry) => entry.name === "ext-1");
    const local = list.find((entry) => entry.name === "local-1");

    assert.ok(external);
    assert.equal(external?.source, "external");
    assert.equal(external?.displayName, "ext-1");
    assert.equal(external?.shadowedByExternal, false);

    assert.ok(local);
    assert.equal(local?.source, "local");
    assert.equal(local?.displayName, "Local one");
    assert.equal(local?.createdAt, "2026-07-11T00:00:00.000Z");
  });
});

test("listPromptVariants: flags a local definition shadowed by a same-named external variant", () => {
  withEnv({ DICTEX_STT_PROMPT_VARIANTS: JSON.stringify({ collide: "external text" }) }, () => {
    const events: LocalEvent[] = [
      { event_type: "stt_prompt_variant_defined", variant_name: "collide", display_name: "Local", prompt_text: "t" },
    ];

    const local = listPromptVariants(events).find((entry) => entry.name === "collide" && entry.source === "local");
    assert.equal(local?.shadowedByExternal, true);
  });
});

test("usableLocalPromptVariants: excludes a local definition whose name collides with an external one", () => {
  const local = [
    { name: "collide", displayName: "Local", promptText: "t", createdAt: null },
    { name: "unique", displayName: "Local 2", promptText: "t2", createdAt: null },
  ];
  const usable = usableLocalPromptVariants(local, { collide: "external text" });
  assert.deepEqual(
    usable.map((variant) => variant.name),
    ["unique"],
  );
});
