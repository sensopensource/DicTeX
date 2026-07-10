/**
 * LaTeX canonicalization (shared, issue #106; design in
 * `docs/dataset-and-normalization-design.md` §8).
 *
 * LaTeX is the canonical notation for DicTeX Lab's Layer 2 targets. LaTeX is
 * ambiguous: the same mathematics has many spellings (`x^2` vs `x^{2}`, `\frac`
 * vs `\dfrac`, `\times` vs `\cdot`, `\,` vs nothing). If targets alternate, CER
 * measures typography instead of mathematics and a seq2seq learns that two
 * answers are both correct. `canonicalizeLatex` fixes ONE spelling per construct
 * so a comparison reflects the maths, not the keystrokes.
 *
 * It is applied — exactly like `extractCommands` (§4) — as a PURE FUNCTION
 * REPLAYED ON DEMAND, never stored:
 *   - `sttScoring`: before CER/WER, so `x^2` and `x^{2}` score as identical.
 *   - `datasetExport`: to the hand-written Layer 2 target before the pair is
 *     written. The append-only store is never mutated.
 *
 * Two properties are guaranteed and tested directly (see `latex.test.ts`):
 *   - IDEMPOTENT: `canonicalizeLatex(canonicalizeLatex(s)) === canonicalizeLatex(s)`.
 *     A canonical string is a fixed point.
 *   - TOTAL: any input returns a string without throwing.
 *
 * This module is pure and dependency-free (no `node:` built-ins) so it is safe to
 * import from a renderer bundle via the `@dictex/shared/latex` subpath.
 *
 * ── Delimiter decision (settled here, §8) ──────────────────────────────────
 * A dictation mixes prose and mathematics. Inline mathematics is wrapped in
 * `$…$`; prose stays bare. This is the single signal that tells KaTeX what to
 * render and gives the seq2seq a boundary for where maths begins. Consequences
 * for this canonicalizer:
 *   - It splits the input into prose / math segments on unescaped `$`. Only the
 *     math segments are rewritten; PROSE IS RETURNED VERBATIM (so a pure-prose
 *     string, or any string with no `$`, is returned unchanged — the identity
 *     that keeps it safe to apply to raw STT output in scoring).
 *   - `\(…\)` is accepted as an alias for `$…$` and normalized to `$…$`.
 *   - `\$` is a literal dollar in prose, never a delimiter.
 *   - Delimiter spacing is normalized: `$ x $` → `$x$`.
 *   - An unbalanced `$` (no closing delimiter) leaves the remainder as prose,
 *     unchanged — the function never corrupts on malformed input (totality).
 *   - Display math (`$$…$$`, `\[…\]`) is OUT OF SCOPE: the corpus is inline. It
 *     is left structurally alone rather than reinterpreted.
 */

/** The canonical inline-math delimiter (§8). Prose is bare; maths is wrapped. */
export const INLINE_MATH_DELIMITER = "$";

/**
 * Non-canonical macro → canonical macro. The LEFT side is a spelling we accept
 * and rewrite; the RIGHT side is the one canonical form. Each choice with a
 * plausible alternative is documented in
 * `docs/dataset-and-normalization-design.md` §8.
 */
export const MACRO_ALIASES: Readonly<Record<string, string>> = {
  "\\dfrac": "\\frac", // fractions: one \frac, never display/text variants
  "\\tfrac": "\\frac",
  "\\cdot": "\\times", // multiplication: \times, never \cdot / *
  "\\le": "\\leq", // relations: the long macro is canonical
  "\\ge": "\\geq",
  "\\ne": "\\neq",
  "\\leqslant": "\\leq",
  "\\geqslant": "\\geq",
  "\\rightarrow": "\\to", // limit arrow: \to is canonical
  "\\longrightarrow": "\\to",
};

/** Integral heads. Inside a span containing one of these, a `d`-differential
 * (`dx`, `dt`, `d\theta`) receives exactly one thin space (`\,`) before it — the
 * only sanctioned manual spacing (§8). */
const INTEGRAL_MACROS = new Set(["\\int", "\\iint", "\\iiint", "\\oint"]);

/** `\frac` and its display/text aliases (aliased to `\frac` first). Takes two
 * mandatory arguments, both brace-normalized. */
const TWO_ARG_MACROS = new Set(["\\frac"]);

