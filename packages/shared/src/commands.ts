/**
 * Command words and sentinels (shared, issue #92; design in
 * `docs/dataset-and-normalization-design.md` §4).
 *
 * Some dictated phrases are ACTIONS, not text: "retour à la ligne" must insert a
 * line break, not be pasted literally. This module is the single source of truth
 * for that mapping, consumed by BOTH sides of the normalization track:
 *
 *   - `apps/dictex` normalizer: after the personal dictionary (layer 1) and
 *     before the regex math rules (layer 2), `extractCommands` turns each spoken
 *     command into an inert sentinel that survives every downstream layer
 *     untouched; `expandCommands` turns it back into a real action at insert time.
 *   - `packages/shared` dataset export: `extractCommands` is applied to both
 *     layers of a `math_transform` training pair AT EXPORT TIME, so the seq2seq is
 *     trained on the same convention DicTeX serves.
 *
 * If these two callers used different tables the seq2seq would be trained on one
 * convention and served with another — a silent corruption of the whole
 * normalization track. Hence one table, here, and nowhere else.
 *
 * This module is pure and dependency-free (no node built-ins) so it is safe to
 * import from a renderer bundle via the `@dictex/shared/commands` subpath.
 *
 * ── Sentinel format ────────────────────────────────────────────────────────
 * One Unicode Private Use Area (PUA) code point per command, `U+E000`–`U+E00F`:
 *
 *   U+E000  retour à la ligne   → "\n"    (debug: ⟦NL⟧)
 *   U+E001  nouveau paragraphe  → "\n\n"  (debug: ⟦PARA⟧)
 *   U+E002 … U+E00F             reserved for future commands
 *
 * Chosen because no STT can emit the PUA, no mathematical notation uses it, one
 * regex class captures them all, and a seq2seq tokenizer can hold them as atomic
 * special tokens (it cannot split, invent, or drop them). Adding a command later
 * is a config change to `COMMANDS`: because substitution is applied at export,
 * regenerating the export retroactively fixes every historical training pair.
 *
 * STORAGE RULE (non-negotiable, see design §4): a sentinel is NEVER written to an
 * append-only event store. The builder holds the canonical words; substitution to
 * sentinels is a pure function applied only when building a training pair (export)
 * or when routing text to insertion (where `expandCommands` immediately turns the
 * sentinel back into its real effect). `expandCommands` is a total sentinel
 * eliminator — see the unit tests — so any string routed through it before storage
 * is guaranteed sentinel-free.
 *
 * WARNING to maintainers: PUA characters are invisible in editors and terminals.
 * Always write them as `\uXXXX` escapes in source, tests, and docs — never as
 * literal characters — and grep the 0xE000–0xF8FF range before committing.
 */

export type CommandDefinition = {
  /** Single PUA sentinel code point in `U+E000`–`U+E00F`. Written as an escape. */
  sentinel: string;
  /**
   * Canonical spoken phrase. The personal dictionary (layer 1) runs BEFORE
   * extraction and collapses spelling variants ("retour à la line", "retourne à
   * la ligne", …) into this one canonical form, so the extractor only needs a
   * single pattern per command. Matched case-insensitively, with flexible inner
   * whitespace, on word boundaries.
   */
  canonical: string;
  /** Real text the sentinel expands to at render/insert time. */
  expansion: string;
  /** Human-readable debug label. NEVER persist a sentinel as this label — the
   * store holds the canonical words; this is for a UI pill / debug view only. */
  label: string;
};

/**
 * The canonical command table — the ONE place the command list is defined.
 * Enlarging it is a config change by construction (see module header).
 */
export const COMMANDS: readonly CommandDefinition[] = [
  { sentinel: "\uE000", canonical: "retour à la ligne", expansion: "\n", label: "⟦NL⟧" },
  { sentinel: "\uE001", canonical: "nouveau paragraphe", expansion: "\n\n", label: "⟦PARA⟧" },
];

/** The full reserved sentinel block, `U+E000`–`U+E00F`. One class matches every
 * command sentinel and no rule written for maths will ever touch it. */
export const SENTINEL_PATTERN = /[\uE000-\uE00F]/;

const SENTINEL_PATTERN_GLOBAL = /[\uE000-\uE00F]/g;

/** True when `text` contains any command sentinel. Used by the no-sentinel-in-
 * store invariant tests. */
export function containsSentinel(text: string): boolean {
  return SENTINEL_PATTERN.test(text);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build one matcher per command: the canonical phrase, case-insensitive, with any
 * run of whitespace in the phrase allowed to match any run of whitespace in the
 * input, anchored on word boundaries so it never fires inside a larger word.
 * Longer phrases are matched first so a shorter command can never consume part of
 * a longer one.
 */
const COMMAND_MATCHERS: { regex: RegExp; sentinel: string }[] = [...COMMANDS]
  .sort((a, b) => b.canonical.length - a.canonical.length)
  .map((command) => {
    const words = command.canonical.trim().split(/\s+/).map(escapeRegExp);
    const body = words.join("\\s+");
    // `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])`: don't match glued inside a word;
    // `g` every occurrence, `u` Unicode-aware, `i` case-insensitive.
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
    return { regex, sentinel: command.sentinel };
  });

const EXPANSION_BY_SENTINEL: Map<string, string> = new Map(
  COMMANDS.map((command) => [command.sentinel, command.expansion]),
);

/**
 * Replace every spoken command in `text` with its inert sentinel. Non-command
 * text is returned untouched. Idempotent: a sentinel already present is left as
 * is (nothing matches it). This is applied after the personal dictionary and
 * before the regex math rules in DicTeX, and to both layers of a `math_transform`
 * pair at export time.
 */
export function extractCommands(text: string): string {
  let output = text;
  for (const matcher of COMMAND_MATCHERS) {
    output = output.replace(matcher.regex, matcher.sentinel);
  }
  return output;
}

/**
 * Expand every command sentinel in `text` into its real effect (a line break,
 * etc.), producing the text that is actually inserted / stored. This is a TOTAL
 * sentinel eliminator: any code point in the reserved block `U+E000`–`U+E00F` is
 * removed — a known sentinel becomes its expansion, an unknown reserved one is
 * dropped — so the result is guaranteed to contain no sentinel. Routing a string
 * through this before writing it to a store upholds the storage rule.
 */
export function expandCommands(text: string): string {
  return text.replace(SENTINEL_PATTERN_GLOBAL, (char) => EXPANSION_BY_SENTINEL.get(char) ?? "");
}
