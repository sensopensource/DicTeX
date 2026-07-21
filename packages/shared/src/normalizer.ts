import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
export type NormalizerOverlaySourceState = "absent" | "file" | "invalid" | "unreadable";
export type NormalizerRulesMode = "bundled" | "overlay" | "legacy";
export type NormalizerRulesConfigurationState =
  | "bundled"
  | "current_overlay"
  | "legacy_file"
  | "migration_required"
  | "ambiguous"
  | "invalid";

export type NormalizerRulesConfiguration = {
  mode: NormalizerRulesMode;
  state: NormalizerRulesConfigurationState;
  bundledVersion: number;
  bundledHash: string;
  bundledRuleCount: number;
  overlayPath: string;
  overlayState: NormalizerOverlaySourceState;
  overlayHash: string | null;
  legacyPath: string;
  legacyVersion: number | null;
  legacyHash: string | null;
  personalRuleCount: number;
  effectiveRuleCount: number;
  effectiveHash: string;
  recognizedBundledRuleCount: number;
  ambiguityCount: number;
  invalidRuleCount: number;
  warning: string | null;
  diagnostics: string[];
};

export type NormalizerIgnoredDefinition = {
  index: number | null;
  raw_json: string | null;
  diagnostic: string;
};

export type NormalizerPipelineSnapshot = {
  schema_version: 1 | 2;
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
    /** Added by #150. Absent on historical schema-1 snapshots. */
    bundled_version?: number;
    bundled_sha256?: string;
    overlay_source_state?: NormalizerOverlaySourceState;
    overlay_sha256?: string | null;
    legacy_source_sha256?: string | null;
    configuration_mode?: NormalizerRulesMode;
  };
  latex_canonicalization_contract_version: number;
};

export const NORMALIZER_PIPELINE_CONTRACT_VERSION = 3;
export const NORMALIZER_PIPELINE_SEMANTIC_VERSION = "dictex-deterministic-pipeline-v10";
export const DEFAULT_RULES_CONFIG_VERSION = 8;
export const PERSONAL_RULES_OVERLAY_VERSION = 1;
export const PERSONAL_RULES_OVERLAY_FILENAME = "rules-overlay.json";

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
  /** Absolute path to the personal overlay. Defaults beside rulesPath. */
  rulesOverlayPath?: string;
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
  rulesConfiguration: NormalizerRulesConfiguration;
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
    rulesConfiguration: pipeline.rulesConfiguration,
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
  rulesConfiguration: NormalizerRulesConfiguration;
}> {
  // Load the dictionary and rules once per run so layer application is synchronous
  // and deterministic. Layer 3 will be appended to this array in a later issue.
  const dictionary = await loadDictionary(options.dictionaryPath);
  const rules = await loadRules(options.rulesPath, resolveRulesOverlayPath(options));

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
    bundledRulesVersion: rules.configuration.bundledVersion,
    bundledRulesHash: rules.configuration.bundledHash,
    rulesMode: rules.configuration.mode,
    overlayHash: rules.configuration.overlayHash,
    localRulesHash: rules.configuration.overlayHash ?? rules.configuration.legacyHash,
  };

  return {
    layers: [
      createPersonalDictionaryLayer(dictionary.entries, dictionary.diagnostics),
      createCommandExtractionLayer(),
      createRegexRulesLayer(rules.entries, rules.diagnostics),
    ],
    version,
    snapshot: {
      schema_version: 2,
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
        bundled_version: rules.configuration.bundledVersion,
        bundled_sha256: rules.configuration.bundledHash,
        overlay_source_state: rules.configuration.overlayState,
        overlay_sha256: rules.configuration.overlayHash,
        legacy_source_sha256: rules.configuration.legacyHash,
        configuration_mode: rules.configuration.mode,
      },
      latex_canonicalization_contract_version: LATEX_CANONICALIZATION_CONTRACT_VERSION,
    },
    rulesConfiguration: rules.configuration,
  };
}