/** One-mandatory-argument macros whose single-token argument is brace-normalized
 * (`\mathbb R` → `\mathbb{R}`). `\sqrt` is handled separately (optional `[n]`). */
const SINGLE_ARG_MACROS = new Set([
  "\\mathbb",
  "\\mathbf",
  "\\mathrm",
  "\\mathcal",
  "\\vec",
  "\\hat",
  "\\bar",
  "\\tilde",
  "\\overline",
  "\\underline",
]);

/** Binary/relational macros that take exactly one space on each side (§8). */
const BINARY_MACROS = new Set([
  "\\times",
  "\\div",
  "\\pm",
  "\\mp",
  "\\leq",
  "\\geq",
  "\\neq",
  "\\to",
  "\\in",
  "\\notin",
  "\\subset",
  "\\subseteq",
  "\\supset",
  "\\supseteq",
  "\\cup",
  "\\cap",
  "\\setminus",
  "\\circ",
  "\\equiv",
  "\\approx",
  "\\sim",
  "\\cong",
  "\\propto",
  "\\mid",
  "\\land",
  "\\lor",
  "\\wedge",
  "\\vee",
  "\\oplus",
  "\\otimes",
  "\\Rightarrow",
  "\\Leftrightarrow",
  "\\iff",
  "\\implies",
  "\\mapsto",
]);

/** Char operators that are ALWAYS binary (one space each side). `-` is excluded:
 * it is unary or binary by context (see `isBinaryAt`). */
const ALWAYS_BINARY_CHARS = new Set(["+", "=", "<", ">"]);

/** Macros that are NOT operands — a `-` following one is a sign, not a
 * subtraction. Used only for `-` classification and differential boundaries. */
const PREFIX_MACROS = new Set([
  "\\sqrt",
  "\\frac",
  "\\int",
  "\\iint",
  "\\iiint",
  "\\oint",
  "\\sum",
  "\\prod",
  "\\lim",
  "\\log",
  "\\ln",
  "\\sin",
  "\\cos",
  "\\tan",
  "\\exp",
  "\\vec",
  "\\hat",
  "\\bar",
  "\\tilde",
  "\\overline",
  "\\underline",
  "\\mathbb",
  "\\mathbf",
  "\\mathrm",
  "\\mathcal",
]);

/** Manual horizontal-spacing control symbols removed wholesale (§8: "no other
 * manual spacing"). The differential `\,` is re-derived structurally, never kept
 * from the input, which is what makes the pass idempotent. */
const MANUAL_SPACING_SYMBOLS = new Set(["\\,", "\\;", "\\:", "\\!", "\\>"]);
const MANUAL_SPACING_NAMES = new Set(["\\quad", "\\qquad"]);

/** The thin space emitted before a differential — the one canonical manual space. */
const THIN_SPACE = "\\,";

// ── Token model ──────────────────────────────────────────────────────────────

type Token =
  | { kind: "csname"; value: string } // control word: "\frac", "\alpha"
  | { kind: "csymbol"; value: string } // control symbol: "\,", "\{", "\%"
  | { kind: "lbrace" }
  | { kind: "rbrace" }
  | { kind: "char"; value: string } // any single non-space, non-brace char
  | { kind: "space" }; // a run of whitespace (dropped before emit)

/** Differential `d` tokens are flagged in place; the flag rides the same object
 * through bracing and is read when the thin space is inserted. */
type CharToken = Extract<Token, { kind: "char" }> & { differential?: boolean };

const isLetter = (value: string): boolean => /[A-Za-z]/.test(value);

/** Tokenize the body of one math span. TeX rules: a control word is `\`+letters;
 * a control symbol is `\`+one non-letter; everything else is a single char, with
 * whitespace runs collapsed to one `space` token. Never throws. */
function tokenizeMath(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) {
        j += 1;
      }
      tokens.push({ kind: "space" });
      i = j;
      continue;
    }
    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && /[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < source.length && /[a-zA-Z]/.test(source[j])) {
          j += 1;
        }
        tokens.push({ kind: "csname", value: source.slice(i, j) });
        i = j;
        continue;
      }
      // Control symbol: backslash + a single following char (or a lone trailing
      // backslash). "\ " (backslash-space) is a control space handled as a symbol.
      const value = next === undefined ? "\\" : "\\" + next;
      tokens.push({ kind: "csymbol", value });
      i += value.length;
      continue;
    }
    if (char === "{") {
      tokens.push({ kind: "lbrace" });
      i += 1;
      continue;
    }
    if (char === "}") {
      tokens.push({ kind: "rbrace" });
      i += 1;
      continue;
    }
    tokens.push({ kind: "char", value: char });
    i += 1;
  }
  return tokens;
}

