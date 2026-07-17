import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTranscriptNormalizer } from "../packages/shared/src/normalizer.ts";

export type NormalizerBundledRulesContract = {
  bundledRulesVersion: number;
  semanticVersion: string;
  bundledRulesHash: string;
};

export type ProductDecisionDrift = {
  decision: string;
  line: number;
  field: "bundled rules version" | "semantic version" | "bundled rules SHA-256";
  announced: string;
  calculated: string;
};

const CONTRACT_PATTERN = /<!--\s*dictex-contract:\s*normalizer-bundled-rules\s+version=(\d+)\s+semantic-version=([^\s]+)\s+sha256=([0-9a-f]{64})\s*-->/g;
const DECISION_HEADING_PATTERN = /^##\s+(DEC-NORM-\d+)\b/mg;

export function findProductDecisionDrift(
  document: string,
  actual: NormalizerBundledRulesContract,
): ProductDecisionDrift[] {
  const drifts: ProductDecisionDrift[] = [];
  for (const match of document.matchAll(CONTRACT_PATTERN)) {
    const offset = match.index ?? 0;
    const precedingDocument = document.slice(0, offset);
    const headings = [...precedingDocument.matchAll(DECISION_HEADING_PATTERN)];
    const decision = headings.at(-1)?.[1] ?? "unknown decision";
    const line = precedingDocument.split("\n").length;
    const [, version, semanticVersion, hash] = match;
    const comparisons: Array<[ProductDecisionDrift["field"], string, string]> = [
      ["bundled rules version", version!, String(actual.bundledRulesVersion)],
      ["semantic version", semanticVersion!, actual.semanticVersion],
      ["bundled rules SHA-256", hash!, actual.bundledRulesHash],
    ];
    for (const [field, announced, calculated] of comparisons) {
      if (announced !== calculated) {
        drifts.push({ decision, line, field, announced, calculated });
      }
    }
  }
  return drifts;
}

export async function loadBundledRulesContract(): Promise<NormalizerBundledRulesContract> {
  const directory = await mkdtemp(path.join(tmpdir(), "dictex-product-decisions-"));
  try {
    const normalizer = await createTranscriptNormalizer({
      dictionaryPath: path.join(directory, "dictionary.json"),
      rulesPath: path.join(directory, "rules.json"),
    });
    return {
      bundledRulesVersion: normalizer.version.bundledRulesVersion,
      semanticVersion: normalizer.version.semanticVersion,
      bundledRulesHash: normalizer.version.bundledRulesHash,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const documentPath = path.resolve(process.cwd(), "docs/product-decisions.md");
  const document = await readFile(documentPath, "utf8");
  if ([...document.matchAll(CONTRACT_PATTERN)].length === 0) {
    console.error("No normalizer product decision contract was found in docs/product-decisions.md.");
    process.exitCode = 1;
    return;
  }
  const drifts = findProductDecisionDrift(document, await loadBundledRulesContract());
  if (drifts.length === 0) {
    console.log("Product decision contracts match the shared normalizer.");
    return;
  }

  for (const drift of drifts) {
    console.error(
      `${drift.decision} (docs/product-decisions.md:${drift.line}) ${drift.field}: announced ${drift.announced}, calculated ${drift.calculated}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