export function resolveRulesOverlayPath(options: NormalizeOptions): string {
  return options.rulesOverlayPath ?? path.join(path.dirname(options.rulesPath), PERSONAL_RULES_OVERLAY_FILENAME);
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

export type BundledRuleDefinition = RuleEntry & {
  /** Stable semantic identity. It never changes when the definition changes. */
  id: string;
  /** Explicit application order inside the bundled set. */
  order: number;
};

export type PersonalRuleOverlay = {
  version: typeof PERSONAL_RULES_OVERLAY_VERSION;
  bundled_rules_version: number;
  disabled_rule_ids: string[];
  replacements: Array<RuleEntry & { rule_id: string }>;
  personal_rules: Array<RuleEntry & { id: string; order: number }>;
};

type CompiledRule = {
  id: string;
  regex: RegExp;
  pattern: string;
  flags: string;
  replacement: string;
};

/**
 * Historical v2 atomic set of French math-verbalization rules (layer 2, #50;
 * rewritten to emit LaTeX by #107 and extended by #148, design in
 * `docs/dataset-and-normalization-design.md` §7-8).
 *
 * ── Delimiter convention (§8, settled by #106) ──────────────────────────────
 * Inline maths is wrapped in `$…$`; prose stays bare. Every rule below matches
 * bare French prose and emits a `$…$`-wrapped LaTeX fragment. `canonicalizeLatex`
 * (`./latex.ts`) is the single source of truth for what "canonical" means. Most
 * rules emit a fixed point directly. The spoken `inférieur ou égal à` and
 * `supérieur ou égal à` rules intentionally emit the product-level aliases
 * `\le` and `\ge`; `canonicalizeLatex` folds them to the canonical `\leq` and
 * `\geq` spellings before scoring/export. Both the raw rule output and its
 * canonical target are asserted directly in `normalizer.test.ts`.
 *
 * ── Two operand grammars, chosen per rule (the hard part, §7/#107) ──────────
 * A regex cannot group or scope, so an operand is still a single unambiguous
 * token: a run of digits, or one Unicode letter. Two kinds of rule need
 * different treatment of "what may stand as that token":
 *
 *   - BRACING rules — "au carré/cube" (`^{2}`/`^{3}`), "puissance n" (`^{n}`),
 *     "racine (carrée) de" (`\sqrt{}`), atomic functions, "sur" and
 *     "divisé par" (`\frac{}{}`) — introduce a
 *     NEW brace around their operand(s). Accepting an already-composed fragment
 *     here would require deciding where that fragment's scope ends inside the
 *     new braces (exactly the grouping problem regex cannot solve), so these
 *     stay OPERAND_BARE-only: one digit run or one letter, full stop. This is
 *     why "a divisé par b plus un" can become `a / b + 1` but never
 *     `a / (b + 1)`: the fraction rule only ever sees the atomic "a" and "b".
 *   - FLAT rules — "égale" (`=`), comparison synonyms (`>`/`<`),
 *     "plus"/"moins" (`+`/`-`), "fois"/"multiplié par" (`\times`) — never add
 *     a brace; they splice two operands
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
 * The bare atom now also admits signed digit runs and the explicitly mapped
 * Greek macro names (`\theta`, `\rho`, and the rest of the lowercase alphabet —
 * DEC-COUCHE1-003, #178). Their spoken aliases, and French number words
 * zero through twenty, are converted only while another operand and a known
 * construction are present; the generated contextual rules below never rewrite
 * a standalone word. Every structural rule still requires
 * NOT_WORD_BEFORE/NOT_WORD_AFTER around the operand: this keeps ordinary prose
 * like "de plus en plus" untouched.
 */
// The full lowercase Greek alphabet as bare operands, each spelled exactly like
// its LaTeX macro (DEC-COUCHE1-003). `omicron` is excluded on purpose: base
// LaTeX has no `\omicron` macro (the letter is written with a Latin `o`), so
// admitting it would break the "identical to the macro name" rule. None of
// these names is a prefix of another, so the alternation order is irrelevant.
const HISTORICAL_GREEK_LATEX_NAMES = "theta|rho";
const GREEK_LATEX_NAMES =
  "alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|" +
  "mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega";
function buildOperandBarePattern(greekLatexNames: string): string {
  return `-?\\d+|\\\\(?:${greekLatexNames})|\\p{L}`;
}
const HISTORICAL_OPERAND_BARE = buildOperandBarePattern(HISTORICAL_GREEK_LATEX_NAMES);
const OPERAND_BARE = buildOperandBarePattern(GREEK_LATEX_NAMES);
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const NOT_SPOKEN_ALIAS_BEFORE = `${NOT_WORD_BEFORE}(?<!\\\\)`;
const NOT_SPOKEN_ALIAS_AFTER = "(?![-\\p{L}\\p{N}])";

/** A single bracing-rule operand: one signed digit run, one letter, or one
 * explicitly mapped Greek macro. No `$…$`
 * fragment may stand here (see header comment — bracing rules stay bare-only). */
function operandBare(tag: string, operandPattern = OPERAND_BARE): string {
  return `(?<p${tag}>${operandPattern})`;
}

/** A flat-rule operand: either a bare token (as above) or an entire, already
 * `$…$`-wrapped fragment produced by an earlier rule (its inner content, not
 * the delimiters, is captured so it can be re-spliced into a new `$…$` span). */
function operandAny(tag: string, operandPattern = OPERAND_BARE): string {
  return `(?:\\$(?<i${tag}>[^$]+)\\$|(?<p${tag}>${operandPattern}))`;
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

const FRENCH_NUMBER_ATOMS = [
  ["zéro", "0"],
  ["un", "1"],
  ["deux", "2"],
  ["trois", "3"],
  ["quatre", "4"],
  ["cinq", "5"],
  ["six", "6"],
  ["sept", "7"],
  ["huit", "8"],
  ["neuf", "9"],
  ["dix", "10"],
  ["onze", "11"],
  ["douze", "12"],
  ["treize", "13"],
  ["quatorze", "14"],
  ["quinze", "15"],
  ["seize", "16"],
  ["dix-sept", "17"],
  ["dix-huit", "18"],
  ["dix-neuf", "19"],
  ["vingt", "20"],
] as const;

const GREEK_ATOMS = [
  ["theta", "\\theta"],
  ["rho", "\\rho"],
] as const;

const SPOKEN_ATOM_ALIASES = [...FRENCH_NUMBER_ATOMS, ...GREEK_ATOMS] as const;
const SPOKEN_ATOM_PATTERN = SPOKEN_ATOM_ALIASES
  .map(([spoken]) => escapeRegex(spoken))
  .sort((left, right) => right.length - left.length)
  .join("|");
function buildPendingAtomPattern(operandPattern: string): string {
  return `(?:moins\\s+)?(?:${SPOKEN_ATOM_PATTERN})|(?:${operandPattern})|\\$[^$]+\\$`;
}
const V2_BINARY_SPOKEN_OPERATOR = [
  "divis[ée]e?\\s+par",
  "multipli[ée]e?\\s+par",
  "plus\\s+grand\\s+que",
  "plus\\s+petit\\s+que",
  "supérieur\\s+à",
  "inférieur\\s+à",
  "[ée]gale?",
  "sur",
  "plus",
  "moins",
  "fois",
].join("|");
const V3_BINARY_SPOKEN_OPERATOR = [
  "divis[ée]e?\\s+par",
  "multipli[ée]e?\\s+par",
  "plus\\s+grand\\s+que",
  "plus\\s+petit\\s+que",
  "supérieure?\\s+à",
  "inférieure?\\s+à",
  "[ée]gale?",
  "sur",
  "plus",
  "moins",
  "fois",
].join("|");
const BINARY_SPOKEN_OPERATOR = [
  "divis[ée]e?\\s+par",
  "multipli[ée]e?\\s+par",
  "plus\\s+grand\\s+que",
  "plus\\s+petit\\s+que",
  "supérieure?\\s+ou\\s+[ée]gale?\\s+à",
  "inférieure?\\s+ou\\s+[ée]gale?\\s+à",
  "strictement\\s+supérieure?\\s+à",
  "strictement\\s+inférieure?\\s+à",
  "supérieure?\\s+à",
  "inférieure?\\s+à",
  "(?:est\\s+)?[ée]gale?(?:\\s+à)?",
  "sur",
  "plus",
  "moins",
  "fois",
].join("|");
const V3_FUNCTION_SPOKEN_PREFIX = `(?:sinus\\s+de|cosinus\\s+de|logarithme\\s+naturel\\s+de|\\p{L}\\s+de)`;
const FUNCTION_SPOKEN_PREFIX = `(?:sinus\\s+de|cosinus\\s+de|logarithme\\s+(?:naturel\\s+)?de|\\p{L}\\s+de)`;
function buildPreservedOperandPattern(operandPattern: string): string {
  return `(?:\\$[^$]+\\$|(?:${operandPattern}))`;
}
const PRESERVED_OPERAND = buildPreservedOperandPattern(OPERAND_BARE);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Spoken atom aliases are converted only when the whole surrounding construct
 * already has another valid (or pending) atomic operand. This is what keeps
 * ordinary prose such as "il reste trois exemples" byte-identical: a number
 * word is never normalized on its own.
 *
 * The left-side pass accepts a pending spoken atom on the right, then the
 * right-side pass resolves it once the left side is valid. Thus "un sur deux"
 * composes without a general number parser or a combinatorial rule table.
 */
function buildSpokenAtomRules(
  binarySpokenOperator = BINARY_SPOKEN_OPERATOR,
  functionSpokenPrefix = FUNCTION_SPOKEN_PREFIX,
  operandPattern = OPERAND_BARE,
): RuleEntry[] {
  const pendingAtom = buildPendingAtomPattern(operandPattern);
  const preservedOperand = buildPreservedOperandPattern(operandPattern);
  const leftRules = SPOKEN_ATOM_ALIASES.map(([spoken, latex]) => ({
    pattern:
      `${NOT_SPOKEN_ALIAS_BEFORE}${escapeRegex(spoken)}\\s+` +
      `(?<spokenOperator>${binarySpokenOperator})\\s+` +
      `(?<followingAtom>${pendingAtom})${NOT_WORD_AFTER}`,
    replacement: `${latex} $<spokenOperator> $<followingAtom>`,
    flags: "i",
  }));

  const rightRules = SPOKEN_ATOM_ALIASES.map(([spoken, latex]) => ({
    pattern:
      `${NOT_WORD_BEFORE}(?:(?<binaryPrefix>${preservedOperand}\\s+(?:${binarySpokenOperator}))|` +
      `(?<functionPrefix>${functionSpokenPrefix}))\\s+` +
      `(?<unaryMinus>moins\\s+)?${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
    replacement: `$<binaryPrefix>$<functionPrefix> $<unaryMinus>${latex}`,
    flags: "i",
  }));

  return [
    ...leftRules,
    ...rightRules,
    {
      // "moins trois sur x" -> "-3 sur x", but "moins trois" alone stays prose.
      pattern:
        `${NOT_WORD_BEFORE}moins\\s+(?<negativeAtom>\\d+)\\s+` +
        `(?<spokenOperator>${binarySpokenOperator})\\s+` +
        `(?<followingAtom>${preservedOperand})${NOT_WORD_AFTER}`,
      replacement: `-$<negativeAtom> $<spokenOperator> $<followingAtom>`,
      flags: "i",
    },
    {
      // "x supérieur à moins trois" -> "x supérieur à -3".
      pattern:
        `${NOT_WORD_BEFORE}(?<precedingAtom>${preservedOperand})\\s+` +
        `(?<spokenOperator>${binarySpokenOperator})\\s+moins\\s+` +
        `(?<negativeAtom>\\d+)${NOT_WORD_AFTER}`,
      replacement: `$<precedingAtom> $<spokenOperator> -$<negativeAtom>`,
      flags: "i",
    },
    {
      // "sinus de moins trois" -> "sinus de -3".
      pattern:
        `${NOT_WORD_BEFORE}(?<functionPrefix>${functionSpokenPrefix})\\s+moins\\s+` +
        `(?<negativeAtom>\\d+)${NOT_WORD_AFTER}`,
      replacement: `$<functionPrefix> -$<negativeAtom>`,
      flags: "i",
    },
  ];
}

function buildV2Rules(
  operandPattern: string,
  binarySpokenOperator = BINARY_SPOKEN_OPERATOR,
): RuleEntry[] {
  const operandBare = (tag: string) => `(?<p${tag}>${operandPattern})`;
  const operandAny = (tag: string) =>
    `(?:\\$(?<i${tag}>[^$]+)\\$|(?<p${tag}>${operandPattern}))`;
  return [
  ...buildSpokenAtomRules(binarySpokenOperator, FUNCTION_SPOKEN_PREFIX, operandPattern),
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
    // "sinus de x" -> "$\sin(x)$" (atomic argument only).
    pattern: `${NOT_WORD_BEFORE}sinus\\s+de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$\\sin(${refBare("1")})$$`,
    flags: "i",
  },
  {
    // "cosinus de x" -> "$\cos(x)$" (atomic argument only).
    pattern: `${NOT_WORD_BEFORE}cosinus\\s+de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$\\cos(${refBare("1")})$$`,
    flags: "i",
  },
  {
    // "logarithme naturel de x" -> "$\ln(x)$" (atomic argument only).
    pattern: `${NOT_WORD_BEFORE}logarithme\\s+naturel\\s+de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$\\ln(${refBare("1")})$$`,
    flags: "i",
  },
  {
    // "f de x" -> "$f(x)$" (one-letter function and atomic argument only).
    pattern:
      `${NOT_WORD_BEFORE}(?<functionName>\\p{L})\\s+de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$$<functionName>(${refBare("1")})$$`,
    flags: "i",
  },
  {
    // "x sur y" -> "$\frac{x}{y}$" (bracing: atomic operands only).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+sur\\s+${operandBare("2")}${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{${refBare("1")}}{${refBare("2")}}$$`,
    flags: "i",
  },
  {
    // "x divisé par y" -> "$\frac{x}{y}$" (bracing: atomic operands only).
    pattern: `${NOT_WORD_BEFORE}${operandBare("1")}\\s+divis[ée]e?\\s+par\\s+${operandBare("2")}${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{${refBare("1")}}{${refBare("2")}}$$`,
    flags: "i",
  },
  {
    // "x multiplié par y" -> "$x \times y$" (flat, before comparisons/equality).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+multipli[ée]e?\\s+par\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} \\times ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x fois y" -> "$x \times y$" (flat, before comparisons/equality).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+fois\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} \\times ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // Addition/subtraction are internal operations and therefore run before
    // equality/comparison, allowing "v égal d plus t" to compose locally.
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+plus\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} + ${refAny("2")}$$`,
    flags: "i",
  },
  {
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+moins\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} - ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // "x égale y" -> "$x = y$" (flat, after internal operations).
    pattern: `${NOT_WORD_BEFORE}${operandAny("1")}\\s+[ée]gale?\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} = ${refAny("2")}$$`,
    flags: "i",
  },
  {
    // Historical and new synonyms for strict comparisons.
    pattern:
      `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
      `(?:plus\\s+grand\\s+que|supérieur\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} > ${refAny("2")}$$`,
    flags: "i",
  },
  {
    pattern:
      `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
      `(?:plus\\s+petit\\s+que|inférieur\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} < ${refAny("2")}$$`,
    flags: "i",
  },
  ];
}

const HISTORICAL_V2_RULES = buildV2Rules(
  HISTORICAL_OPERAND_BARE,
  V2_BINARY_SPOKEN_OPERATOR,
);

/**
 * These ids are intentionally hand-authored, not derived from a pattern,
 * replacement or alias. A future edit to a definition must keep the same id so
 * personal disable/replace directives continue to target it.
 */
const SPOKEN_ATOM_RULE_IDS = [
  "spoken-atom-left-zero", "spoken-atom-left-un", "spoken-atom-left-deux",
  "spoken-atom-left-trois", "spoken-atom-left-quatre", "spoken-atom-left-cinq",
  "spoken-atom-left-six", "spoken-atom-left-sept", "spoken-atom-left-huit",
  "spoken-atom-left-neuf", "spoken-atom-left-dix", "spoken-atom-left-onze",
  "spoken-atom-left-douze", "spoken-atom-left-treize", "spoken-atom-left-quatorze",
  "spoken-atom-left-quinze", "spoken-atom-left-seize", "spoken-atom-left-dix-sept",
  "spoken-atom-left-dix-huit", "spoken-atom-left-dix-neuf", "spoken-atom-left-vingt",
  "spoken-atom-left-theta", "spoken-atom-left-rho",
  "spoken-atom-right-zero", "spoken-atom-right-un", "spoken-atom-right-deux",
  "spoken-atom-right-trois", "spoken-atom-right-quatre", "spoken-atom-right-cinq",
  "spoken-atom-right-six", "spoken-atom-right-sept", "spoken-atom-right-huit",
  "spoken-atom-right-neuf", "spoken-atom-right-dix", "spoken-atom-right-onze",
  "spoken-atom-right-douze", "spoken-atom-right-treize", "spoken-atom-right-quatorze",
  "spoken-atom-right-quinze", "spoken-atom-right-seize", "spoken-atom-right-dix-sept",
  "spoken-atom-right-dix-huit", "spoken-atom-right-dix-neuf", "spoken-atom-right-vingt",
  "spoken-atom-right-theta", "spoken-atom-right-rho",
] as const;

/** Stable ids are deliberately separate from pattern/replacement content. */
const V2_RULE_IDS = [
  ...SPOKEN_ATOM_RULE_IDS,
  "spoken-negative-left",
  "spoken-negative-right",
  "spoken-negative-function",
  "power-square",
  "power-cube",
  "power-explicit",
  "root-square",
  "function-sine",
  "function-cosine",
  "function-natural-log",
  "function-application",
  "fraction-over",
  "fraction-divided-by",
  "multiply-by",
  "multiply-times",
  "addition",
  "subtraction",
  "equality",
  "comparison-greater",
  "comparison-less",
] as const;

if (V2_RULE_IDS.length !== HISTORICAL_V2_RULES.length) {
  throw new Error("Bundled rule ids must stay aligned with the bundled rule definitions");
}

type IdentifiedRule = RuleEntry & { id: string };

/**
 * Version 3 promotes only the explicit templates measured by issue #152. The
 * preparation rules turn zero-through-twenty into digits inside those templates;
 * none rewrites a standalone number word. Spoken parentheses are accepted only
 * where both delimiters and the complete atomic interior are present. This does
 * not infer grouping or change the atomic root rule's deliberately narrow scope.
 */
function buildStructuredPreparationRules(): IdentifiedRule[] {
  return FRENCH_NUMBER_ATOMS.flatMap(([spoken, digit]) => {
    const suffix = spoken.replaceAll("é", "e");
    return [
      {
        id: `structured-parenthesis-number-${suffix}`,
        pattern:
          `(?<prefix>parenthèse\\s+ouvrante\\s+\\p{L}\\s+(?:plus|moins)\\s+)` +
          `${escapeRegex(spoken)}(?=\\s+parenthèse\\s+fermante)`,
        replacement: `$<prefix>${digit}`,
        flags: "i",
      },
      {
        id: `structured-linear-coefficient-${suffix}`,
        pattern:
          `${NOT_SPOKEN_ALIAS_BEFORE}${escapeRegex(spoken)}\\s+` +
          `(?<variable>\\p{L})(?=\\s+(?:plus|moins)\\s+)`,
        replacement: `${digit}$<variable>`,
        flags: "i",
      },
      {
        id: `structured-linear-constant-${suffix}`,
        pattern:
          `(?<prefix>\\d+\\p{L}\\s+(?:plus|moins)\\s+)` +
          `${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
        replacement: `$<prefix>${digit}`,
        flags: "i",
      },
      {
        id: `structured-image-number-${suffix}`,
        pattern:
          `${NOT_SPOKEN_ALIAS_BEFORE}${escapeRegex(spoken)}` +
          `(?=\\s+est\\s+l['’]image)`,
        replacement: `$$${digit}$$`,
        flags: "i",
      },
      {
        id: `structured-exponential-negative-${suffix}`,
        pattern:
          `${NOT_WORD_BEFORE}exponentielle\\s+de\\s+moins\\s+` +
          `${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
        replacement: `$$e^{-${digit}}$$`,
        flags: "i",
      },
      {
        id: `structured-exponential-${suffix}`,
        pattern:
          `${NOT_WORD_BEFORE}exponentielle\\s+de\\s+` +
          `${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
        replacement: `$$e^{${digit}}$$`,
        flags: "i",
      },
    ];
  });
}

function buildStructuredEqualityRightRules(
  operandPattern = OPERAND_BARE,
): IdentifiedRule[] {
  const preservedOperand = buildPreservedOperandPattern(operandPattern);
  return FRENCH_NUMBER_ATOMS.map(([spoken, digit]) => ({
    id: `structured-equality-right-${spoken.replaceAll("é", "e")}`,
    pattern:
      `${NOT_WORD_BEFORE}(?<prefix>${preservedOperand}\\s+est\\s+[ée]gale?(?:\\s+à)?\\s+)` +
      `${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
    replacement: `$<prefix>${digit}`,
    flags: "i",
  }));
}

const V3_STRUCTURED_RULES: IdentifiedRule[] = [
  {
    id: "structured-parenthesized-sum-times",
    pattern:
      `${NOT_WORD_BEFORE}parenthèse\\s+ouvrante\\s+(?<left>\\p{L})\\s+plus\\s+` +
      `(?<number>-?\\d+)\\s+parenthèse\\s+fermante\\s+multipli[ée]e?\\s+par\\s+` +
      `(?<right>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$($<left> + $<number>) \\times $<right>$$`,
    flags: "i",
  },
  {
    id: "structured-times-parenthesized-difference",
    pattern:
      `${NOT_WORD_BEFORE}(?<left>\\p{L})\\s+multipli[ée]e?\\s+par\\s+` +
      `parenthèse\\s+ouvrante\\s+(?<inside>\\p{L})\\s+moins\\s+` +
      `(?<number>-?\\d+)\\s+parenthèse\\s+fermante${NOT_WORD_AFTER}`,
    replacement: `$$$<left> \\times ($<inside> - $<number>)$$`,
    flags: "i",
  },
  {
    id: "structured-parenthesized-sum-square",
    pattern:
      `${NOT_WORD_BEFORE}parenthèse\\s+ouvrante\\s+(?<left>\\p{L})\\s+plus\\s+` +
      `(?<number>-?\\d+)\\s+parenthèse\\s+fermante\\s+au\\s+carr(?:é|ée)${NOT_WORD_AFTER}`,
    replacement: `$$($<left> + $<number>)^{2}$$`,
    flags: "i",
  },
  {
    id: "structured-nested-functions",
    pattern:
      `${NOT_WORD_BEFORE}(?<outer>\\p{L})\\s+de\\s+(?<inner>\\p{L})\\s+de\\s+` +
      `(?<argument>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$$<outer>($<inner>($<argument>))$$`,
    flags: "i",
  },
  {
    id: "structured-limit-sine-over-variable-at-zero",
    pattern:
      `${NOT_WORD_BEFORE}limite\\s+quand\\s+(?<variable>\\p{L})\\s+tend\\s+vers\\s+zéro\\s+` +
      `de\\s+sinus\\s+de\\s+(?<argument>\\p{L})\\s+sur\\s+` +
      `(?<denominator>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$\\lim_{$<variable>\\to0}\\frac{\\sin($<argument>)}{$<denominator>}$$`,
    flags: "i",
  },
  {
    id: "structured-derivative",
    pattern:
      `${NOT_WORD_BEFORE}dérivée\\s+de\\s+(?<functionName>\\p{L})\\s+par\\s+rapport\\s+à\\s+` +
      `(?<variable>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{\\mathrm{d}$<functionName>}{\\mathrm{d}$<variable>}$$`,
    flags: "i",
  },
  {
    id: "structured-integral-zero-to-one-square",
    pattern:
      `${NOT_WORD_BEFORE}intégrale\\s+de\\s+zéro\\s+à\\s+un\\s+de\\s+` +
      `(?<integrand>\\p{L})\\s+au\\s+carr(?:é|ée)\\s+d\\s+` +
      `(?<variable>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$\\int_{0}^{1}$<integrand>^{2} \\, d$<variable>$$`,
    flags: "i",
  },
  {
    id: "structured-limit-reciprocal-at-positive-infinity",
    pattern:
      `${NOT_WORD_BEFORE}limite\\s+de\\s+un\\s+sur\\s+(?<denominator>\\p{L})\\s+` +
      `quand\\s+(?<variable>\\p{L})\\s+tend\\s+vers\\s+plus\\s+l['’]infini${NOT_WORD_AFTER}`,
    replacement: `$$\\lim_{$<variable>\\to+\\infty}\\frac{1}{$<denominator>}$$`,
    flags: "i",
  },
  {
    id: "structured-linear-addition",
    pattern:
      `${NOT_WORD_BEFORE}(?<coefficient>\\d+)(?<variable>\\p{L})\\s+plus\\s+` +
      `(?<constant>-?\\d+)${NOT_WORD_AFTER}`,
    replacement: `$$$<coefficient>$<variable> + $<constant>$$`,
    flags: "i",
  },
  {
    id: "structured-linear-subtraction",
    pattern:
      `${NOT_WORD_BEFORE}(?<coefficient>\\d+)(?<variable>\\p{L})\\s+moins\\s+` +
      `(?<constant>-?\\d+)${NOT_WORD_AFTER}`,
    replacement: `$$$<coefficient>$<variable> - $<constant>$$`,
    flags: "i",
  },
  {
    id: "structured-exponential-variable",
    pattern: `${NOT_WORD_BEFORE}exponentielle\\s+de\\s+(?<argument>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$$e^{$<argument>}$$`,
    flags: "i",
  },
  {
    id: "structured-function-identifier",
    pattern: `(?<prefix>la\\s+fonction\\s+)(?<functionName>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$<prefix>$$$<functionName>$$`,
    flags: "i",
  },
  {
    id: "structured-value-identifier",
    pattern: `(?<prefix>valeur\\s+de\\s+)(?<variable>\\p{L})${NOT_WORD_AFTER}`,
    replacement: `$<prefix>$$$<variable>$$`,
    flags: "i",
  },
];

function v3AtomicRule(
  rule: RuleEntry,
  id: string,
  operandPattern = OPERAND_BARE,
): RuleEntry {
  const operandAny = (tag: string) =>
    `(?:\\$(?<i${tag}>[^$]+)\\$|(?<p${tag}>${operandPattern}))`;
  if (id === "equality") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:[ée]gale?|est\\s+[ée]gale?(?:\\s+à)?)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} = ${refAny("2")}$$`,
      flags: "i",
    };
  }
  if (id === "comparison-greater") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:plus\\s+grand\\s+que|supérieure?\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} > ${refAny("2")}$$`,
      flags: "i",
    };
  }
  if (id === "comparison-less") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:plus\\s+petit\\s+que|inférieure?\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} < ${refAny("2")}$$`,
      flags: "i",
    };
  }
  return rule;
}

function v4AtomicRule(rule: RuleEntry, id: string): RuleEntry {
  if (id === "equality") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:est\\s+)?[ée]gale?(?:\\s+à)?\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} = ${refAny("2")}$$`,
      flags: "i",
    };
  }
  if (id === "comparison-greater") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:plus\\s+grand\\s+que|(?:strictement\\s+)?supérieure?\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} > ${refAny("2")}$$`,
      flags: "i",
    };
  }
  if (id === "comparison-less") {
    return {
      pattern:
        `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
        `(?:plus\\s+petit\\s+que|(?:strictement\\s+)?inférieure?\\s+à)\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
      replacement: `$$${refAny("1")} < ${refAny("2")}$$`,
      flags: "i",
    };
  }
  return rule;
}

const SPOKEN_ATOM_RULE_COUNT = SPOKEN_ATOM_RULE_IDS.length + 3;
const V3_ATOMIC_RULES = [
  ...buildSpokenAtomRules(
    V3_BINARY_SPOKEN_OPERATOR,
    V3_FUNCTION_SPOKEN_PREFIX,
    HISTORICAL_OPERAND_BARE,
  ),
  ...HISTORICAL_V2_RULES.slice(SPOKEN_ATOM_RULE_COUNT).map((rule, index) =>
    v3AtomicRule(
      rule,
      V2_RULE_IDS[SPOKEN_ATOM_RULE_COUNT + index]!,
      HISTORICAL_OPERAND_BARE,
    ),
  ),
];

const V4_ATOMIC_INSERTIONS = new Map<string, IdentifiedRule[]>([
  ["function-natural-log", [{
    id: "function-unspecified-log",
    pattern: `${NOT_WORD_BEFORE}logarithme\\s+de\\s+${operandBare("1")}${NOT_WORD_AFTER}`,
    replacement: `$$\\log(${refBare("1")})$$`,
    flags: "i",
  }]],
  ["comparison-greater", [{
    id: "comparison-greater-or-equal",
    pattern:
      `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
      `supérieure?\\s+ou\\s+[ée]gale?\\s+à\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} \\ge ${refAny("2")}$$`,
    flags: "i",
  }]],
  ["comparison-less", [{
    id: "comparison-less-or-equal",
    pattern:
      `${NOT_WORD_BEFORE}${operandAny("1")}\\s+` +
      `inférieure?\\s+ou\\s+[ée]gale?\\s+à\\s+${operandAny("2")}${NOT_WORD_AFTER}`,
    replacement: `$$${refAny("1")} \\le ${refAny("2")}$$`,
    flags: "i",
  }]],
]);