function tokenText(token: Token): string {
  switch (token.kind) {
    case "csname":
    case "csymbol":
    case "char":
      return token.value;
    case "lbrace":
      return "{";
    case "rbrace":
      return "}";
    case "space":
      return " ";
  }
}

/** True when a control symbol is manual spacing (`\,`, `\;`, `\ `, …). */
function isManualSpacingSymbol(token: Token): boolean {
  if (token.kind === "csymbol") {
    return MANUAL_SPACING_SYMBOLS.has(token.value) || /^\\\s$/.test(token.value);
  }
  if (token.kind === "csname") {
    return MANUAL_SPACING_NAMES.has(token.value);
  }
  if (token.kind === "char") {
    return token.value === "~"; // non-breaking space
  }
  return false;
}

/** Pass 1 — macro aliasing and `*`→`\times`. Whole-token, so `\le` never matches
 * inside `\leq`. */
function aliasMacros(tokens: Token[]): Token[] {
  return tokens.map((token) => {
    if (token.kind === "csname" && token.value in MACRO_ALIASES) {
      return { kind: "csname", value: MACRO_ALIASES[token.value] };
    }
    if (token.kind === "char" && token.value === "*") {
      return { kind: "csname", value: "\\times" };
    }
    return token;
  });
}

/** Is `token` the end of an operand (so a following `-` is subtraction, and a
 * following `d` could be a differential)? Closers and values qualify; openers,
 * operators and prefix macros do not. */
function isOperandEnd(token: Token | undefined): boolean {
  if (!token) {
    return false;
  }
  if (token.kind === "rbrace") {
    return true;
  }
  if (token.kind === "char") {
    return /[A-Za-z0-9)\]!]/.test(token.value);
  }
  if (token.kind === "csname") {
    return !BINARY_MACROS.has(token.value) && !PREFIX_MACROS.has(token.value);
  }
  return false;
}

/**
 * Pass 2 — flag differential `d` tokens, using the ORIGINAL whitespace (run
 * before spaces are dropped). Only inside an integral span. A `d` is a
 * differential when it is a standalone token — preceded by a boundary
 * (whitespace, an opener, a closer, or an operator; never glued to a preceding
 * letter/digit, so an identifier like `abcd` is safe) — and immediately followed
 * by a variable (a letter or a control word like `\theta`).
 */
function markDifferentials(tokens: Token[]): void {
  const inIntegral = tokens.some((token) => token.kind === "csname" && INTEGRAL_MACROS.has(token.value));
  if (!inIntegral) {
    return;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "char" || token.value !== "d") {
      continue;
    }
    const prev = tokens[i - 1];
    const boundaryBefore =
      !prev ||
      prev.kind === "space" ||
      prev.kind === "lbrace" ||
      prev.kind === "rbrace" ||
      (prev.kind === "char" && /[()\[\]+\-=<>*/,]/.test(prev.value)) ||
      (prev.kind === "csname" && (BINARY_MACROS.has(prev.value) || PREFIX_MACROS.has(prev.value)));
    if (!boundaryBefore) {
      continue;
    }
    const next = tokens[i + 1];
    const variableAfter =
      !!next && ((next.kind === "char" && isLetter(next.value)) || next.kind === "csname");
    if (variableAfter) {
      (token as CharToken).differential = true;
    }
  }
}

/** Read a balanced brace group. `tokens[start]` must be `lbrace`. Returns the
 * inner body tokens (braces excluded) and the index just past the matching
 * `rbrace`. If unbalanced, the body runs to the end (totality). */
function readBalanced(tokens: Token[], start: number): { inner: Token[]; next: number } {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i].kind === "lbrace") {
      depth += 1;
    } else if (tokens[i].kind === "rbrace") {
      depth -= 1;
      if (depth === 0) {
        return { inner: tokens.slice(start + 1, i), next: i + 1 };
      }
    }
  }
  return { inner: tokens.slice(start + 1), next: tokens.length };
}

