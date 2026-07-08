import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Text-to-text normalization pipeline (strategic pivot, Phase 2).
 *
 * The pipeline turns the raw literal STT transcript into normalized text before
 * it is copied/pasted. It is an ordered fold of independent layers, each taking
 * the previous layer's output as input:
 *
 *   layer 1 — personal dictionary  (deterministic substring replacement) — here
 *   layer 2 — regex math-verbalization rules                             — later (#50)
 *   layer 3 — small seq2seq model                                        — later (Phase 3)
 *
 * Design constraints (see AGENTS.md):
 * - We must always know which layer produced a wrong output, so every layer's
 *   input/output is recorded per run and surfaced in the `normalization_result`
 *   event.
 * - Normalization must never crash or block a dictation. A missing or malformed
 *   dictionary degrades to passthrough with a quiet diagnostic.
 * - With no active layer, the output is byte-identical to the input.
 */

export type NormalizationLayerName = "personal_dictionary" | "regex_rules" | "seq2seq_model";

/** One entry of the personal dictionary: literal `from` becomes literal `to`. */
export type DictionaryEntry = {
  from: string;
  to: string;
};

/** Result of applying a single layer, recorded for per-layer attribution. */
export type NormalizationLayerOutput = {
  layer: NormalizationLayerName;
  input: string;
  output: string;
  /** True when the layer changed the text (output !== input). */
  applied: boolean;
  /** Quiet, non-fatal diagnostics produced while running the layer. */
  diagnostics: string[];
};

export type NormalizationResult = {
  input: string;
  output: string;
  /** True when no layer changed the text (output is byte-identical to input). */
  passthrough: boolean;
  /** Per-layer outputs, in application order. */
  layers: NormalizationLayerOutput[];
  /** Flattened diagnostics across all layers, for a single visible-but-quiet surface. */
  diagnostics: string[];
};

type LayerApplication = {
  output: string;
  diagnostics: string[];
};

type NormalizationLayer = {
  name: NormalizationLayerName;
  apply: (input: string) => Promise<LayerApplication> | LayerApplication;
};

export type NormalizeOptions = {
  /** Absolute path to the personal dictionary JSON file. */
  dictionaryPath: string;
};

/**
 * Normalize a transcript through the ordered layer pipeline.
 *
 * Never throws for expected failure modes (missing/invalid dictionary): those
 * degrade to passthrough with diagnostics. The returned result always carries
 * enough per-layer state to attribute a wrong output to a specific layer.
 */
export async function normalizeTranscript(
  input: string,
  options: NormalizeOptions,
): Promise<NormalizationResult> {
  const layers = await buildPipeline(options);
  return runPipeline(input, layers);
}

async function buildPipeline(options: NormalizeOptions): Promise<NormalizationLayer[]> {
  // Load the dictionary once per run so the layer application is synchronous and
  // deterministic. Layers 2 and 3 will be appended to this array in later issues.
  const dictionary = await loadDictionary(options.dictionaryPath);

  return [createPersonalDictionaryLayer(dictionary.entries, dictionary.diagnostics)];
}

async function runPipeline(input: string, layers: NormalizationLayer[]): Promise<NormalizationResult> {
  const layerOutputs: NormalizationLayerOutput[] = [];
  const diagnostics: string[] = [];
  let current = input;

  for (const layer of layers) {
    const layerInput = current;
    let application: LayerApplication;
    try {
      application = await layer.apply(layerInput);
    } catch (error) {
      // A layer must never break the dictation path; treat an unexpected failure
      // as a passthrough for that layer and record why.
      const message = error instanceof Error ? error.message : "layer failed";
      application = { output: layerInput, diagnostics: [`${layer.name}: ${message}`] };
    }

    current = application.output;
    layerOutputs.push({
      layer: layer.name,
      input: layerInput,
      output: application.output,
      applied: application.output !== layerInput,
      diagnostics: application.diagnostics,
    });
    diagnostics.push(...application.diagnostics);
  }

  return {
    input,
    output: current,
    passthrough: current === input,
    layers: layerOutputs,
    diagnostics,
  };
}

function createPersonalDictionaryLayer(
  entries: DictionaryEntry[],
  loadDiagnostics: string[],
): NormalizationLayer {
  return {
    name: "personal_dictionary",
    apply: (input) => {
      let output = input;
      // Apply entries in file order so the transform is fully deterministic and
      // predictable for a user editing the file by hand.
      for (const entry of entries) {
        output = output.split(entry.from).join(entry.to);
      }
      return { output, diagnostics: loadDiagnostics };
    },
  };
}

type RawDictionaryEntry = {
  from?: unknown;
  to?: unknown;
};

/**
 * Load and validate the personal dictionary.
 *
 * Behavior:
 * - Missing file: passthrough, no diagnostic (an empty dictionary is the normal
 *   default, not an error).
 * - Unreadable / invalid JSON / wrong top-level shape: passthrough for the whole
 *   layer, with one diagnostic.
 * - Individual malformed entries: skipped with a diagnostic; valid entries still
 *   apply.
 */
async function loadDictionary(
  dictionaryPath: string,
): Promise<{ entries: DictionaryEntry[]; diagnostics: string[] }> {
  if (!existsSync(dictionaryPath)) {
    return { entries: [], diagnostics: [] };
  }

  let contents: string;
  try {
    contents = await readFile(dictionaryPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return { entries: [], diagnostics: [`dictionary.json could not be read (${message}); using passthrough`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { entries: [], diagnostics: [`dictionary.json is not valid JSON (${message}); using passthrough`] };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    return {
      entries: [],
      diagnostics: ['dictionary.json must be an object with an "entries" array; using passthrough'],
    };
  }

  const entries: DictionaryEntry[] = [];
  const diagnostics: string[] = [];

  parsed.entries.forEach((rawEntry: unknown, index: number) => {
    if (!isRecord(rawEntry)) {
      diagnostics.push(`dictionary entry #${index + 1} is not an object; skipped`);
      return;
    }

    const { from, to } = rawEntry as RawDictionaryEntry;
    if (typeof from !== "string" || from.length === 0) {
      diagnostics.push(`dictionary entry #${index + 1} has an empty or non-string "from"; skipped`);
      return;
    }

    if (typeof to !== "string") {
      diagnostics.push(`dictionary entry #${index + 1} has a non-string "to"; skipped`);
      return;
    }

    entries.push({ from, to });
  });

  return { entries, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