const CURRENT_V2_RULES = buildV2Rules(OPERAND_BARE);

/**
 * Lowercase Greek lexicon beyond the two names (`theta`, `rho`) frozen into the
 * historical v2/v3 sets. DEC-COUCHE1-003 (#178) fixes the full lowercase Greek
 * alphabet in layer 1 as the lowercase ASCII name identical to the LaTeX macro;
 * `omicron` is excluded because base LaTeX has no `\omicron` macro. Each letter
 * behaves exactly like `theta`/`rho`: it is only turned into its macro inside a
 * recognized construction (a spoken binary operator or a function prefix), so a
 * standalone Greek word in prose is left byte-identical (DEC-COUCHE1-001).
 *
 * These rules are appended to the CURRENT bundled set only. They are NOT added
 * to `SPOKEN_ATOM_ALIASES`, which feeds the frozen historical v2/v3 sets whose
 * migration signatures must keep their exact rule counts (66 / 226).
 */
const CURRENT_GREEK_ATOMS = [
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["delta", "\\delta"],
  ["epsilon", "\\epsilon"],
  ["zeta", "\\zeta"],
  ["eta", "\\eta"],
  ["iota", "\\iota"],
  ["kappa", "\\kappa"],
  ["lambda", "\\lambda"],
  ["mu", "\\mu"],
  ["nu", "\\nu"],
  ["xi", "\\xi"],
  ["pi", "\\pi"],
  ["sigma", "\\sigma"],
  ["tau", "\\tau"],
  ["upsilon", "\\upsilon"],
  ["phi", "\\phi"],
  ["chi", "\\chi"],
  ["psi", "\\psi"],
  ["omega", "\\omega"],
] as const;

