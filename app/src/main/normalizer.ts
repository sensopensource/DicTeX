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
 *   layer 2 — regex math-verbalization rules  (Unicode-aware, here too)
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
  /** Absolute path to the regex math-verbalization rules JSON file. */
  rulesPath: string;
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
  // Load the dictionary and rules once per run so layer application is synchronous
  // and deterministic. Layer 3 will be appended to this array in a later issue.
  const dictionary = await loadDictionary(options.dictionaryPath);
  const rules = await loadRules(options.rulesPath);

  return [
    createPersonalDictionaryLayer(dictionary.entries, dictionary.diagnostics),
    createRegexRulesLayer(rules.entries, rules.diagnostics),
  ];
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

/** One entry of the regex rules file: `pattern` (a JS regex source, Unicode-aware)
 * is matched and replaced with `replacement` (may reference capture groups via
 * `$1`, `$<name>`, ...). `flags` are additional RegExp flags on top of the
 * always-forced `g` (apply every match) and `u` (Unicode-aware `\p{...}`). */
export type RuleEntry = {
  pattern: string;
  replacement: string;
  flags?: string;
};

type CompiledRule = {
  regex: RegExp;
  replacement: string;
};

/**
 * Conservative starter set of French math-verbalization rules (layer 2, #50).
 *
 * Conventions:
 * - "au carré" / "au cube" map to the Unicode superscripts "²" / "³"; the more
 *   general "puissance n" maps to caret notation "^n" since there is no single
 *   Unicode superscript for an arbitrary exponent.
 * - "fois" maps to "×" (not "*") and "divisé par" to "/", matching the "√"
 *   already used for "racine (carrée) de".
 * - Every rule requires a real operand (a run of digits, or a single Unicode
 *   letter standing for a variable, optionally already carrying a "²"/"³"
 *   exponent from an earlier rule so e.g. "x au carré plus y" can chain into
 *   "x² + y") on each side of the keyword, and rejects a match if that operand
 *   is itself glued to a surrounding letter/digit. This is what keeps ordinary
 *   prose like "de plus en plus" untouched: "plus" only turns into "+" when it
 *   sits between two such operands.
 */
const OPERAND = "(\\d+[²³]?|\\p{L}[²³]?)";
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

export const DEFAULT_RULES: RuleEntry[] = [
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+au\\s+carr(?:é|ée)${NOT_WORD_AFTER}`,
    replacement: "$1²",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+au\\s+cube${NOT_WORD_AFTER}`,
    replacement: "$1³",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+puissance\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1^$2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}racine\\s+(?:carr(?:é|ée)\\s+)?de\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "√$1",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+[ée]gale?\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 = $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+plus\\s+grand\\s+que\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 > $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+plus\\s+petit\\s+que\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 < $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+plus\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 + $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+moins\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 - $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+fois\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 × $2",
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${OPERAND}\\s+divis[ée]e?\\s+par\\s+${OPERAND}${NOT_WORD_AFTER}`,
    replacement: "$1 / $2",
    flags: "i",
  },
];

// Bounds re-applying a single rule to its own output. A global replace only
// finds non-overlapping matches in one pass, so "1 plus 2 plus 3" would
// otherwise stop at "1 + 2 plus 3": the middle "2" is consumed as the first
// match's right operand and unavailable to start the next one. Re-running the
// same rule against its own output picks up chained same-operator expressions
// like that. The cap guards against a non-terminating custom user rule (e.g.
// one whose replacement re-matches its own pattern) looping forever.
const MAX_RULE_PASSES = 10;

function createRegexRulesLayer(rules: CompiledRule[], loadDiagnostics: string[]): NormalizationLayer {
  return {
    name: "regex_rules",
    apply: (input) => {
      let output = input;
      // Apply rules in file order, same determinism guarantee as the dictionary
      // layer, so a user reordering the file changes behavior predictably.
      for (const rule of rules) {
        for (let pass = 0; pass < MAX_RULE_PASSES; pass += 1) {
          const next = output.replace(rule.regex, rule.replacement);
          if (next === output) {
            break;
          }
          output = next;
        }
      }
      return { output, diagnostics: loadDiagnostics };
    },
  };
}

type RawRuleEntry = {
  pattern?: unknown;
  replacement?: unknown;
  flags?: unknown;
};

/**
 * Load and validate the regex rules file.
 *
 * Behavior:
 * - Missing file: the shipped default rule set applies (this layer ships usable
 *   coverage out of the box, unlike the empty-by-default personal dictionary).
 * - Unreadable / invalid JSON / wrong top-level shape: passthrough for the whole
 *   layer, with one diagnostic. Deliberately does not fall back to defaults, so
 *   a broken user edit degrades safely instead of silently keeping old rules.
 * - Individual malformed entries (missing fields, invalid regex): skipped with
 *   a diagnostic; valid entries still apply.
 */
async function loadRules(rulesPath: string): Promise<{ entries: CompiledRule[]; diagnostics: string[] }> {
  if (!existsSync(rulesPath)) {
    return { entries: compileRules(DEFAULT_RULES).entries, diagnostics: [] };
  }

  let contents: string;
  try {
    contents = await readFile(rulesPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return { entries: [], diagnostics: [`rules.json could not be read (${message}); using passthrough`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { entries: [], diagnostics: [`rules.json is not valid JSON (${message}); using passthrough`] };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return {
      entries: [],
      diagnostics: ['rules.json must be an object with a "rules" array; using passthrough'],
    };
  }

  return compileRules(parsed.rules as unknown[]);
}

function compileRules(rawRules: unknown[]): { entries: CompiledRule[]; diagnostics: string[] } {
  const entries: CompiledRule[] = [];
  const diagnostics: string[] = [];

  rawRules.forEach((rawRule: unknown, index: number) => {
    if (!isRecord(rawRule)) {
      diagnostics.push(`rule #${index + 1} is not an object; skipped`);
      return;
    }

    const { pattern, replacement, flags } = rawRule as RawRuleEntry;
    if (typeof pattern !== "string" || pattern.length === 0) {
      diagnostics.push(`rule #${index + 1} has an empty or non-string "pattern"; skipped`);
      return;
    }

    if (typeof replacement !== "string") {
      diagnostics.push(`rule #${index + 1} has a non-string "replacement"; skipped`);
      return;
    }

    if (flags !== undefined && typeof flags !== "string") {
      diagnostics.push(`rule #${index + 1} has a non-string "flags"; skipped`);
      return;
    }

    try {
      const regex = compileRuleRegex(pattern, flags);
      entries.push({ regex, replacement });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid pattern";
      diagnostics.push(`rule #${index + 1} has an invalid regex (${message}); skipped`);
    }
  });

  return { entries, diagnostics };
}

/** `g` (apply every match) and `u` (Unicode-aware `\p{...}` / lookbehind) are
 * always forced; a rule may add other flags (e.g. `i`) on top. */
function compileRuleRegex(pattern: string, flags: string | undefined): RegExp {
  const extra = Array.from(new Set((flags ?? "").split(""))).filter((flag) => flag !== "g" && flag !== "u");
  return new RegExp(pattern, ["g", "u", ...extra].join(""));
}
