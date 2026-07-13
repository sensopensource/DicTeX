import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  COMMANDS,
  COMMAND_TABLE_CONTRACT_VERSION,
  extractCommands,
  extractCommandsWithTrace,
} from "./commands.js";
import { LATEX_CANONICALIZATION_CONTRACT_VERSION } from "./latex.js";
import type { NormalizerPipelineVersion } from "./normalizerBenchmark.js";

/**
 * Text-to-text normalization pipeline (strategic pivot, Phase 2).
 *
 * Lives in `@dictex/shared` (the main-process-only `.` barrel — it imports
 * `node:fs`), so DicTeX and the Lab's dataset export replay ONE pipeline. Before
 * issue #100 this file lived in `apps/dictex/src/main`; moving it here is what
 * lets `buildSttDatasetExport` build the layer-3 training input by replaying the
 * exact same dictionary -> command extraction -> regex fold that DicTeX serves at
 * inference, instead of a second copy that could silently diverge (the train/serve
 * split #92 eliminated for command words — see
 * `docs/dataset-and-normalization-design.md` §4 and §7).
 *
 * The pipeline turns the raw literal STT transcript into normalized text before
 * it is copied/pasted. It is an ordered fold of independent layers, each taking
 * the previous layer's output as input:
 *
 *   layer 1 — personal dictionary  (deterministic substring replacement) — here
 *   command extraction — spoken commands -> inert sentinels (shared table)  — here
 *   layer 2 — regex math-verbalization rules  (Unicode-aware, here too)
 *   layer 3 — small seq2seq model                                        — later (Phase 3)
 *
 * Command extraction (issue #92) sits BETWEEN the dictionary and the regex rules,
 * exactly as the design (`docs/dataset-and-normalization-design.md` §4) requires:
 * the dictionary first canonicalises spelling variants ("retourne à la ligne" ->
 * "retour à la ligne") so the extractor matches one form, then each spoken command
 * becomes a Private Use Area sentinel that survives every downstream layer (regex
 * now, seq2seq later) untouched. The sentinel is expanded into its real action
 * (a line break, …) only at insert time, by the caller — see `expandCommands` in
 * `@dictex/shared/commands`. The `output` of this pipeline therefore MAY contain
 * sentinels; the caller MUST route it (and every stored layer string) through
 * `expandCommands` before writing it to the event log, since a sentinel must never
 * reach a store.
 *
 * Design constraints (see AGENTS.md):
 * - We must always know which layer produced a wrong output, so every layer's
 *   input/output is recorded per run and surfaced in the `normalization_result`
 *   event.
 * - Normalization must never crash or block a dictation. A missing or malformed
 *   dictionary degrades to passthrough with a quiet diagnostic.
 * - With no active layer, the output is byte-identical to the input.
 */

export type NormalizationLayerName =
  | "personal_dictionary"
  | "command_extraction"
  | "regex_rules"
  | "seq2seq_model";

/** One entry of the personal dictionary: literal `from` becomes literal `to`. */
export type DictionaryEntry = {
  id: string;
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
  /** Present only when the benchmark explicitly requests detailed tracing. */
  operations?: NormalizerOperationTrace[];
};

export type NormalizerTraceOccurrence = {
  start: number;
  end: number;
  matched_text: string;
  replacement_text?: string;
};

export type NormalizerOperationTrace =
  | {
      operation: "dictionary";
      definition_id: string;
      occurrence_count: number;
      occurrences: NormalizerTraceOccurrence[];
    }
  | {
      operation: "command";
      definition_id: string;
      debug_label: string;
      occurrence_count: number;
      occurrences: NormalizerTraceOccurrence[];
    }
  | {
      operation: "regex";
      definition_id: string;
      pass: number;
      occurrence_count: number;
      occurrences: NormalizerTraceOccurrence[];
    };

export type NormalizerSourceState = "file" | "default_absent" | "invalid" | "unreadable";

export type NormalizerIgnoredDefinition = {
  index: number | null;
  raw_json: string | null;
  diagnostic: string;
};

