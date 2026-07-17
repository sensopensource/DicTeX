import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findProductDecisionDrift, loadBundledRulesContract } from "./lintProductDecisions.ts";

const contract = (version: string, semanticVersion: string, hash: string) =>
  `## DEC-NORM-003 — Test\n\n<!-- dictex-contract: normalizer-bundled-rules version=${version} semantic-version=${semanticVersion} sha256=${hash} -->\n`;

test("accepts a product decision contract that matches the shared normalizer", async () => {
  const actual = await loadBundledRulesContract();
  assert.deepEqual(
    findProductDecisionDrift(contract(String(actual.bundledRulesVersion), actual.semanticVersion, actual.bundledRulesHash), actual),
    [],
  );
});

test("reports every announced normalizer value that has drifted", async () => {
  const actual = await loadBundledRulesContract();
  const drifts = findProductDecisionDrift(
    contract(String(actual.bundledRulesVersion + 1), `${actual.semanticVersion}-unexpected`, "0".repeat(64)),
    actual,
  );

  assert.deepEqual(drifts, [
    { decision: "DEC-NORM-003", line: 3, field: "bundled rules version", announced: String(actual.bundledRulesVersion + 1), calculated: String(actual.bundledRulesVersion) },
    { decision: "DEC-NORM-003", line: 3, field: "semantic version", announced: `${actual.semanticVersion}-unexpected`, calculated: actual.semanticVersion },
    { decision: "DEC-NORM-003", line: 3, field: "bundled rules SHA-256", announced: "0".repeat(64), calculated: actual.bundledRulesHash },
  ]);
});

test("the executable fails when the versioned product decision contract drifts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dictex-product-decisions-test-"));
  try {
    await mkdir(path.join(directory, "docs"));
    await writeFile(
      path.join(directory, "docs", "product-decisions.md"),
      contract("0", "intentionally-invalid", "0".repeat(64)),
    );
    const scriptPath = fileURLToPath(new URL("./lintProductDecisions.ts", import.meta.url));
    const tsxCliPath = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCliPath, scriptPath], {
        cwd: directory,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /DEC-NORM-003/);
    assert.match(result.stderr, /bundled rules version/);
    assert.match(result.stderr, /semantic version/);
    assert.match(result.stderr, /bundled rules SHA-256/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