/**
 * Accented/phonetic STT spellings mapped back to a canonical Greek atom — the
 * "dictionary brings observed variants to the canonical form" of
 * DEC-COUCHE1-003, realized as atom aliases rather than personal-dictionary
 * entries: DicTeX ships an EMPTY personal dictionary, and the versioned,
 * fingerprinted shipped set is this bundled rule set. The list is seeded from
 * #178's examples plus the obvious French diacritic spellings and grows only
 * from observed errors (roadmap stage 7). Each carries a stable ASCII id slug
 * so a personal overlay can target it, and — like every atom — a variant is
 * canonicalized only inside a construction. Collision-prone homophones are not
 * admitted speculatively: in particular, "pie" stays ordinary French prose.
 */
const GREEK_ATOM_VARIANTS = [
  { spoken: "thêta", latex: "\\theta", slug: "theta-circumflex" },
  { spoken: "rhô", latex: "\\rho", slug: "rho-circumflex" },
  { spoken: "khi", latex: "\\chi", slug: "chi-kh" },
  { spoken: "bêta", latex: "\\beta", slug: "beta-circumflex" },
  { spoken: "êta", latex: "\\eta", slug: "eta-circumflex" },
  { spoken: "oméga", latex: "\\omega", slug: "omega-acute" },
] as const;

// A pending atom for the current Greek rules: the same shape as PENDING_ATOM
// but with the new Greek words added, so two spoken Greek letters (or a Greek
// letter and a number word / digit / letter) compose ("alpha sur beta"). The
// shared PENDING_ATOM is deliberately left untouched to keep the historical
// sets frozen.
const CURRENT_GREEK_ATOM_ALIASES: ReadonlyArray<{ spoken: string; latex: string; slug: string }> = [
  ...CURRENT_GREEK_ATOMS.map(([spoken, latex]) => ({ spoken, latex, slug: spoken })),
  ...GREEK_ATOM_VARIANTS.map((variant) => ({ ...variant })),
];
const CURRENT_GREEK_PENDING_WORDS = [
  ...FRENCH_NUMBER_ATOMS.map(([spoken]) => spoken),
  ...GREEK_ATOMS.map(([spoken]) => spoken),
  ...CURRENT_GREEK_ATOM_ALIASES.map(({ spoken }) => spoken),
];
const CURRENT_GREEK_PENDING_PATTERN = CURRENT_GREEK_PENDING_WORDS
  .map((spoken) => escapeRegex(spoken))
  .sort((left, right) => right.length - left.length)
  .join("|");
const CURRENT_GREEK_PENDING_ATOM =
  `(?:moins\\s+)?(?:${CURRENT_GREEK_PENDING_PATTERN})|(?:${OPERAND_BARE})|\\$[^$]+\\$`;
const CURRENT_GREEK_PENDING_WORDS_WITHOUT_UN = [
  ...FRENCH_NUMBER_ATOMS.filter(([spoken]) => spoken !== "un").map(([spoken]) => spoken),
  ...GREEK_ATOMS.map(([spoken]) => spoken),
  ...CURRENT_GREEK_ATOM_ALIASES.map(({ spoken }) => spoken),
];
const CURRENT_GREEK_PENDING_PATTERN_WITHOUT_UN = CURRENT_GREEK_PENDING_WORDS_WITHOUT_UN
  .map((spoken) => escapeRegex(spoken))
  .sort((left, right) => right.length - left.length)
  .join("|");
