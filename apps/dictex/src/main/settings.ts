import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Local, user-editable app settings persisted under the Electron userData data
 * directory (`data/settings.json`). Intentionally a minimal flat JSON object so
 * it can be hand-edited and grown one field at a time.
 *
 * Current shape:
 *
 *   { "sttModel": "base", "normalizerEnabled": true }
 *
 * `sttModel` is the STT model chosen from the UI. When absent, the app falls
 * back to the `DICTEX_STT_MODEL` env var, then the built-in default. A missing
 * `normalizerEnabled` defaults to true for backward compatibility with settings
 * written before the toggle existed. A missing or malformed file never crashes
 * or blocks dictation: it degrades to defaults with a quiet diagnostic.
 */
export type AppSettings = {
  sttModel: string | null;
  normalizerEnabled: boolean;
};

export type LoadedSettings = {
  settings: AppSettings;
  diagnostics: string[];
};

const defaultSettings: AppSettings = { sttModel: null, normalizerEnabled: true };

export async function readAppSettings(settingsPath: string): Promise<LoadedSettings> {
  if (!existsSync(settingsPath)) {
    return { settings: { ...defaultSettings }, diagnostics: [] };
  }

  let contents: string;
  try {
    contents = await readFile(settingsPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return { settings: { ...defaultSettings }, diagnostics: [`settings.json could not be read (${message}); using defaults`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { settings: { ...defaultSettings }, diagnostics: [`settings.json is not valid JSON (${message}); using defaults`] };
  }

  if (!isRecord(parsed)) {
    return { settings: { ...defaultSettings }, diagnostics: ["settings.json must be a JSON object; using defaults"] };
  }

  const diagnostics: string[] = [];
  let sttModel: string | null = null;
  let normalizerEnabled = true;

  if (parsed.sttModel !== undefined) {
    if (typeof parsed.sttModel === "string" && parsed.sttModel.trim().length > 0) {
      sttModel = parsed.sttModel;
    } else {
      diagnostics.push('settings.json "sttModel" must be a non-empty string; ignored');
    }
  }

  if (parsed.normalizerEnabled !== undefined) {
    if (typeof parsed.normalizerEnabled === "boolean") {
      normalizerEnabled = parsed.normalizerEnabled;
    } else {
      diagnostics.push('settings.json "normalizerEnabled" must be a boolean; using true');
    }
  }

  return { settings: { sttModel, normalizerEnabled }, diagnostics };
}

export async function writeAppSettings(settingsPath: string, settings: AppSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const payload: Record<string, unknown> = {};
  if (settings.sttModel !== null) {
    payload.sttModel = settings.sttModel;
  }
  payload.normalizerEnabled = settings.normalizerEnabled;
  await writeFile(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
