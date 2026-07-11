import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readAppSettings, writeAppSettings } from "./settings.js";

async function withTemporarySettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "dictex-settings-"));
  try {
    await run(path.join(directory, "settings.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("missing settings keep the normalizer enabled for backward compatibility", async () => {
  await withTemporarySettings(async (settingsPath) => {
    const loaded = await readAppSettings(settingsPath);
    assert.deepEqual(loaded, {
      settings: { sttModel: null, normalizerEnabled: true },
      diagnostics: [],
    });
  });
});

test("legacy settings without normalizerEnabled default to enabled", async () => {
  await withTemporarySettings(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ sttModel: "small" }), "utf8");

    const loaded = await readAppSettings(settingsPath);
    assert.deepEqual(loaded.settings, { sttModel: "small", normalizerEnabled: true });
    assert.deepEqual(loaded.diagnostics, []);
  });
});

test("readAppSettings preserves an explicit disabled normalizer", async () => {
  await withTemporarySettings(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ sttModel: "base", normalizerEnabled: false }), "utf8");

    const loaded = await readAppSettings(settingsPath);
    assert.deepEqual(loaded.settings, { sttModel: "base", normalizerEnabled: false });
    assert.deepEqual(loaded.diagnostics, []);
  });
});

test("an invalid normalizerEnabled value falls back to enabled with a diagnostic", async () => {
  await withTemporarySettings(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ normalizerEnabled: "off" }), "utf8");

    const loaded = await readAppSettings(settingsPath);
    assert.deepEqual(loaded.settings, { sttModel: null, normalizerEnabled: true });
    assert.deepEqual(loaded.diagnostics, ['settings.json "normalizerEnabled" must be a boolean; using true']);
  });
});

test("writeAppSettings persists the normalizer and omits a null STT model", async () => {
  await withTemporarySettings(async (settingsPath) => {
    await writeAppSettings(settingsPath, { sttModel: null, normalizerEnabled: false });

    const payload = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(payload, { normalizerEnabled: false });
  });
});

test("writeAppSettings preserves the STT model and normalizer state together", async () => {
  await withTemporarySettings(async (settingsPath) => {
    await writeAppSettings(settingsPath, { sttModel: "large-v3-turbo", normalizerEnabled: true });

    const payload = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(payload, { sttModel: "large-v3-turbo", normalizerEnabled: true });
  });
});