const CURRENT_GREEK_PENDING_ATOM_WITHOUT_UN =
  `(?:moins\\s+)?(?:${CURRENT_GREEK_PENDING_PATTERN_WITHOUT_UN})|` +
  `(?:${OPERAND_BARE})|\\$[^$]+\\$`;

/**
 * Left/right contextual rules for the current Greek lexicon, mirroring
 * `buildSpokenAtomRules` but carrying their own stable ids and using
 * `CURRENT_GREEK_PENDING_ATOM`. No standalone-word rule and no negative-number
 * helpers: those already exist in the shared spoken-atom block that runs first.
 */
function buildCurrentGreekAtomRules(): IdentifiedRule[] {
  const leftRules = CURRENT_GREEK_ATOM_ALIASES.map(({ spoken, latex, slug }) => {
    // "mu" and "nu" collide with ordinary French. In particular, a following
    // spoken "un" is more likely to be an article ("nu sur un lit") than an
    // operand. They remain available with an unambiguous digit, letter, Greek
    // atom or any other number word (for example "mu sur x" / "nu plus deux").
    const pendingAtom = spoken === "mu" || spoken === "nu"
      ? CURRENT_GREEK_PENDING_ATOM_WITHOUT_UN
      : CURRENT_GREEK_PENDING_ATOM;
    return {
      id: `spoken-atom-left-${slug}`,
      pattern:
        `${NOT_SPOKEN_ALIAS_BEFORE}${escapeRegex(spoken)}\\s+` +
        `(?<spokenOperator>${BINARY_SPOKEN_OPERATOR})\\s+` +
        `(?<followingAtom>${pendingAtom})${NOT_WORD_AFTER}`,
      replacement: `${latex} $<spokenOperator> $<followingAtom>`,
      flags: "i",
    };
  });
  const rightRules = CURRENT_GREEK_ATOM_ALIASES.map(({ spoken, latex, slug }) => ({
    id: `spoken-atom-right-${slug}`,
    pattern:
      `${NOT_WORD_BEFORE}(?:(?<binaryPrefix>${PRESERVED_OPERAND}\\s+(?:${BINARY_SPOKEN_OPERATOR}))|` +
      `(?<functionPrefix>${FUNCTION_SPOKEN_PREFIX}))\\s+` +
      `(?<unaryMinus>moins\\s+)?${escapeRegex(spoken)}${NOT_SPOKEN_ALIAS_AFTER}`,
    replacement: `$<binaryPrefix>$<functionPrefix> $<unaryMinus>${latex}`,
    flags: "i",
  }));
  return [...leftRules, ...rightRules];
}

const V4_ATOMIC_RULES: IdentifiedRule[] = [
  // The Greek family runs before the shared spoken-atom rules so a spoken number
  // word on the far side of a Greek letter ("thêta sur deux") is still pending
  // when the shared number rules run and can be resolved into "2".
  ...buildCurrentGreekAtomRules(),
  ...buildSpokenAtomRules().map((rule, index) => ({ ...rule, id: V2_RULE_IDS[index]! })),
  ...CURRENT_V2_RULES.slice(SPOKEN_ATOM_RULE_COUNT).flatMap((rule, index) => {
    const id = V2_RULE_IDS[SPOKEN_ATOM_RULE_COUNT + index]!;
    return [
      ...(V4_ATOMIC_INSERTIONS.get(id) ?? []),
      { ...v4AtomicRule(v3AtomicRule(rule, id), id), id },
    ];
  }),
];

// DEC-CONV-004 (CONV-011): a canonical limit accepts "quand" or "lorsque" as
// interchangeable connectors, and either placement of the "… tend vers …"
// clause — postfix ("la limite de <expr> quand …") or the more formal infix
// ("la limite, quand …, de <expr>") — both folding to the SAME Layer 2. The
// connector, the two spoken clauses and the two spoken expressions are shared
// between the postfix and infix rules so the two placements can never drift.
// A composed <expr> still needs the "le tout" marker (DEC-CONV-003); these
// templates only cover the two atomic canonical limits DEC-NORM-003 promoted.
const LIMIT_CONNECTOR = `(?:quand|lorsque)`;
// The canonical phrasings say "la limite". Keep accepting the historical
// article-less form, but consume "la" when it is present rather than leaving
// it as prose before the generated Layer 2.
const LIMIT_PREFIX = `(?:la\\s+)?limite`;
const LIMIT_CLAUSE_AT_POSITIVE_INFINITY =
  `${LIMIT_CONNECTOR}\\s+(?<variable>\\p{L})\\s+tend\\s+vers\\s+plus\\s+l['’]infini`;
const LIMIT_CLAUSE_AT_ZERO =
  `${LIMIT_CONNECTOR}\\s+(?<variable>\\p{L})\\s+tend\\s+vers\\s+zéro`;
const LIMIT_RECIPROCAL_EXPR = `de\\s+(?:un|1)\\s+sur\\s+(?<denominator>\\p{L})`;
const LIMIT_SINE_OVER_VARIABLE_EXPR =
  `de\\s+sinus\\s+de\\s+(?<argument>\\p{L})\\s+sur\\s+(?<denominator>\\p{L})`;
const LIMIT_RECIPROCAL_REPLACEMENT = `$$\\lim_{$<variable>\\to+\\infty}\\frac{1}{$<denominator>}$$`;
const LIMIT_SINE_OVER_VARIABLE_REPLACEMENT =
  `$$\\lim_{$<variable>\\to0}\\frac{\\sin($<argument>)}{$<denominator>}$$`;

const V4_ADDITIONAL_STRUCTURED_RULES: IdentifiedRule[] = [
  {
    // Infix placement of the reciprocal limit (DEC-CONV-004). The postfix form
    // keeps the historical id below; this adds the "la limite, quand …, de
    // <expr>" phrasing, commas optional since STT rarely emits them.
    id: "structured-limit-reciprocal-at-positive-infinity-infix",
    pattern:
      `${NOT_WORD_BEFORE}${LIMIT_PREFIX},?\\s+${LIMIT_CLAUSE_AT_POSITIVE_INFINITY},?\\s+` +
      `${LIMIT_RECIPROCAL_EXPR}${NOT_WORD_AFTER}`,
    replacement: LIMIT_RECIPROCAL_REPLACEMENT,
    flags: "i",
  },
  {
    // Postfix placement of the sine-over-variable limit (DEC-CONV-004). The
    // infix form keeps the historical id below; this adds "la limite de <expr>
    // quand x tend vers zéro".
    id: "structured-limit-sine-over-variable-at-zero-postfix",
    pattern:
      `${NOT_WORD_BEFORE}${LIMIT_PREFIX}\\s+${LIMIT_SINE_OVER_VARIABLE_EXPR}\\s+` +
      `${LIMIT_CLAUSE_AT_ZERO}${NOT_WORD_AFTER}`,
    replacement: LIMIT_SINE_OVER_VARIABLE_REPLACEMENT,
    flags: "i",
  },
  {
    id: "structured-exponential-negative-digits",
    pattern: `${NOT_WORD_BEFORE}exponentielle\\s+de\\s+moins\\s+(?<argument>\\d+)${NOT_WORD_AFTER}`,
    replacement: `$$e^{-$<argument>}$$`,
    flags: "i",
  },
  {
    id: "structured-exponential-digits",
    pattern: `${NOT_WORD_BEFORE}exponentielle\\s+de\\s+(?<argument>\\d+)${NOT_WORD_AFTER}`,
    replacement: `$$e^{$<argument>}$$`,
    flags: "i",
  },
  {
    id: "function-sine-degrees-digits",
    pattern: `${NOT_WORD_BEFORE}sinus\\s+de\\s+${operandBare("1")}\\s+degrés?${NOT_WORD_AFTER}`,
    replacement: `$$\\sin(${refBare("1")}^{\\circ})$$`,
    flags: "i",
  },
  {
    id: "function-cosine-degrees-digits",
    pattern: `${NOT_WORD_BEFORE}cosinus\\s+de\\s+${operandBare("1")}\\s+degrés?${NOT_WORD_AFTER}`,
    replacement: `$$\\cos(${refBare("1")}^{\\circ})$$`,
    flags: "i",
  },
  {
    id: "structured-theta-degrees-digits",
    pattern:
      `${NOT_WORD_BEFORE}theta\\s+(?:est\\s+)?[ée]gale?(?:\\s+à)?\\s+` +
      `(?<angle>-?\\d+)\\s+degrés?${NOT_WORD_AFTER}`,
    replacement: `$$\\theta = $<angle>^{\\circ}$$`,
    flags: "i",
  },
];

function v4StructuredRule(rule: IdentifiedRule): IdentifiedRule {
  // Both historical limit templates keep their stable ids; DEC-CONV-004 only
  // widens their patterns to accept "quand"/"lorsque". The reciprocal stays
  // postfix and the sine stays infix (comma-optional); the opposite placements
  // are the two new ids added to V4_ADDITIONAL_STRUCTURED_RULES.
  if (rule.id === "structured-limit-reciprocal-at-positive-infinity") {
    return {
      ...rule,
      pattern:
        `${NOT_WORD_BEFORE}${LIMIT_PREFIX}\\s+${LIMIT_RECIPROCAL_EXPR}\\s+` +
        `${LIMIT_CLAUSE_AT_POSITIVE_INFINITY}${NOT_WORD_AFTER}`,
    };
  }
  if (rule.id === "structured-limit-sine-over-variable-at-zero") {
    return {
      ...rule,
      pattern:
        `${NOT_WORD_BEFORE}${LIMIT_PREFIX},?\\s+${LIMIT_CLAUSE_AT_ZERO},?\\s+` +
        `${LIMIT_SINE_OVER_VARIABLE_EXPR}${NOT_WORD_AFTER}`,
    };
  }
  return rule;
}