/**
 * Pass 3 — brace-normalize arguments, recursively so nesting is handled:
 *   - `^`/`_` single-token argument: `x^2` → `x^{2}`, `u_n` → `u_{n}`.
 *   - `\sqrt` radicand (after an optional `[n]`): `\sqrt x` → `\sqrt{x}`.
 *   - `\frac` both arguments: `\frac a b` → `\frac{a}{b}`.
 *   - single-arg macros: `\mathbb R` → `\mathbb{R}`.
 * An already-braced argument is left as a group and its contents are processed in
 * turn, so `\frac{x^2}{b}` → `\frac{x^{2}}{b}`. Idempotent: a braced argument
 * matches nothing to add.
 */
function braceArgs(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let k = 0;

  /** Emit one mandatory argument starting at `k` (processed & braced); advance
   * `k`. A group is copied with its contents processed; a bare token is wrapped
   * in braces. */
  function emitArg(): void {
    if (k >= tokens.length) {
      return;
    }
    const token = tokens[k];
    if (token.kind === "lbrace") {
      const { inner, next } = readBalanced(tokens, k);
      out.push({ kind: "lbrace" }, ...braceArgs(inner), { kind: "rbrace" });
      k = next;
      return;
    }
    out.push({ kind: "lbrace" }, ...braceArgs([token]), { kind: "rbrace" });
    k += 1;
  }

  while (k < tokens.length) {
    const token = tokens[k];

    if (token.kind === "lbrace") {
      const { inner, next } = readBalanced(tokens, k);
      out.push({ kind: "lbrace" }, ...braceArgs(inner), { kind: "rbrace" });
      k = next;
      continue;
    }

    if (token.kind === "char" && (token.value === "^" || token.value === "_")) {
      out.push(token);
      k += 1;
      emitArg();
      continue;
    }

    if (token.kind === "csname" && token.value === "\\sqrt") {
      out.push(token);
      k += 1;
      // Optional degree `[n]` — copied through, contents processed.
      if (tokens[k] && tokens[k].kind === "char" && (tokens[k] as CharToken).value === "[") {
        out.push(tokens[k]);
        k += 1;
        const degree: Token[] = [];
        while (k < tokens.length && !(tokens[k].kind === "char" && (tokens[k] as CharToken).value === "]")) {
          degree.push(tokens[k]);
          k += 1;
        }
        out.push(...braceArgs(degree));
        if (k < tokens.length) {
          out.push(tokens[k]); // the "]"
          k += 1;
        }
      }
      emitArg();
      continue;
    }

    if (token.kind === "csname" && TWO_ARG_MACROS.has(token.value)) {
      out.push(token);
      k += 1;
      emitArg();
      emitArg();
      continue;
    }

    if (token.kind === "csname" && SINGLE_ARG_MACROS.has(token.value)) {
      out.push(token);
      k += 1;
      emitArg();
      continue;
    }

    out.push(token);
    k += 1;
  }

  return out;
}

/** Insert the canonical thin space before each flagged differential `d`. */
function insertDifferentialSpacing(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "char" && (token as CharToken).differential) {
      out.push({ kind: "csymbol", value: THIN_SPACE });
    }
    out.push(token);
  }
  return out;
}

/** Is the token at `index` a binary operator in binary position? */
function isBinaryAt(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (token.kind === "csname") {
    return BINARY_MACROS.has(token.value);
  }
  if (token.kind === "char") {
    if (ALWAYS_BINARY_CHARS.has(token.value)) {
      return true;
    }
    if (token.value === "-") {
      // Binary only after an operand; otherwise a unary sign (`(-x)`, `x^{-1}`).
      // Based on the immediately preceding token, which is stable across passes.
      return isOperandEnd(tokens[index - 1]);
    }
  }
  return false;
}

/**
 * Pass 4 — emit with canonical spacing. All input whitespace was dropped; every
 * space here is DERIVED from token adjacency, which is what guarantees
 * idempotence. A single space is placed:
 *   - around a binary operator (both sides) at BRACE DEPTH 0 only — so main-line
 *     maths is spaced (`a+b`→`a + b`, `a\leq b`→`a \leq b`) while bounds and
 *     exponents stay tight (`x^{n+1}`, `\sum_{i=1}^{n}`, `\int_{0}^{1}`). This
 *     matches the issue's displayed canonical forms; the one deviation is
 *     `\lim_{n \to \infty}`, which we set tight as `\lim_{n\to\infty}` (documented
 *     in §8). Depth gating avoids a depth-dependent, ad-hoc rule.
 *   - around a differential thin space (`\, dx`), at any depth;
 *   - between a control word and a following letter, where it is REQUIRED to keep
 *     the tokenization (`\sin x`, `\alpha x`), at any depth.
 * Everything else is juxtaposed with no space (`2x`, `\frac{a}{b}`, `x^{2}dx`).
 */
