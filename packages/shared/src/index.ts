// DicTeX shared package (pivot Phase 2, issue #76) — main-process (".") barrel.
//
// Cross-app TypeScript contracts shared by `apps/dictex` and `apps/lab` main
// processes: the JSONL event schema + append-only derivations (localEvents),
// CER/WER scoring (sttScoring), STT candidate summarization (benchmarkSummary),
// the read-only projection of one tracked run (benchmarkRunDetail),
// the stage-aware append-only run contract + common Results projection
// (benchmarkContract),
// portable per-run LLM export construction (benchmarkRunExport),
// the text-to-text normalization pipeline (normalizer — imports node:fs; the ONE
// dictionary -> command extraction -> regex fold DicTeX serves and the dataset
// export replays, issue #100), the test_frozen-compatible dataset export builder
// (datasetExport), the local STT engine invocation (sttEngine — imports
// node:child_process/fs), and the "live benchmark run" IPC contract types
// (benchmarkTypes). Both apps import from here so they do not diverge — see
// pivot_dictex_lab_split.md / AGENTS.md.
//
// Renderer-only (browser-safe) helpers live in dedicated subpath exports so
// they never pull node built-ins into a renderer bundle:
//   `@dictex/shared/commands`       — command table + sentinel extract/expand
//   `@dictex/shared/normalizerBenchmark` — pure benchmark provenance + summaries
//   `@dictex/shared/latex`          — LaTeX canonicalizer (#106)
//   `@dictex/shared/formatting`     — presentation string formatting
//   `@dictex/shared/errorAnalysis`  — heuristic benchmark error analysis
//   `@dictex/shared/textDiff`       — word-level diff (Lab Layer 2 prefill, #101)
// Those modules only TYPE-import from the node-touching modules above.
// `commands` is pure (no node built-ins) and is also re-exported here so main-
// process code can pull it from the barrel; see `@dictex/shared/commands` for
// renderer-safe use.
export * from "./commands.js";
export * from "./latex.js";
export * from "./localEvents.js";
export * from "./sttScoring.js";
export * from "./benchmarkSummary.js";
export * from "./benchmarkRunDetail.js";
export * from "./benchmarkContract.js";
export * from "./normalizerBenchmark.js";
export * from "./benchmarkRunExport.js";
export * from "./normalizerBenchmarkRunExport.js";
export * from "./normalizer.js";
export * from "./datasetExport.js";
export * from "./sttEngine.js";
export * from "./benchmarkTypes.js";