const V4_STRUCTURED_RULES = [
  ...V4_ADDITIONAL_STRUCTURED_RULES,
  ...V3_STRUCTURED_RULES.map(v4StructuredRule),
];

const V3_FUNCTION_APPLICATION_END = V2_RULE_IDS.indexOf("function-application") + 1;
const PREPARATION_RULES = buildStructuredPreparationRules();
const V3_EQUALITY_RIGHT_RULES = buildStructuredEqualityRightRules(HISTORICAL_OPERAND_BARE);
const EQUALITY_RIGHT_RULES = buildStructuredEqualityRightRules();
const V3_EARLY_ATOMIC_RULES = V3_ATOMIC_RULES.slice(0, V3_FUNCTION_APPLICATION_END);
const V3_LATE_ATOMIC_RULES = V3_ATOMIC_RULES.slice(V3_FUNCTION_APPLICATION_END);
const V4_FUNCTION_APPLICATION_END = V4_ATOMIC_RULES.findIndex((rule) => rule.id === "function-application") + 1;
const V4_EARLY_ATOMIC_RULES = V4_ATOMIC_RULES.slice(0, V4_FUNCTION_APPLICATION_END);
const V4_LATE_ATOMIC_RULES = V4_ATOMIC_RULES.slice(V4_FUNCTION_APPLICATION_END);

const V3_DEFAULT_RULES: RuleEntry[] = [
  ...PREPARATION_RULES,
  ...V3_STRUCTURED_RULES,
  ...V3_EARLY_ATOMIC_RULES,
  ...V3_EQUALITY_RIGHT_RULES,
  ...V3_LATE_ATOMIC_RULES,
];

const V3_DEFAULT_RULE_IDS = [
  ...PREPARATION_RULES.map((rule) => rule.id),
  ...V3_STRUCTURED_RULES.map((rule) => rule.id),
  ...V2_RULE_IDS.slice(0, V3_FUNCTION_APPLICATION_END),
  ...V3_EQUALITY_RIGHT_RULES.map((rule) => rule.id),
  ...V2_RULE_IDS.slice(V3_FUNCTION_APPLICATION_END),
];

/**
 * Version 5 adds the spoken grouping marker "le tout" (DEC-CONV-003, CONV-010).
 * "le tout" is the ONLY way to bound a composed sub-expression: it never infers a
 * silent parenthesis, so the atomic scope of the bare rules (DEC-NORM-003) is
 * untouched and "racine carrée de a plus b" without the marker still yields
 * "$\sqrt{a} + b$".
 *
 * These rules run LAST, after the flat operator rules have already folded the
 * preceding expression into a single "$…$" fragment ("a plus b" is already
 * "$a + b$", §7). The marker sits BETWEEN an operand and its operator
 * ("… le tout au carré", "… le tout sur …"), so the earlier BARE bracing rules
 * (power-square, fraction-over, …) never fire on it — their operand token is one
 * digit/letter, never the word "tout". The one prefix operator "racine … de"
 * reads before its operand and has therefore already consumed the atom into
 * "$\sqrt{a}$" by the time these run; `group-marker-root` re-groups that residue
 * once "le tout" closes it.
 *
 * Brace-depth spacing stays canonical either way (asserted as a fixed point in
 * the tests): a power wraps its group in PARENS (depth 0 → "$(a + b)^{2}$",
 * spaced), while a fraction or root wraps in BRACES (depth ≥ 1 →
 * "$\frac{a+b}{c+d}$", "$\sqrt{a+b}$", tight). A fraction operand stays atomic
 * unless it carries its OWN marker (DEC-NORM-001): "a plus b le tout sur c plus d"
 * is "$\frac{a+b}{c} + d$", never the un-dictated "$\frac{a+b}{c+d}$".
 */
const GROUP_MARKER = `le\\s+tout`;

/** Match a whole "$…$" fragment an earlier rule already produced, capturing its
 * inner body (delimiters excluded) so it can be re-spliced into a new group. */
function markedFragment(tag: string): string {
  return `\\$(?<${tag}>[^$]+)\\$`;
}

const LE_TOUT_RULES: IdentifiedRule[] = [
  {
    // "$X$ le tout au carré" -> "$(X)^{2}$".
    id: "group-marker-square",
    pattern: `${markedFragment("gsq")}\\s+${GROUP_MARKER}\\s+au\\s+carr(?:é|ée)${NOT_WORD_AFTER}`,
    replacement: `$$($<gsq>)^{2}$$`,
    flags: "i",
  },
  {
    // "$X$ le tout au cube" -> "$(X)^{3}$".
    id: "group-marker-cube",
    pattern: `${markedFragment("gcu")}\\s+${GROUP_MARKER}\\s+au\\s+cube${NOT_WORD_AFTER}`,
    replacement: `$$($<gcu>)^{3}$$`,
    flags: "i",
  },
  {
    // "$X$ le tout puissance n" -> "$(X)^{n}$" (bare exponent operand).
    id: "group-marker-power",
    pattern: `${markedFragment("gpw")}\\s+${GROUP_MARKER}\\s+puissance\\s+(?<gpn>${OPERAND_BARE})${NOT_WORD_AFTER}`,
    replacement: `$$($<gpw>)^{$<gpn>}$$`,
    flags: "i",
  },
  {
    // Both operands grouped: "$X$ le tout sur $Y$ le tout" -> "$\frac{X}{Y}$".
    // Runs before the atomic/split variants so a marked denominator wins.
    id: "group-marker-over-grouped",
    pattern: `${markedFragment("gox")}\\s+${GROUP_MARKER}\\s+sur\\s+${markedFragment("goy")}\\s+${GROUP_MARKER}${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{$<gox>}{$<goy>}$$`,
    flags: "i",
  },
  {
    // Bare atomic denominator: "$X$ le tout sur c" -> "$\frac{X}{c}$".
    id: "group-marker-over-atom",
    pattern: `${markedFragment("gax")}\\s+${GROUP_MARKER}\\s+sur\\s+(?<gac>${OPERAND_BARE})${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{$<gax>}{$<gac>}$$`,
    flags: "i",
  },
  {
    // Composed but UNMARKED denominator: "sur" consumes only its first atom
    // (DEC-NORM-001), leaving the tail outside the fraction. "$X$ le tout sur
    // $c + d$" -> "$\frac{X}{c} + d$"; grouping "c + d" requires its own marker.
    id: "group-marker-over-atom-tail",
    pattern:
      `${markedFragment("gtx")}\\s+${GROUP_MARKER}\\s+sur\\s+` +
      `\\$(?<gtd>${OPERAND_BARE})\\s+(?<gtt>[-+]\\s*[^$]+)\\$${NOT_WORD_AFTER}`,
    replacement: `$$\\frac{$<gtx>}{$<gtd>}$<gtt>$$`,
    flags: "i",
  },
  {
    // The prefix root already braced its atom ("$\sqrt{a} + b$"); "le tout"
    // closes the group, re-braced tight -> "$\sqrt{a+b}$". Only fires when the
    // marker is present, so the DEC-NORM-003 residue "$\sqrt{a} + b$" is kept.
    id: "group-marker-root",
    pattern: `\\$\\\\sqrt\\{(?<grh>[^{}]+)\\}\\s+(?<grop>[-+])\\s+(?<grt>[^$]+?)\\$\\s+${GROUP_MARKER}${NOT_WORD_AFTER}`,
    replacement: `$$\\sqrt{$<grh>$<grop>$<grt>}$$`,
    flags: "i",
  },
];

export const DEFAULT_RULES: RuleEntry[] = [
  ...PREPARATION_RULES,
  ...V4_STRUCTURED_RULES,
  ...V4_EARLY_ATOMIC_RULES,
  ...EQUALITY_RIGHT_RULES,
  ...V4_LATE_ATOMIC_RULES,
  ...LE_TOUT_RULES,
];

const DEFAULT_RULE_IDS = [
  ...PREPARATION_RULES.map((rule) => rule.id),
  ...V4_STRUCTURED_RULES.map((rule) => rule.id),
  ...V4_EARLY_ATOMIC_RULES.map((rule) => rule.id),
  ...EQUALITY_RIGHT_RULES.map((rule) => rule.id),
  ...V4_LATE_ATOMIC_RULES.map((rule) => rule.id),
  ...LE_TOUT_RULES.map((rule) => rule.id),
];

if (DEFAULT_RULE_IDS.length !== DEFAULT_RULES.length) {
  throw new Error("Current bundled rule ids must stay aligned with the bundled rule definitions");
}

export const BUNDLED_RULES: BundledRuleDefinition[] = DEFAULT_RULES.map((rule, order) => ({
  ...rule,
  id: DEFAULT_RULE_IDS[order]!,
  order,
}));