export type NormalizerPipelineSnapshot = {
  schema_version: 1;
  pipeline_contract_version: number;
  semantic_version: string;
  dictionary: {
    source_state: NormalizerSourceState;
    sha256: string;
    source_content: string | null;
    effective_entries: { id: string; order: number; from: string; to: string }[];
    ignored_entries: NormalizerIgnoredDefinition[];
    diagnostics: string[];
  };
  commands: {
    contract_version: number;
    sha256: string;
    definitions: {
      id: string;
      order: number;
      canonical_phrase: string;
      debug_label: string;
      effect: string;
    }[];
  };
  regex_rules: {
    source_state: NormalizerSourceState;
    sha256: string;
    source_content: string | null;
    effective_rules: {
      id: string;
      order: number;
      pattern: string;
      flags: string;
      replacement: string;
    }[];
    ignored_rules: NormalizerIgnoredDefinition[];
    diagnostics: string[];
  };
  latex_canonicalization_contract_version: number;
};

export const NORMALIZER_PIPELINE_CONTRACT_VERSION = 2;
export const NORMALIZER_PIPELINE_SEMANTIC_VERSION = "dictex-deterministic-pipeline-v2";

type LayerApplication = {
  output: string;
  diagnostics: string[];
  operations?: NormalizerOperationTrace[];
};

type NormalizationLayer = {
  name: NormalizationLayerName;
  apply: (input: string, detailedTrace: boolean) => Promise<LayerApplication> | LayerApplication;
};

export type NormalizeRuntimeOptions = { detailedTrace?: boolean };

export type NormalizeOptions = {
  /** Absolute path to the personal dictionary JSON file. */
  dictionaryPath: string;
  /** Absolute path to the regex math-verbalization rules JSON file. */
  rulesPath: string;
};

/**
 * A pipeline whose dictionary and rules have already been loaded from disk once,
 * so its `normalize` can be applied to many inputs without re-reading the config.
 * `buildSttDatasetExport` uses this to normalize every `math_transform` Layer 1
 * with a single load; DicTeX gets the same object under the hood via
 * `normalizeTranscript`, so the export input and the served text are byte-identical
 * for a given dictionary/rules pair (issue #100).
 */
export type TranscriptNormalizer = {
  /** Full SHA-256 fingerprints of the dictionary and rules loaded into this instance. */
  version: NormalizerPipelineVersion;
  pipelineSnapshot: NormalizerPipelineSnapshot;
  normalize: (input: string, options?: NormalizeRuntimeOptions) => Promise<NormalizationResult>;
};

/**
 * Build a reusable normalizer by loading the dictionary and rules once. This is
 * the single place the layer fold is assembled; both `normalizeTranscript`
 * (DicTeX's per-dictation call) and the dataset export go through it, which is
 * what guarantees they cannot diverge.
 */
export async function createTranscriptNormalizer(
  options: NormalizeOptions,
): Promise<TranscriptNormalizer> {
  const pipeline = await buildPipeline(options);
  return {
    version: pipeline.version,
    pipelineSnapshot: pipeline.snapshot,
    normalize: (input: string, runtimeOptions) =>
      runPipeline(input, pipeline.layers, runtimeOptions?.detailedTrace === true),
  };
}

/**
 * Normalize a transcript through the ordered layer pipeline.
 *
 * Never throws for expected failure modes (missing/invalid dictionary): those
 * degrade to passthrough with diagnostics. The returned result always carries
 * enough per-layer state to attribute a wrong output to a specific layer.
 *
 * Thin wrapper over `createTranscriptNormalizer` — reads the config once, then
 * normalizes one input. The export uses the same underlying pipeline for its
 * `math_transform` training input, so the two never drift.
 */
export async function normalizeTranscript(
  input: string,
  options: NormalizeOptions,
): Promise<NormalizationResult> {
  const normalizer = await createTranscriptNormalizer(options);
  return normalizer.normalize(input);
}

