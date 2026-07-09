import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The Lab's OWN local settings, persisted under the Lab's own userData data
 * directory (`data/settings.json`) — never DicTeX's. Currently a single
 * field: the configurable path to DicTeX's data folder that the Lab reads
 * read-only (see AGENTS.md "Current Direction: DicTeX / Lab split" and
 * pivot_dictex_lab_split.md). A missing or malformed file degrades to the
 * default folder with a quiet diagnostic, never a crash.
 */
export type LabSettings = {
  dictexDataFolder: string | null;
};

export type LoadedLabSettings = {
  settings: LabSettings;
  diagnostics: string[];
};

const emptySettings: LabSettings = { dictexDataFolder: null };

export async function readLabSettings(settingsPath: string): Promise<LoadedLabSettings> {
  if (!existsSync(settingsPath)) {
    return { settings: { ...emptySettings }, diagnostics: [] };
  }

  let contents: string;
  try {
    contents = await readFile(settingsPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return { settings: { ...emptySettings }, diagnostics: [`settings.json could not be read (${message}); using defaults`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { settings: { ...emptySettings }, diagnostics: [`settings.json is not valid JSON (${message}); using defaults`] };
  }

  if (!isRecord(parsed)) {
    return { settings: { ...emptySettings }, diagnostics: ["settings.json must be a JSON object; using defaults"] };
  }

  const diagnostics: string[] = [];
  let dictexDataFolder: string | null = null;

  if (parsed.dictexDataFolder !== undefined) {
    if (typeof parsed.dictexDataFolder === "string" && parsed.dictexDataFolder.trim().length > 0) {
      dictexDataFolder = parsed.dictexDataFolder;
    } else {
      diagnostics.push('settings.json "dictexDataFolder" must be a non-empty string; ignored');
    }
  }

  return { settings: { dictexDataFolder }, diagnostics };
}

export async function writeLabSettings(settingsPath: string, settings: LabSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const payload: Record<string, unknown> = {};
  if (settings.dictexDataFolder !== null) {
    payload.dictexDataFolder = settings.dictexDataFolder;
  }
  await writeFile(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