function buildHistoricalV1Rules(): RuleEntry[] {
  const historicalOperand = "\\d+|\\p{L}";
  const bare = (tag: string): string => `(?<p${tag}>${historicalOperand})`;
  const any = (tag: string): string => `(?:\\$(?<i${tag}>[^$]+)\\$|(?<p${tag}>${historicalOperand}))`;
  const bareRef = (tag: string): string => `$<p${tag}>`;
  const anyRef = (tag: string): string => `$<i${tag}>$<p${tag}>`;
  return [
    { pattern: `${NOT_WORD_BEFORE}${bare("1")}\\s+au\\s+carr(?:é|ée)${NOT_WORD_AFTER}`, replacement: `$$${bareRef("1")}^{2}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${bare("1")}\\s+au\\s+cube${NOT_WORD_AFTER}`, replacement: `$$${bareRef("1")}^{3}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${bare("1")}\\s+puissance\\s+${bare("2")}${NOT_WORD_AFTER}`, replacement: `$$${bareRef("1")}^{${bareRef("2")}}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}racine\\s+(?:carr(?:é|ée)\\s+)?de\\s+${bare("1")}${NOT_WORD_AFTER}`, replacement: `$$\\sqrt{${bareRef("1")}}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+[ée]gale?\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} = ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+plus\\s+grand\\s+que\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} > ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+plus\\s+petit\\s+que\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} < ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+plus\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} + ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+moins\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} - ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${any("1")}\\s+fois\\s+${any("2")}${NOT_WORD_AFTER}`, replacement: `$$${anyRef("1")} \\times ${anyRef("2")}$$`, flags: "i" },
    { pattern: `${NOT_WORD_BEFORE}${bare("1")}\\s+divis[ée]e?\\s+par\\s+${bare("2")}${NOT_WORD_AFTER}`, replacement: `$$\\frac{${bareRef("1")}}{${bareRef("2")}}$$`, flags: "i" },
  ];
}

/** Complete normalized signatures of shipped legacy sets recognized by migration. */
export const HISTORICAL_BUNDLED_RULE_SETS = [
  { version: 1, rules: buildHistoricalV1Rules() },
  { version: 2, rules: HISTORICAL_V2_RULES },
  { version: 3, rules: V3_DEFAULT_RULES },
] as const;

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

export type LegacyRuleClassification =
  | { index: number; kind: "bundled"; rule: RuleEntry; bundledRuleId: string; historicalVersion: number }
  | { index: number; kind: "personal"; rule: RuleEntry }
  | { index: number; kind: "ambiguous"; rule: RuleEntry; candidateBundledRuleIds: string[] }
  | { index: number; kind: "invalid"; rawJson: string; diagnostic: string };

export type LegacyRulesAnalysis = {
  validTopLevel: boolean;
  legacyVersion: number | null;
  classifications: LegacyRuleClassification[];
  diagnostics: string[];
};

const HISTORICAL_V1_RULE_IDS = [
  "power-square",
  "power-cube",
  "power-explicit",
  "root-square",
  "equality",
  "comparison-greater",
  "comparison-less",
  "addition",
  "subtraction",
  "multiply-times",
  "fraction-divided-by",
] as const;

function normalizedRuleSignature(rule: RuleEntry): string {
  return JSON.stringify({
    pattern: rule.pattern,
    replacement: rule.replacement,
    flags: compileRuleRegex(rule.pattern, rule.flags).flags,
  });
}

function historicalRulesWithIds(): Array<{ version: number; id: string; rule: RuleEntry; signature: string }> {
  return HISTORICAL_BUNDLED_RULE_SETS.flatMap((set) =>
    set.rules.map((rule, index) => ({
      version: set.version,
      id: set.version === 1
        ? HISTORICAL_V1_RULE_IDS[index]!
        : set.version === 2
          ? V2_RULE_IDS[index]!
          : V3_DEFAULT_RULE_IDS[index]!,
      rule,
      signature: normalizedRuleSignature(rule),
    })),
  );
}

/** Classifies a monolithic legacy rules source without dropping an entry. */
export function analyzeLegacyRulesSource(contents: string): LegacyRulesAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { validTopLevel: false, legacyVersion: null, classifications: [], diagnostics: [`rules.json is not valid JSON (${message})`] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return {
      validTopLevel: false,
      legacyVersion: null,
      classifications: [],
      diagnostics: ['rules.json must be an object with a "rules" array'],
    };
  }

  const history = historicalRulesWithIds();
  const diagnostics: string[] = [];
  const classifications = parsed.rules.map((rawRule, index): LegacyRuleClassification => {
    const validated = validateRuleEntry(rawRule, index);
    if (!validated.ok) {
      diagnostics.push(validated.error);
      return { index, kind: "invalid", rawJson: safeJson(rawRule), diagnostic: validated.error };
    }
    const rule = validated.rule;
    const signature = normalizedRuleSignature(rule);
    const exact = history.find((known) => known.signature === signature);
    if (exact) {
      return {
        index,
        kind: "bundled",
        rule,
        bundledRuleId: exact.id,
        historicalVersion: exact.version,
      };
    }
    const candidates = Array.from(new Set(history
      .filter((known) => known.rule.pattern === rule.pattern || known.rule.replacement === rule.replacement)
      .map((known) => known.id)));
    if (candidates.length > 0) {
      return { index, kind: "ambiguous", rule, candidateBundledRuleIds: candidates };
    }
    return { index, kind: "personal", rule };
  });
  return {
    validTopLevel: true,
    legacyVersion: Number.isInteger(parsed.version) ? (parsed.version as number) : null,
    classifications,
    diagnostics,
  };
}

function validateRuleEntry(rawRule: unknown, index: number): { ok: true; rule: RuleEntry } | { ok: false; error: string } {
  if (!isRecord(rawRule)) {
    return { ok: false, error: `rule #${index + 1} is not an object` };
  }
  const { pattern, replacement, flags } = rawRule as RawRuleEntry;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, error: `rule #${index + 1} has an empty or non-string "pattern"` };
  }
  if (typeof replacement !== "string") {
    return { ok: false, error: `rule #${index + 1} has a non-string "replacement"` };
  }
  if (flags !== undefined && typeof flags !== "string") {
    return { ok: false, error: `rule #${index + 1} has a non-string "flags"` };
  }
  try {
    compileRuleRegex(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid pattern";
    return { ok: false, error: `rule #${index + 1} has an invalid regex (${message})` };
  }
  return { ok: true, rule: { pattern, replacement, ...(flags === undefined ? {} : { flags }) } };
}

function effectiveRulesHash(entries: readonly CompiledRule[]): string {
  return hashNormalizerSource(JSON.stringify(entries.map((rule, order) => ({
    id: rule.id,
    order,
    pattern: rule.pattern,
    flags: rule.flags,
    replacement: rule.replacement,
  }))));
}

function parsePersonalRuleOverlay(contents: string): { overlay: PersonalRuleOverlay | null; diagnostics: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    return { overlay: null, diagnostics: [`rules-overlay.json is not valid JSON (${message})`] };
  }
  if (!isRecord(parsed)) {
    return { overlay: null, diagnostics: ["rules-overlay.json must be an object"] };
  }
  if (
    parsed.version !== PERSONAL_RULES_OVERLAY_VERSION ||
    !Number.isInteger(parsed.bundled_rules_version) ||
    (parsed.bundled_rules_version as number) < 1 ||
    !Array.isArray(parsed.disabled_rule_ids) ||
    !Array.isArray(parsed.replacements) ||
    !Array.isArray(parsed.personal_rules)
  ) {
    return {
      overlay: null,
      diagnostics: [
        `rules-overlay.json must use version ${PERSONAL_RULES_OVERLAY_VERSION} with disabled_rule_ids, replacements and personal_rules arrays`,
      ],
    };
  }

  const bundledIds = new Set(BUNDLED_RULES.map((rule) => rule.id));
  const diagnostics: string[] = [];
  const disabled = parsed.disabled_rule_ids.filter((value): value is string => {
    if (typeof value !== "string" || !bundledIds.has(value)) {
      diagnostics.push(`disabled_rule_ids contains an unknown bundled rule id: ${safeJson(value)}`);
      return false;
    }
    return true;
  });
  if (new Set(disabled).size !== disabled.length) {
    diagnostics.push("disabled_rule_ids must not contain duplicates");
  }

  const replacementIds = new Set<string>();
  const replacements: PersonalRuleOverlay["replacements"] = [];
  parsed.replacements.forEach((value, index) => {
    if (!isRecord(value) || typeof value.rule_id !== "string" || !bundledIds.has(value.rule_id)) {
      diagnostics.push(`replacement #${index + 1} must target a known bundled rule_id`);
      return;
    }
    if (replacementIds.has(value.rule_id)) {
      diagnostics.push(`replacement rule_id ${value.rule_id} is duplicated`);
      return;
    }
    const validated = validateRuleEntry(value, index);
    if (!validated.ok) {
      diagnostics.push(`replacement ${value.rule_id}: ${validated.error}`);
      return;
    }
    replacementIds.add(value.rule_id);
    replacements.push({ rule_id: value.rule_id, ...validated.rule });
  });
  for (const replacement of replacements) {
    if (disabled.includes(replacement.rule_id)) {
      diagnostics.push(`bundled rule id ${replacement.rule_id} cannot be both disabled and replaced`);
    }
  }

  const personalIds = new Set<string>();
  const personalRules: PersonalRuleOverlay["personal_rules"] = [];
  parsed.personal_rules.forEach((value, index) => {
    if (
      !isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 ||
      !Number.isInteger(value.order) || (value.order as number) < 0
    ) {
      diagnostics.push(`personal rule #${index + 1} must have a non-empty id and non-negative integer order`);
      return;
    }
    if (bundledIds.has(value.id) || personalIds.has(value.id)) {
      diagnostics.push(`personal rule id ${value.id} must be unique and must not shadow a bundled id`);
      return;
    }
    const validated = validateRuleEntry(value, index);
    if (!validated.ok) {
      diagnostics.push(`personal rule ${value.id}: ${validated.error}`);
      return;
    }
    personalIds.add(value.id);
    personalRules.push({ id: value.id, order: value.order as number, ...validated.rule });
  });
  if (new Set(personalRules.map((rule) => rule.order)).size !== personalRules.length) {
    diagnostics.push("personal rule order values must be unique");
  }
  if (diagnostics.length > 0) {
    return { overlay: null, diagnostics };
  }
  return {
    overlay: {
      version: PERSONAL_RULES_OVERLAY_VERSION,
      bundled_rules_version: parsed.bundled_rules_version as number,
      disabled_rule_ids: disabled,
      replacements,
      personal_rules: personalRules,
    },
    diagnostics: [],
  };
}

