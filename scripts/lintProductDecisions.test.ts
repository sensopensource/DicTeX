import assert from "node:assert/strict";
import test from "node:test";
import { findProductDecisionDrift, type NormalizerBundledRulesContract } from "./lintProductDecisions.ts";

const actual: NormalizerBundledRulesContract = {
  bundledRulesVersion: 4,
  semanticVersion: "dictex-deterministic-pipeline-v6",
  bundledRulesHash: "9827105541440f074202db1eb4b5aaf6650172a349e1096ae2e0ccb59b9b57a1",
};

const contract = (version = "4", semanticVersion = actual.semanticVersion, hash = actual.bundledRulesHash) =>
  `## DEC-NORM-003 — Test\n\n<!-- dictex-contract: normalizer-bundled-rules version=${version} semantic-version=${semanticVersion} sha256=${hash} -->\n`;

test("accepts a product decision contract that matches the shared normalizer", () => {
  assert.deepEqual(findProductDecisionDrift(contract(), actual), []);
});

test("reports every announced normalizer value that has drifted", () => {
  const drifts = findProductDecisionDrift(
    contract("3", "dictex-deterministic-pipeline-v5", "8686d68c18668b5c1e5edd72598f235410aac49ca411710ba7e9dfc77f81170f"),
    actual,
  );

  assert.deepEqual(drifts, [
    { decision: "DEC-NORM-003", line: 3, field: "bundled rules version", announced: "3", calculated: "4" },
    { decision: "DEC-NORM-003", line: 3, field: "semantic version", announced: "dictex-deterministic-pipeline-v5", calculated: "dictex-deterministic-pipeline-v6" },
    { decision: "DEC-NORM-003", line: 3, field: "bundled rules SHA-256", announced: "8686d68c18668b5c1e5edd72598f235410aac49ca411710ba7e9dfc77f81170f", calculated: actual.bundledRulesHash },
  ]);
});
