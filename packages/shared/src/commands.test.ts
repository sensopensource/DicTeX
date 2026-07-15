import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMANDS,
  SENTINEL_PATTERN,
  containsSentinel,
  expandCommands,
  extractCommands,
  restoreCommandWords,
} from "./commands.js";
import { normalizeTranscript } from "./normalizer.js";

// PUA sentinels are invisible in editors and terminals, so they are NEVER written
// as literal characters anywhere in this repo — always as escapes. In tests we
// build the expected sentinel from a code point so the test source stays clean
// too, and cross-check it against the shared table.
const NL = String.fromCodePoint(0xe000); // U+E000 — retour à la ligne
const PARA = String.fromCodePoint(0xe001); // U+E001 — nouveau paragraphe

const byCanonical = (canonical: string) => {
  const command = COMMANDS.find((entry) => entry.canonical === canonical);
  assert.ok(command, `expected a command for "${canonical}"`);
  return command;
};

test("command table: two commands on distinct PUA sentinels in U+E000-U+E00F", () => {
  assert.equal(COMMANDS.length, 2);
  const sentinels = new Set<string>();
  for (const command of COMMANDS) {
    assert.equal(command.sentinel.length, 1, "a sentinel is one code point");
    const code = command.sentinel.codePointAt(0)!;
    assert.ok(code >= 0xe000 && code <= 0xe00f, `sentinel U+${code.toString(16)} in reserved block`);
    assert.ok(!sentinels.has(command.sentinel), "sentinels are unique");
    sentinels.add(command.sentinel);
    assert.equal(typeof command.expansion, "string");
  }
  assert.equal(byCanonical("retour à la ligne").sentinel, NL);
  assert.equal(byCanonical("nouveau paragraphe").sentinel, PARA);
  assert.equal(byCanonical("retour à la ligne").expansion, "\n");
  assert.equal(byCanonical("nouveau paragraphe").expansion, "\n\n");
});

test("extractCommands: spoken command becomes its sentinel", () => {
  assert.equal(extractCommands("retour à la ligne x au carré"), `${NL} x au carré`);
  assert.equal(extractCommands("nouveau paragraphe donc"), `${PARA} donc`);
});

test("extractCommands consumes only an STT sentence period attached to a command", () => {
  assert.equal(extractCommands("A. retour à la ligne. B."), `A. ${NL} B.`);
  assert.equal(extractCommands("retour à la ligne ?"), `${NL} ?`);
  assert.equal(extractCommands("retour à la ligne, puis"), `${NL}, puis`);
});

test("extractCommands: matches case-insensitively and tolerates whitespace runs", () => {
  assert.equal(extractCommands("RETOUR À LA LIGNE x"), `${NL} x`);
  assert.equal(extractCommands("Retour   à\tla\nligne x"), `${NL} x`);
});

test("extractCommands: word-bounded — never fires glued inside a larger word", () => {
  // "ligne" glued to "tte" must not match, nor "retour" glued to a preceding letter.
  assert.equal(extractCommands("retour à la lignette"), "retour à la lignette");
  assert.equal(extractCommands("preretour à la ligne").includes(NL), false);
});

test("extractCommands: leaves ordinary maths prose untouched (no false positives)", () => {
  for (const text of ["le point A", "le point d'intersection", "x au carré plus deux", "de plus en plus"]) {
    assert.equal(extractCommands(text), text);
    assert.equal(containsSentinel(extractCommands(text)), false);
  }
});

test("extractCommands is idempotent (an existing sentinel is left alone)", () => {
  const once = extractCommands("retour à la ligne x");
  assert.equal(extractCommands(once), once);
});

test("expandCommands: sentinel becomes its real effect", () => {
  assert.equal(expandCommands(`${NL} x au carré`), "\n x au carré");
  assert.equal(expandCommands(`${PARA} donc`), "\n\n donc");
});

test("round trip: extract then expand yields the real line break plus the rest", () => {
  assert.equal(expandCommands(extractCommands("retour à la ligne x au carré")), "\n x au carré");
});

test("expandCommands is a TOTAL sentinel eliminator (the store-safety guarantee)", () => {
  // Every code point in the reserved block, known or reserved-but-unused, must be
  // gone after expansion. This is what makes 'route through expandCommands before
  // storing' a hard guarantee that no sentinel reaches a store.
  let all = "start";
  for (let code = 0xe000; code <= 0xe00f; code += 1) {
    all += String.fromCodePoint(code);
  }
  all += "end";
  assert.equal(containsSentinel(all), true);
  const expanded = expandCommands(all);
  assert.equal(containsSentinel(expanded), false);
  assert.equal(SENTINEL_PATTERN.test(expanded), false);
  // Known sentinels expand to their effect; unused reserved ones are dropped.
  assert.equal(expanded, `start\n\n\nend`);
});

test("containsSentinel detects only the reserved block", () => {
  assert.equal(containsSentinel("plain text"), false);
  assert.equal(containsSentinel(extractCommands("retour à la ligne x")), true);
});

// restoreCommandWords (issue #101): the sentinel -> WORDS direction, as
// opposed to expandCommands's sentinel -> EFFECT direction. This is what lets
// the Lab dataset builder prefill Layer 2 from the full pipeline output
// (which introduces a sentinel via command extraction) while keeping the
// storage rule: the builder must hold canonical words, never a sentinel and
// never a literal command effect.