function compileEffectiveOverlay(overlay: PersonalRuleOverlay): ReturnType<typeof compileRules> {
  const disabled = new Set(overlay.disabled_rule_ids);
  const replacements = new Map(overlay.replacements.map((rule) => [rule.rule_id, rule]));
  const definitions: Array<RuleEntry & { id: string }> = BUNDLED_RULES
    .filter((rule) => !disabled.has(rule.id))
    .map((rule) => ({ id: rule.id, ...(replacements.get(rule.id) ?? rule) }));
  for (const rule of [...overlay.personal_rules].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
    definitions.push(rule);
  }
  return compileRules(definitions, definitions.map((rule) => rule.id));
}

export function inspectPersonalRuleOverlay(overlay: PersonalRuleOverlay): {
  effectiveHash: string;
  effectiveRuleCount: number;
  personalRuleCount: number;
} {
  const compiled = compileEffectiveOverlay(overlay);
  if (compiled.diagnostics.length > 0) {
    throw new Error(compiled.diagnostics.join("; "));
  }
  return {
    effectiveHash: effectiveRulesHash(compiled.entries),
    effectiveRuleCount: compiled.entries.length,
    personalRuleCount: overlay.personal_rules.length,
  };
}

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
  overlayPath: string,
): Promise<{
  entries: CompiledRule[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
  sourceHash: string;
  sourceState: NormalizerSourceState;
  sourceContent: string | null;
  configuration: NormalizerRulesConfiguration;
}> {
  const bundled = compileRules(BUNDLED_RULES, BUNDLED_RULES.map((rule) => rule.id));
  const bundledHash = effectiveRulesHash(bundled.entries);
  const baseConfiguration = {
    bundledVersion: DEFAULT_RULES_CONFIG_VERSION,
    bundledHash,
    bundledRuleCount: BUNDLED_RULES.length,
    overlayPath,
    legacyPath: rulesPath,
  };

  if (existsSync(overlayPath)) {
    let overlayContents: string;
    try {
      overlayContents = await readFile(overlayPath, { encoding: "utf8" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreadable";
      const diagnostics = [`rules-overlay.json could not be read (${message}); using bundled rules only`];
      return {
        ...bundled,
        sourceHash: bundledHash,
        sourceState: "unreadable",
        sourceContent: null,
        configuration: {
          ...baseConfiguration,
          mode: "overlay",
          state: "invalid",
          overlayState: "unreadable",
          overlayHash: null,
          legacyVersion: null,
          legacyHash: existsSync(rulesPath) ? await hashReadableFile(rulesPath) : null,
          personalRuleCount: 0,
          effectiveRuleCount: bundled.entries.length,
          effectiveHash: bundledHash,
          recognizedBundledRuleCount: 0,
          ambiguityCount: 0,
          invalidRuleCount: 1,
          warning: "The personal overlay is unreadable; bundled rules remain active.",
          diagnostics,
        },
      };
    }
    const overlayHash = hashNormalizerSource(overlayContents);
    const parsedOverlay = parsePersonalRuleOverlay(overlayContents);
    if (!parsedOverlay.overlay) {
      return {
        ...bundled,
        diagnostics: parsedOverlay.diagnostics,
        ignored: parsedOverlay.diagnostics.map((diagnostic) => ({ index: null, raw_json: null, diagnostic })),
        sourceHash: bundledHash,
        sourceState: "invalid",
        sourceContent: overlayContents,
        configuration: {
          ...baseConfiguration,
          mode: "overlay",
          state: "invalid",
          overlayState: "invalid",
          overlayHash,
          legacyVersion: null,
          legacyHash: existsSync(rulesPath) ? await hashReadableFile(rulesPath) : null,
          personalRuleCount: 0,
          effectiveRuleCount: bundled.entries.length,
          effectiveHash: bundledHash,
          recognizedBundledRuleCount: 0,
          ambiguityCount: 0,
          invalidRuleCount: parsedOverlay.diagnostics.length,
          warning: "The personal overlay is invalid; bundled rules remain active.",
          diagnostics: parsedOverlay.diagnostics,
        },
      };
    }
    const compiled = compileEffectiveOverlay(parsedOverlay.overlay);
    const effectiveHash = effectiveRulesHash(compiled.entries);
    return {
      ...compiled,
      sourceHash: effectiveHash,
      sourceState: "file",
      sourceContent: overlayContents,
      configuration: {
        ...baseConfiguration,
        mode: "overlay",
        state: "current_overlay",
        overlayState: "file",
        overlayHash,
        legacyVersion: null,
        legacyHash: existsSync(rulesPath) ? await hashReadableFile(rulesPath) : null,
        personalRuleCount: parsedOverlay.overlay.personal_rules.length,
        effectiveRuleCount: compiled.entries.length,
        effectiveHash,
        recognizedBundledRuleCount: 0,
        ambiguityCount: 0,
        invalidRuleCount: 0,
        warning: null,
        diagnostics: compiled.diagnostics,
      },
    };
  }

  if (!existsSync(rulesPath)) {
    return {
      ...bundled,
      sourceHash: bundledHash,
      sourceState: "default_absent",
      sourceContent: null,
      configuration: {
        ...baseConfiguration,
        mode: "bundled",
        state: "bundled",
        overlayState: "absent",
        overlayHash: null,
        legacyVersion: null,
        legacyHash: null,
        personalRuleCount: 0,
        effectiveRuleCount: bundled.entries.length,
        effectiveHash: bundledHash,
        recognizedBundledRuleCount: 0,
        ambiguityCount: 0,
        invalidRuleCount: 0,
        warning: null,
        diagnostics: bundled.diagnostics,
      },
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
      configuration: {
        ...baseConfiguration,
        mode: "legacy",
        state: "invalid",
        overlayState: "absent",
        overlayHash: null,
        legacyVersion: null,
        legacyHash: null,
        personalRuleCount: 0,
        effectiveRuleCount: 0,
        effectiveHash: hashNormalizerSource(UNREADABLE_RULES_SOURCE),
        recognizedBundledRuleCount: 0,
        ambiguityCount: 0,
        invalidRuleCount: 1,
        warning: "The legacy rules file is unreadable.",
        diagnostics: [`rules.json could not be read (${message})`],
      },
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
      configuration: legacyConfiguration(baseConfiguration, contents, sourceHash, null, [], [message]),
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
      configuration: legacyConfiguration(baseConfiguration, contents, sourceHash, null, [], ['rules.json must be an object with a "rules" array']),
    };
  }
  const compiled = compileRules(parsed.rules as unknown[]);
  const analysis = analyzeLegacyRulesSource(contents);
  const effectiveHash = effectiveRulesHash(compiled.entries);
  return {
    ...compiled,
    sourceHash: effectiveHash,
    sourceState: "file",
    sourceContent: contents,
    configuration: legacyConfiguration(
      baseConfiguration,
      contents,
      sourceHash,
      Number.isInteger(parsed.version) ? (parsed.version as number) : null,
      analysis.classifications,
      compiled.diagnostics,
      effectiveHash,
      compiled.entries.length,
    ),
  };
}

async function hashReadableFile(filePath: string): Promise<string | null> {
  try {
    return hashNormalizerSource(await readFile(filePath, { encoding: "utf8" }));
  } catch {
    return null;
  }
}

function legacyConfiguration(
  base: Pick<NormalizerRulesConfiguration, "bundledVersion" | "bundledHash" | "bundledRuleCount" | "overlayPath" | "legacyPath">,
  _contents: string,
  legacyHash: string,
  legacyVersion: number | null,
  classifications: LegacyRuleClassification[],
  diagnostics: string[],
  effectiveHash = legacyHash,
  effectiveRuleCount = 0,
): NormalizerRulesConfiguration {
  const recognizedBundledRuleCount = classifications.filter((entry) => entry.kind === "bundled").length;
  const personalRuleCount = classifications.filter((entry) => entry.kind === "personal").length;
  const ambiguityCount = classifications.filter((entry) => entry.kind === "ambiguous").length;
  const invalidRuleCount = classifications.filter((entry) => entry.kind === "invalid").length + (classifications.length === 0 && diagnostics.length > 0 ? 1 : 0);
  const state: NormalizerRulesConfigurationState = invalidRuleCount > 0
    ? "invalid"
    : ambiguityCount > 0
      ? "ambiguous"
      : "migration_required";
  return {
    ...base,
    mode: "legacy",
    state,
    overlayState: "absent",
    overlayHash: null,
    legacyVersion,
    legacyHash,
    personalRuleCount,
    effectiveRuleCount,
    effectiveHash,
    recognizedBundledRuleCount,
    ambiguityCount,
    invalidRuleCount,
    warning: `Legacy rules.json is active and masks bundled rules v${DEFAULT_RULES_CONFIG_VERSION}.`,
    diagnostics,
  };
}

function compileRules(rawRules: readonly unknown[]): {
  entries: CompiledRule[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
};
function compileRules(rawRules: readonly unknown[], stableIds?: readonly (string | undefined)[]): {
  entries: CompiledRule[];
  diagnostics: string[];
  ignored: NormalizerIgnoredDefinition[];
};
function compileRules(rawRules: readonly unknown[], stableIds?: readonly (string | undefined)[]): {
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
        id: stableIds?.[index] ?? stableDefinitionId("regex", { pattern, flags: normalizedFlags, replacement }, usedIds),
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
