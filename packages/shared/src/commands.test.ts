import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMANDS,
  SENTINEL_PATTERN,
  containsSentinel,
  expandCommands,
  extractCommands,
} from "./commands.js";

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

// Source hygiene: this repo's rule is that a literal PUA character must never
// appear in source (it is invisible and slips into files unnoticed). Enforce it
// on the command sources themselves so a stray literal is caught in CI.
test("source hygiene: no literal PUA character in the command sources", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = ["commands.ts", "commands.test.ts", "datasetExport.ts", "datasetExport.test.ts"];
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