test("restoreCommandWords: sentinel becomes its canonical spoken phrase", () => {
  assert.equal(restoreCommandWords(`${NL} x au carré`), "retour à la ligne x au carré");
  assert.equal(restoreCommandWords(`${PARA} donc`), "nouveau paragraphe donc");
});

test("restoreCommandWords is the exact inverse of extractCommands (round trip)", () => {
  for (const text of [
    "retour à la ligne x au carré plus deux",
    "nouveau paragraphe on a f de x",
    "x au carré plus deux",
  ]) {
    assert.equal(restoreCommandWords(extractCommands(text)), text);
  }
});

test("restoreCommandWords is a TOTAL sentinel eliminator (never leaks a sentinel)", () => {
  let all = "start";
  for (let code = 0xe000; code <= 0xe00f; code += 1) {
    all += String.fromCodePoint(code);
  }
  all += "end";
  const restored = restoreCommandWords(all);
  assert.equal(containsSentinel(restored), false);
  assert.equal(SENTINEL_PATTERN.test(restored), false);
  // Known sentinels expand to their canonical words; unused reserved ones are
  // dropped, same convention as expandCommands.
  assert.equal(restored, "startretour à la lignenouveau paragrapheend");
});

test("restoreCommandWords never produces a literal newline (distinct from expandCommands)", () => {
  const withSentinel = extractCommands("retour à la ligne x au carré");
  const restored = restoreCommandWords(withSentinel);
  assert.equal(restored.includes("\n"), false);
  assert.equal(restored, "retour à la ligne x au carré");
  // Contrast with expandCommands, which DOES produce the real line break —
  // that is the behavior the builder must never apply to a prefill.
  assert.equal(expandCommands(withSentinel).includes("\n"), true);
});

// Source hygiene: this repo's rule is that a literal PUA character must never
// appear in source (it is invisible and slips into files unnoticed). Enforce it
// on the command sources themselves so a stray literal is caught in CI.
test("source hygiene: no literal PUA character in the command sources", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    "commands.ts",
    "commands.test.ts",
    "datasetExport.ts",
    "datasetExport.test.ts",
    "textDiff.ts",
    "textDiff.test.ts",
    "normalizer.ts",
    "normalizer.test.ts",
  ];
  for (const file of files) {
    const contents = readFileSync(path.join(here, file), "utf8");
    for (let i = 0; i < contents.length; i += 1) {
      const code = contents.codePointAt(i)!;
      assert.ok(
        !(code >= 0xe000 && code <= 0xf8ff),
        `literal PUA U+${code.toString(16)} found in ${file}; write it as a \\uXXXX escape`,
      );
    }
  }
});

// Lab dataset builder Layer 2 prefill (issue #101): this is the exact sequence
// apps/lab/src/main/index.ts's `dataset-builder:prefill-layer2` IPC handler
// runs — the FULL normalizer pipeline (dictionary -> command extraction ->
// regex) over Layer 1, then `restoreCommandWords` on the output — so this is
// the integration-level assertion that a prefilled Layer 2 upholds the
// storage rule (design doc §4): never a sentinel, never a literal command
// effect. Points the normalizer at a directory that does not exist, same
// pattern as datasetExport.test.ts, so the personal dictionary degrades to
// passthrough and the rules degrade to the built-in DEFAULT_RULES — this
// reproduces the pipeline apps/dictex would serve without depending on any
// on-disk config.
const ABSENT_NORMALIZER_CONFIG = {
  dictionaryPath: path.join(tmpdir(), "dictex-issue-101-absent", "dictionary.json"),
  rulesPath: path.join(tmpdir(), "dictex-issue-101-absent", "rules.json"),
};

test("Lab Layer 2 prefill: full pipeline + restoreCommandWords carries no sentinel and no command-induced newline", async () => {
  // Matches the worked example in docs/dataset-and-normalization-design.md §7:
  // the regex handles "au carré" (an operand it recognizes) but not "plus deux"
  // (spelled out, not a digit/letter operand), and the spoken command survives
  // as canonical words, never a sentinel or a real line break. Since #107 the
  // regex emits canonical LaTeX wrapped in "$…$" rather than Unicode.
  const layer1 = "retour à la ligne x au carré plus deux";
  const result = await normalizeTranscript(layer1, ABSENT_NORMALIZER_CONFIG);

  // Sanity: the pipeline's raw output DOES contain a sentinel at this point
  // (command extraction is a real pipeline layer) — the assertion below is
  // about what reaches the prefill, not the intermediate pipeline output.
  assert.equal(containsSentinel(result.output), true);

  const prefill = restoreCommandWords(result.output);

  assert.equal(containsSentinel(prefill), false);
  assert.equal(SENTINEL_PATTERN.test(prefill), false);
  assert.equal(prefill.includes("\n"), false);
  assert.equal(prefill, "retour à la ligne $x^{2}$ plus deux");
});

test("Lab Layer 2 prefill: no change from Layer 1 still carries no sentinel (regex/dictionary passthrough)", async () => {
  const layer1 = "un texte tout à fait ordinaire";
  const result = await normalizeTranscript(layer1, ABSENT_NORMALIZER_CONFIG);
  const prefill = restoreCommandWords(result.output);

  assert.equal(containsSentinel(prefill), false);
  assert.equal(prefill.includes("\n"), false);
  assert.equal(prefill, layer1);
});
