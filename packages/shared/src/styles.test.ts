import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── The reserved math typography contract ────────────────────────────────────
// The italic math rules are declared before any renderer emits math elements:
// today's normalized output is literal LaTeX inside prose containers. That gap
// is deliberate (docs/product-decisions.md, "Direction « Cahier Seyès »"), but
// it leaves a live trap — making a formula "look mathy" in the history panel is
// one selector away, and a transcript line mixes prose with its LaTeX, so that
// selector would italicize the sentence around the formula. These tests pin the
// contract to math elements while it waits for a renderer.

const stylesheet = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

type Rule = { selector: string; body: string };

/** Rule blocks of a stylesheet, comments stripped and at-rules unwrapped. */
function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const open: string[] = [];
  let buffer = "";
  for (const char of source) {
    if (char === "{") {
      open.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      const selector = open.pop() ?? "";
      // An at-rule (@media …) wraps rules rather than declaring any itself.
      if (selector && !selector.startsWith("@")) rules.push({ selector, body: buffer.trim() });
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return rules;
}

/** Elements a math renderer emits — the only things allowed to go italic. */
const MATH_ELEMENTS = new Set(["math", "mjx-container"]);

test("italic math typography only ever targets real math elements", () => {
  const mathStyled = parseRules(stylesheet).filter(
    (rule) => rule.body.includes("var(--font-math)") || /font-style:\s*italic/.test(rule.body),
  );
  assert.ok(mathStyled.length > 0, "the shared stylesheet should still declare the math contract");

  for (const rule of mathStyled) {
    for (const selector of rule.selector.split(",").map((part) => part.trim())) {
      assert.ok(
        MATH_ELEMENTS.has(selector),
        `"${selector}" is not a math element: italic math must never reach the prose mixed into a LaTeX line`,
      );
    }
  }
});

test("--font-math falls back to the shared serif stack", () => {
  const root = parseRules(stylesheet).find((rule) => rule.selector === ":root");
  assert.ok(root, ":root should define the shared tokens");
  // Math keeps the page's serif when no math face is installed, rather than
  // dropping to a default the rest of the paper never uses.
  assert.match(root.body, /--font-math:[^;]*var\(--font-serif\)/);
});