async function buildPipeline(
  options: NormalizeOptions,
): Promise<{
  layers: NormalizationLayer[];
  version: NormalizerPipelineVersion;
  snapshot: NormalizerPipelineSnapshot;
}> {
  // Load the dictionary and rules once per run so layer application is synchronous
  // and deterministic. Layer 3 will be appended to this array in a later issue.
  const dictionary = await loadDictionary(options.dictionaryPath);
  const rules = await loadRules(options.rulesPath);

  const commandDefinitions = COMMANDS.map((command, index) => ({
    id: command.id,
    order: index,
    canonical_phrase: command.canonical,
    debug_label: command.label,
    effect: command.effectDescription,
  }));
  const commandTableHash = hashNormalizerSource(JSON.stringify({
    version: COMMAND_TABLE_CONTRACT_VERSION,
    commands: COMMANDS.map((command) => ({
      id: command.id,
      sentinel: command.sentinel.codePointAt(0),
      canonical: command.canonical,
      expansion: command.expansion,
      label: command.label,
      effectDescription: command.effectDescription,
    })),
  }));
  const version: NormalizerPipelineVersion = {
    pipelineContractVersion: NORMALIZER_PIPELINE_CONTRACT_VERSION,
    semanticVersion: NORMALIZER_PIPELINE_SEMANTIC_VERSION,
    dictionaryHash: dictionary.sourceHash,
    commandTableHash,
    rulesHash: rules.sourceHash,
    latexCanonicalizationContractVersion: LATEX_CANONICALIZATION_CONTRACT_VERSION,
  };

  return {
    layers: [
      createPersonalDictionaryLayer(dictionary.entries, dictionary.diagnostics),
      createCommandExtractionLayer(),
      createRegexRulesLayer(rules.entries, rules.diagnostics),
    ],
    version,
    snapshot: {
      schema_version: 1,
      pipeline_contract_version: NORMALIZER_PIPELINE_CONTRACT_VERSION,
      semantic_version: NORMALIZER_PIPELINE_SEMANTIC_VERSION,
      dictionary: {
        source_state: dictionary.sourceState,
        sha256: dictionary.sourceHash,
        source_content: dictionary.sourceContent,
        effective_entries: dictionary.entries.map((entry, order) => ({ ...entry, order })),
        ignored_entries: dictionary.ignored,
        diagnostics: dictionary.diagnostics,
      },
      commands: {
        contract_version: COMMAND_TABLE_CONTRACT_VERSION,
        sha256: commandTableHash,
        definitions: commandDefinitions,
      },
      regex_rules: {
        source_state: rules.sourceState,
        sha256: rules.sourceHash,
        source_content: rules.sourceContent,
        effective_rules: rules.entries.map((rule, order) => ({
          id: rule.id,
          order,
          pattern: rule.pattern,
          flags: rule.flags,
          replacement: rule.replacement,
        })),
        ignored_rules: rules.ignored,
        diagnostics: rules.diagnostics,
      },
      latex_canonicalization_contract_version: LATEX_CANONICALIZATION_CONTRACT_VERSION,
    },
  };
}

/**
 * Command extraction layer (issue #92). Replaces each spoken command with its
 * inert sentinel, using the shared command table so DicTeX and the Lab's dataset
 * export never diverge. Runs after the personal dictionary (which canonicalises
 * spelling variants) and before the regex rules (which the sentinel passes
 * through untouched). Has no config file and never fails; the caller expands the
 * sentinel into a real action at insert time.
 */
function createCommandExtractionLayer(): NormalizationLayer {
  return {
    name: "command_extraction",
    apply: (input, detailedTrace) => {
      if (!detailedTrace) {
        return { output: extractCommands(input), diagnostics: [] };
      }
      const detailed = extractCommandsWithTrace(input);
      return {
        output: detailed.output,
        diagnostics: [],
        operations: detailed.traces.map((trace) => ({
          operation: "command" as const,
          definition_id: trace.commandId,
          debug_label: trace.debugLabel,
          occurrence_count: trace.occurrences.length,
          occurrences: trace.occurrences.map((occurrence) => ({
            start: occurrence.start,
            end: occurrence.end,
            matched_text: occurrence.matchedText,
            replacement_text: trace.debugLabel,
          })),
        })),
      };
    },
  };
}