function emit(tokens: Token[]): string {
  const binary = tokens.map((_token, index) => isBinaryAt(tokens, index));
  const depthBefore: number[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    depthBefore[i] = depth;
    if (tokens[i].kind === "lbrace") {
      depth += 1;
    } else if (tokens[i].kind === "rbrace") {
      depth = Math.max(0, depth - 1);
    }
  }

  let result = "";
  for (let i = 0; i < tokens.length; i += 1) {
    if (i > 0) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      const binaryCur = binary[i] && depthBefore[i] === 0;
      const binaryPrev = binary[i - 1] && depthBefore[i - 1] === 0;
      const prevThin = prev.kind === "csymbol" && prev.value === THIN_SPACE;
      const curThin = cur.kind === "csymbol" && cur.value === THIN_SPACE;
      const tokenizationSpace = prev.kind === "csname" && cur.kind === "char" && isLetter(cur.value);
      if (binaryCur || binaryPrev || prevThin || curThin || tokenizationSpace) {
        result += " ";
      }
    }
    result += tokenText(tokens[i]);
  }
  return result.trim();
}

/** Canonicalize the body of one inline-math span (no surrounding `$`). */
function canonicalizeMathSpan(body: string): string {
  let tokens = tokenizeMath(body);
  tokens = aliasMacros(tokens);
  tokens = tokens.filter((token) => !isManualSpacingSymbol(token));
  markDifferentials(tokens); // uses whitespace — before dropping spaces
  tokens = tokens.filter((token) => token.kind !== "space");
  tokens = braceArgs(tokens);
  tokens = insertDifferentialSpacing(tokens);
  return emit(tokens);
}

/**
 * Split the input into prose and inline-math segments, then canonicalize only the
 * math. Handles `$…$`, `\(…\)` (→ `$…$`) and `\$` (literal). An unbalanced `$`
 * leaves the remainder as prose. Never throws.
 */
function canonicalizeSegments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    // Escaped dollar: a literal `$` in prose, copied through untouched.
    if (char === "\\" && text[i + 1] === "$") {
      result += "\\$";
      i += 2;
      continue;
    }

    // `\(…\)` inline math, normalized to `$…$`.
    if (char === "\\" && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close === -1) {
        // Unbalanced: leave the rest as prose.
        result += text.slice(i);
        break;
      }
      const body = text.slice(i + 2, close);
      result += "$" + canonicalizeMathSpan(body) + "$";
      i = close + 2; // past "\)"
      continue;
    }

    // `$…$` inline math.
    if (char === "$") {
      const close = findClosingDollar(text, i + 1);
      if (close === -1) {
        // Unbalanced: leave the rest as prose.
        result += text.slice(i);
        break;
      }
      const body = text.slice(i + 1, close);
      result += "$" + canonicalizeMathSpan(body) + "$";
      i = close + 1;
      continue;
    }

    result += char;
    i += 1;
  }
  return result;
}

/** Index of the next unescaped `$` at or after `from`, or -1. */
function findClosingDollar(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1; // skip the escaped char
      continue;
    }
    if (text[i] === "$") {
      return i;
    }
  }
  return -1;
}

/** Index of the `\)` closing an `\(`, or -1. Returns the index of the backslash. */
function findClosingParen(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i += 1) {
    if (text[i] === "\\" && text[i + 1] === ")") {
      return i;
    }
    if (text[i] === "\\") {
      i += 1; // skip other escapes
    }
  }
  return -1;
}

/**
 * Canonicalize LaTeX to the fixed style subset (§8). Pure, idempotent, total.
 * Prose (anything outside `$…$` / `\(…\)`) is returned verbatim, so a string with
 * no maths — including raw STT output in scoring — is returned unchanged.
 */
export function canonicalizeLatex(text: string): string {
  try {
    return canonicalizeSegments(text);
  } catch {
    // Totality guarantee: no input may throw. The logic above is total by
    // construction; this is a defensive backstop that returns the input intact.
    return text;
  }
}
