import {
  getSttPromptVariantDefinitions,
  getSttPromptVariants,
  type LocalEvent,
  type SttPromptVariantDefinition,
} from "@dictex/shared";

/**
 * STT prompt variant creation + listing (issue #121): named, immutable
 * `initial_prompt` variants defined in the Lab (as opposed to the existing
 * `DICTEX_STT_PROMPT_VARIANTS` env-configured ones, #93/#94). Pure validation
 * and merge logic, extracted so it is unit-testable without importing
 * electron — the IPC wiring in ./index.ts only reads/appends events and calls
 * into this module.
 */

// A variant name becomes part of the benchmark candidate `variant` string
// (see buildSttVariantId in @dictex/shared), so it is restricted to a clean
// identifier charset rather than accepting arbitrary text.
const VARIANT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SttPromptVariantCreateRequest = {
  name?: unknown;
  displayName?: unknown;
  promptText?: unknown;
};

export type SttPromptVariantListEntry = {
  name: string;
  displayName: string;
  promptText: string;
  source: "local" | "external";
  createdAt: string | null;
  /**
   * True for a local definition whose name collides with an externally
   * configured (`DICTEX_STT_PROMPT_VARIANTS`) variant introduced AFTER this
   * one was created. Creation itself always rejects a name already in use, so
   * this can only happen if the external env table changes later; the
   * external definition wins the identity (see buildSttBenchmarkCandidateCatalog
   * in ./candidateCatalog.ts), and this flag makes that shadowing visible in
   * the UI instead of silently dropping the local definition.
   */
  shadowedByExternal: boolean;
};

/** Every variant name currently in use, local or external, for uniqueness checks. */
export function collectExistingPromptVariantNames(events: LocalEvent[]): Set<string> {
  const names = new Set(Object.keys(getSttPromptVariants()));
  for (const definition of getSttPromptVariantDefinitions(events)) {
    names.add(definition.name);
  }
  return names;
}

/**
 * Validates and normalizes a renderer-supplied creation request. Throws with
 * a descriptive message on an empty/invalid id, an empty display name or
 * prompt text, or a name already used by a local or external definition — a
 * reused id is rejected outright, never silently replacing the existing
 * definition (the ticket's core immutability requirement).
 */
export function validateNewPromptVariant(
  request: SttPromptVariantCreateRequest | null | undefined,
  existingNames: ReadonlySet<string>,
): { name: string; displayName: string; promptText: string } {
  const name = typeof request?.name === "string" ? request.name.trim() : "";
  const displayName = typeof request?.displayName === "string" ? request.displayName.trim() : "";
  const promptText = typeof request?.promptText === "string" ? request.promptText.trim() : "";

  if (!VARIANT_NAME_PATTERN.test(name)) {
    throw new Error(
      "Variant id must start with a letter or digit and use only letters, digits, '.', '_' or '-'",
    );
  }
  if (displayName.length === 0) {
    throw new Error("Display name is required");
  }
  if (promptText.length === 0) {
    throw new Error("Prompt text is required");
  }
  if (existingNames.has(name)) {
    throw new Error(`A prompt variant named "${name}" already exists`);
  }

  return { name, displayName, promptText };
}

/**
 * Merges local (Lab-defined) and external (`DICTEX_STT_PROMPT_VARIANTS`)
 * prompt variant definitions into one renderer-facing list, distinguishing
 * their source so neither is mistaken for the other (external definitions
 * are read-only from the Lab's point of view — no id/name is technical here,
 * both carry a human display name and full prompt text).
 */
export function listPromptVariants(events: LocalEvent[]): SttPromptVariantListEntry[] {
  const external = getSttPromptVariants();
  const externalNames = new Set(Object.keys(external));

  const entries: SttPromptVariantListEntry[] = Object.entries(external).map(([name, promptText]) => ({
    name,
    displayName: name,
    promptText,
    source: "external",
    createdAt: null,
    shadowedByExternal: false,
  }));

  for (const definition of getSttPromptVariantDefinitions(events)) {
    entries.push({
      name: definition.name,
      displayName: definition.displayName,
      promptText: definition.promptText,
      source: "local",
      createdAt: definition.createdAt,
      shadowedByExternal: externalNames.has(definition.name),
    });
  }

  return entries;
}

/**
 * Filters local prompt variant definitions down to the ones usable as new
 * benchmark candidates: a local definition never overrides an external one
 * of the same name (see SttPromptVariantListEntry.shadowedByExternal) — the
 * external, env-configured variant always keeps the identity.
 */
export function usableLocalPromptVariants(
  localDefinitions: SttPromptVariantDefinition[],
  external: Record<string, string> = getSttPromptVariants(),
): SttPromptVariantDefinition[] {
  const externalNames = new Set(Object.keys(external));
  return localDefinitions.filter((definition) => !externalNames.has(definition.name));
}