async function runPipeline(
  input: string,
  layers: NormalizationLayer[],
  detailedTrace: boolean,
): Promise<NormalizationResult> {
  const layerOutputs: NormalizationLayerOutput[] = [];
  const diagnostics: string[] = [];
  const operations: NormalizerOperationTrace[] = [];
  let current = input;

  for (const layer of layers) {
    const layerInput = current;
    let application: LayerApplication;
    try {
      application = await layer.apply(layerInput, detailedTrace);
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
    operations.push(...(application.operations ?? []));
  }

  return {
    input,
    output: current,
    passthrough: current === input,
    layers: layerOutputs,
    diagnostics,
    ...(detailedTrace ? { operations } : {}),
  };
}

function createPersonalDictionaryLayer(
  entries: DictionaryEntry[],
  loadDiagnostics: string[],
): NormalizationLayer {
  return {
    name: "personal_dictionary",
    apply: (input, detailedTrace) => {
      let output = input;
      const operations: NormalizerOperationTrace[] = [];
      // Apply entries in file order so the transform is fully deterministic and
      // predictable for a user editing the file by hand.
      for (const entry of entries) {
        const operationInput = output;
        const occurrences = findLiteralOccurrences(operationInput, entry.from).map((occurrence) => ({
          ...occurrence,
          matched_text: entry.from,
          replacement_text: entry.to,
        }));
        output = operationInput.split(entry.from).join(entry.to);
        if (detailedTrace && occurrences.length > 0) {
          operations.push({
            operation: "dictionary",
            definition_id: entry.id,
            occurrence_count: occurrences.length,
            occurrences,
          });
        }
      }
      return { output, diagnostics: loadDiagnostics, ...(detailedTrace ? { operations } : {}) };
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
): Promise<{
  entries: DictionaryEntry[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
  sourceHash: string;
  sourceState: NormalizerSourceState;
  sourceContent: string | null;
}> {
  if (!existsSync(dictionaryPath)) {
    return {
      entries: [],
      diagnostics: [],
      ignored: [],
      sourceHash: hashNormalizerSource(DEFAULT_DICTIONARY_SOURCE),
      sourceState: "default_absent",
      sourceContent: null,
    };
  }

  let contents: string;
  try {
    contents = await readFile(dictionaryPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return {
      entries: [],
      diagnostics: [`dictionary.json could not be read (${message}); using passthrough`],
      ignored: [{ index: null, raw_json: null, diagnostic: `dictionary.json could not be read (${message})` }],
      sourceHash: hashNormalizerSource(UNREADABLE_DICTIONARY_SOURCE),
      sourceState: "unreadable",
      sourceContent: null,
    };
  }
  const sourceHash = hashNormalizerSource(contents);

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return {
      entries: [],
      diagnostics: [`dictionary.json is not valid JSON (${message}); using passthrough`],
      ignored: [{ index: null, raw_json: contents, diagnostic: `dictionary.json is not valid JSON (${message})` }],
      sourceHash,
      sourceState: "invalid",
      sourceContent: contents,
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    return {
      entries: [],
      diagnostics: ['dictionary.json must be an object with an "entries" array; using passthrough'],
      ignored: [{
        index: null,
        raw_json: safeJson(parsed),
        diagnostic: 'dictionary.json must be an object with an "entries" array',
      }],
      sourceHash,
      sourceState: "invalid",
      sourceContent: contents,
    };
  }

  const entries: DictionaryEntry[] = [];
  const diagnostics: string[] = [];
  const ignored: NormalizerIgnoredDefinition[] = [];
  const usedIds = new Set<string>();

  parsed.entries.forEach((rawEntry: unknown, index: number) => {
    if (!isRecord(rawEntry)) {
      const diagnostic = `dictionary entry #${index + 1} is not an object; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawEntry), diagnostic });
      return;
    }

    const { from, to } = rawEntry as RawDictionaryEntry;
    if (typeof from !== "string" || from.length === 0) {
      const diagnostic = `dictionary entry #${index + 1} has an empty or non-string "from"; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawEntry), diagnostic });
      return;
    }

    if (typeof to !== "string") {
      const diagnostic = `dictionary entry #${index + 1} has a non-string "to"; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawEntry), diagnostic });
      return;
    }

    entries.push({ id: stableDefinitionId("dictionary", { from, to }, usedIds), from, to });
  });

  return {
    entries,
    diagnostics,
    ignored,
    sourceHash,
    sourceState: "file",
    sourceContent: contents,
  };
}

const DEFAULT_DICTIONARY_SOURCE = JSON.stringify({ version: 1, entries: [] });
const UNREADABLE_DICTIONARY_SOURCE = "dictex:dictionary:unreadable";
const UNREADABLE_RULES_SOURCE = "dictex:rules:unreadable";

function hashNormalizerSource(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
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
  id: string;
  regex: RegExp;
  pattern: string;
  flags: string;
  replacement: string;
};

/**
 * Conservative starter set of French math-verbalization rules (layer 2, #50;
 * rewritten to emit LaTeX by #107, design in
 * `docs/dataset-and-normalization-design.md` §7-8).
 *
 * ── Delimiter convention (§8, settled by #106) ──────────────────────────────
 * Inline maths is wrapped in `$…$`; prose stays bare. Every rule below matches
 * bare French prose and emits a `$…$`-wrapped LaTeX fragment. `canonicalizeLatex`
 * (`./latex.ts`) is the single source of truth for what "canonical" means; every
 * rule here emits text that is already a fixed point of it (asserted directly in
 * `normalizer.test.ts`), so scoring/export never see the rules' output as an
 * "error" needing repair.
 *
 * ── Two operand grammars, chosen per rule (the hard part, §7/#107) ──────────
 * A regex cannot group or scope, so an operand is still a single unambiguous
 * token: a run of digits, or one Unicode letter. Two kinds of rule need
 * different treatment of "what may stand as that token":
 *
 *   - BRACING rules — "au carré/cube" (`^{2}`/`^{3}`), "puissance n" (`^{n}`),
 *     "racine (carrée) de" (`\sqrt{}`), "divisé par" (`\frac{}{}`) — introduce a
 *     NEW brace around their operand(s). Accepting an already-composed fragment
 *     here would require deciding where that fragment's scope ends inside the
 *     new braces (exactly the grouping problem regex cannot solve), so these
 *     stay OPERAND_BARE-only: one digit run or one letter, full stop. This is
 *     why, per the issue, "a divisé par b plus un" does not compose into a
 *     single fraction: "un" is two letters, not a valid bare operand, so
 *     "divisé par" only ever sees "a" and "b".
 *   - FLAT rules — "égale" (`=`), "plus/petit que" (`>`/`<`), "plus"/"moins"
 *     (`+`/`-`), "fois" (`\times`) — never add a brace; they splice two operands
 *     and an operator at the SAME brace depth (0) as their inputs. Because no
 *     new nesting is introduced, an operand here may ALSO be an entire
 *     `$…$`-wrapped fragment an earlier rule already produced (OPERAND_ANY):
 *     depth-0 tokens spliced into another depth-0 expression stay depth-0, so
 *     the composition is still a `canonicalizeLatex` fixed point. This is what
 *     keeps the chaining property alive under LaTeX: "x au carré plus y" first
 *     becomes "$x^{2}$ plus y" (bracing rule, bare operand "x"), then the FLAT
 *     "plus" rule matches operand1 = the whole wrapped fragment "$x^{2}$" and
 *     operand2 = bare "y", emitting one merged span "$x^{2} + y$".
 *
 * Every rule still requires NOT_WORD_BEFORE/NOT_WORD_AFTER around the operand,
 * unchanged from the original design: this is what keeps ordinary prose like
 * "de plus en plus" untouched ("plus" only turns into "+" between two real
 * operands), and it holds for both operand grammars since a wrapped fragment
 * always starts/ends with "$", never a letter or digit.
 */
const OPERAND_BARE = "\\d+|\\p{L}";
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

/** A single bracing-rule operand: one digit run or one letter. No `$…$`
 * fragment may stand here (see header comment — bracing rules stay bare-only). */
function operandBare(tag: string): string {
  return `(?<p${tag}>${OPERAND_BARE})`;
}

/** A flat-rule operand: either a bare token (as above) or an entire, already
 * `$…$`-wrapped fragment produced by an earlier rule (its inner content, not
 * the delimiters, is captured so it can be re-spliced into a new `$…$` span). */
function operandAny(tag: string): string {
  return `(?:\\$(?<i${tag}>[^$]+)\\$|(?<p${tag}>${OPERAND_BARE}))`;
}

/** Reference a bracing-rule operand in a replacement string. */
function refBare(tag: string): string {
  return `$<p${tag}>`;
}

/** Reference a flat-rule operand in a replacement string: exactly one of the
 * two named groups participated, so concatenating both (the other substitutes
 * as "") yields the operand's text either way. */
function refAny(tag: string): string {
  return `$<i${tag}>$<p${tag}>`;
}

export const DEFAULT_RULES: RuleEntry[] = [
  {
    // "x au carré" -> "$x^{2}$" (bracing: bare operand only).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+au\\s+carr(?:é|ée)${NOT_WORD_AFTER}`,
    replacement: `$$${refBare("1")}^{2}$$`,
    flags: "i",
  },
  {
    // "x au cube" -> "$x^{3}$" (bracing: bare operand only).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+au\\s+cube${NOT_WORD_AFTER}`,
    replacement: `$$${refBare("1")}^{3}$$`,
    flags: "i",
  },
  {
    // "x puissance n" -> "$x^{n}$" (bracing: bare operands only).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+puissance\\s+${operandBare("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refBare("1")}^{${refBare("2")}}$$`,
    flags: "i",
  },
  {
    // "racine (carrée) de x" -> "$\sqrt{x}$" (bracing: bare operand only).
    pattern: `${NOT_WORD_BEFORE}racine\\s+(?:carr(?:é|ée)\\s+)?de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$\\sqrt{${refBare("1")}}$$`,
    flags: "i",
  },
  {
    // "x égale y" -> "$x = y$" (flat: either operand may already be a "$…$" fragment).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+[ée]gale?\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} = ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x plus grand que y" -> "$x > y$" (flat).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+plus\\s+grand\\s+que\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} > ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x plus petit que y" -> "$x < y$" (flat).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+plus\\s+petit\\s+que\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} < ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x plus y" -> "$x + y$" (flat).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+plus\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} + ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x moins y" -> "$x - y$" (flat).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+moins\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} - ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x fois y" -> "$x \times y$" (flat).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+fois\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} \\times ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x divisé par y" -> "$\frac{x}{y}$" (bracing: bare operands only — this is
    // why "a divisé par b plus un" cannot compose into one fraction, per the issue).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+divis[ée]e?\\s+par\\s+${operandBare("2")}${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{${refBare("1")}}{${refBare("2")}}$$`,
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
    apply: (input, detailedTrace) => {
      let output = input;
      const operations: NormalizerOperationTrace[] = [];
      // Apply rules in file order, same determinism guarantee as the dictionary
      // layer, so a user reordering the file changes behavior predictably.
      for (const rule of rules) {
        for (let pass = 0; pass < MAX_RULE_PASSES; pass += 1) {
          const replaced = replaceWithTrace(output, rule.regex, rule.replacement);
          const next = replaced.output;
          if (detailedTrace && replaced.occurrences.length > 0) {
            operations.push({
              operation: "regex",
              definition_id: rule.id,
              pass: pass + 1,
              occurrence_count: replaced.occurrences.length,
              occurrences: replaced.occurrences,
            });
          }
          if (next === output) {
            break;
          }
          output = next;
        }
      }
      return { output, diagnostics: loadDiagnostics, ...(detailedTrace ? { operations } : {}) };
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
async function loadRules(
  rulesPath: string,
): Promise<{
  entries: CompiledRule[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
  sourceHash: string;
  sourceState: NormalizerSourceState;
  sourceContent: string | null;
}> {
  if (!existsSync(rulesPath)) {
    const compiled = compileRules(DEFAULT_RULES);
    return {
      ...compiled,
      sourceHash: hashNormalizerSource(JSON.stringify({ version: 1, rules: DEFAULT_RULES })),
      sourceState: "default_absent",
      sourceContent: null,
    };
  }

  let contents: string;
  try {
    contents = await readFile(rulesPath, { encoding: "utf8" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    return {
      entries: [],
      diagnostics: [`rules.json could not be read (${message}); using passthrough`],
      ignored: [{ index: null, raw_json: null, diagnostic: `rules.json could not be read (${message})` }],
      sourceHash: hashNormalizerSource(UNREADABLE_RULES_SOURCE),
      sourceState: "unreadable",
      sourceContent: null,
    };
  }
  const sourceHash = hashNormalizerSource(contents);

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return {
      entries: [],
      diagnostics: [`rules.json is not valid JSON (${message}); using passthrough`],
      ignored: [{ index: null, raw_json: contents, diagnostic: `rules.json is not valid JSON (${message})` }],
      sourceHash,
      sourceState: "invalid",
      sourceContent: contents,
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return {
      entries: [],
      diagnostics: ['rules.json must be an object with a "rules" array; using passthrough'],
      ignored: [{
        index: null,
        raw_json: safeJson(parsed),
        diagnostic: 'rules.json must be an object with a "rules" array',
      }],
      sourceHash,
      sourceState: "invalid",
      sourceContent: contents,
    };
  }

  return {
    ...compileRules(parsed.rules as unknown[]),
    sourceHash,
    sourceState: "file",
    sourceContent: contents,
  };
}

function compileRules(rawRules: readonly unknown[]): {
  entries: CompiledRule[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
} {
  const entries: CompiledRule[] = [];
  const diagnostics: string[] = [];
  const ignored: NormalizerIgnoredDefinition[] = [];
  const usedIds = new Set<string>();

  rawRules.forEach((rawRule: unknown, index: number) => {
    if (!isRecord(rawRule)) {
      const diagnostic = `rule #${index + 1} is not an object; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawRule), diagnostic });
      return;
    }

    const { pattern, replacement, flags } = rawRule as RawRuleEntry;
    if (typeof pattern !== "string" || pattern.length === 0) {
      const diagnostic = `rule #${index + 1} has an empty or non-string "pattern"; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawRule), diagnostic });
      return;
    }

    if (typeof replacement !== "string") {
      const diagnostic = `rule #${index + 1} has a non-string "replacement"; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawRule), diagnostic });
      return;
    }

    if (flags !== undefined && typeof flags !== "string") {
      const diagnostic = `rule #${index + 1} has a non-string "flags"; skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawRule), diagnostic });
      return;
    }

    try {
      const regex = compileRuleRegex(pattern, flags);
      const normalizedFlags = regex.flags;
      entries.push({
        id: stableDefinitionId("regex", { pattern, flags: normalizedFlags, replacement }, usedIds),
        regex,
        pattern,
        flags: normalizedFlags,
        replacement,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid pattern";
      const diagnostic = `rule #${index + 1} has an invalid regex (${message}); skipped`;
      diagnostics.push(diagnostic);
      ignored.push({ index, raw_json: safeJson(rawRule), diagnostic });
    }
  });

  return { entries, diagnostics, ignored };
}

/** `g` (apply every match) and `u` (Unicode-aware `\p{...}` / lookbehind) are
 * always forced; a rule may add other flags (e.g. `i`) on top. */
function compileRuleRegex(pattern: string, flags: string | undefined): RegExp {
  const extra = Array.from(new Set((flags ?? "").split(""))).filter((flag) => flag !== "g" && flag !== "u");
  return new RegExp(pattern, ["g", "u", ...extra].join(""));
}

function findLiteralOccurrences(input: string, literal: string): { start: number; end: number }[] {
  const occurrences: { start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor <= input.length - literal.length) {
    const start = input.indexOf(literal, cursor);
    if (start < 0) {
      break;
    }
    occurrences.push({ start, end: start + literal.length });
    cursor = start + literal.length;
  }
  return occurrences;
}

function replaceWithTrace(
  input: string,
  regex: RegExp,
  replacementTemplate: string,
): { output: string; occurrences: NormalizerTraceOccurrence[] } {
  const occurrences: NormalizerTraceOccurrence[] = [];
  const output = input.replace(regex, (...args: unknown[]) => {
    const matchedText = String(args[0]);
    const maybeGroups = args[args.length - 1];
    const hasNamedGroups = typeof maybeGroups === "object" && maybeGroups !== null;
    const offsetIndex = hasNamedGroups ? args.length - 3 : args.length - 2;
    const offset = args[offsetIndex] as number;
    const captures = args.slice(1, offsetIndex).map((capture) =>
      typeof capture === "string" ? capture : undefined,
    );
    const groups = hasNamedGroups ? (maybeGroups as Record<string, string | undefined>) : undefined;
    const replacementText = expandReplacementTemplate(
      replacementTemplate,
      matchedText,
      captures,
      groups,
      offset,
      input,
    );
    occurrences.push({
      start: offset,
      end: offset + matchedText.length,
      matched_text: matchedText,
      replacement_text: replacementText,
    });
    return replacementText;
  });
  return { output, occurrences };
}

/** Mirrors JavaScript replacement-string tokens while allowing us to record the
 * exact fragment emitted by each regex hit. */
function expandReplacementTemplate(
  template: string,
  match: string,
  captures: (string | undefined)[],
  groups: Record<string, string | undefined> | undefined,
  offset: number,
  input: string,
): string {
  let output = "";
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (char !== "$" || index + 1 >= template.length) {
      output += char;
      continue;
    }
    const next = template[index + 1];
    if (next === "$") {
      output += "$";
      index += 1;
    } else if (next === "&") {
      output += match;
      index += 1;
    } else if (next === "`") {
      output += input.slice(0, offset);
      index += 1;
    } else if (next === "'") {
      output += input.slice(offset + match.length);
      index += 1;
    } else if (next === "<" && groups) {
      const close = template.indexOf(">", index + 2);
      if (close >= 0) {
        const name = template.slice(index + 2, close);
        output += groups[name] ?? "";
        index = close;
      } else {
        output += "$";
      }
    } else if (/\d/.test(next)) {
      const second = template[index + 2];
      const twoDigit = second && /\d/.test(second) ? Number(`${next}${second}`) : 0;
      const oneDigit = Number(next);
      if (twoDigit > 0 && twoDigit <= captures.length) {
        output += captures[twoDigit - 1] ?? "";
        index += 2;
      } else if (oneDigit > 0 && oneDigit <= captures.length) {
        output += captures[oneDigit - 1] ?? "";
        index += 1;
      } else {
        output += "$";
      }
    } else {
      output += "$";
    }
  }
  return output;
}

function stableDefinitionId(prefix: string, definition: unknown, usedIds: Set<string>): string {
  const digest = hashNormalizerSource(JSON.stringify(definition)).slice(0, 16);
  const base = `${prefix}_${digest}`;
  let id = base;
  for (let suffix = 2; usedIds.has(id); suffix += 1) {
    id = `${base}_${suffix}`;
  }
  usedIds.add(id);
  return id;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
