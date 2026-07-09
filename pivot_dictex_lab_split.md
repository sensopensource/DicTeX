# Pivot: split DicTeX (consumer) from DicTeX Lab (tooling)

Status: adopted 2026-07-09. Supersedes the "in-app dataset enrichment" direction
of `pivot_strategique_stt_normalisation.md` for *where* dataset/benchmark work
lives. The normalization strategy (dictionary → regex → seq2seq) is unchanged;
only its evaluation/training tooling moves out of the consumer app.

## Why

DicTeX had grown into two products in one: a consumer dictation tool **and** an
ML bench (benchmark, dataset building, model monitoring). That coupling is the
main source of complexity and of the recording bugs. We split them.

## Objective

- **DicTeX = minimal consumer dictation tool**: voice → STT → normalizer
  (dictionary + regex) → insert. Nothing ML-ops.
- **All benchmark + dataset-building + model-monitoring complexity → a separate
  "DicTeX Lab" app.**
- The Lab has **no microphone**: it consumes DicTeX's real transcriptions (run
  DicTeX in the background, paste/collect) and reads DicTeX's local data folder.
- The in-app "dataset recording" concept is **removed** from DicTeX.

## Locked decisions

1. **Monorepo** (npm workspaces): both apps + shared packages in this repo.
2. **Lab reads DicTeX's data folder** (configurable path) for audio + raw
   transcripts; it keeps its own store for corrections/splits/benchmarks/exports.
3. **DicTeX stripped to the minimum**, with all ML complexity hidden behind an
   **"Open Lab"** button. The only rich thing kept on Home is a **collapsible
   recent-history** with **copy / copy-raw / play only** — no correct, no
   benchmark, no split, no correction-kind.

## Target architecture

```
DicTeX/ (monorepo)
├─ apps/
│  ├─ dictex/      # consumer: dictation + normalizer + model select + Open Lab
│  └─ lab/         # tooling: benchmark + dataset builder + monitoring (no mic)
├─ packages/
│  ├─ engine/      # Python STT (faster-whisper + Vosk) — shared
│  └─ shared/      # TS: event schema, dataset/test_frozen format, CER/WER scoring
```

**Data contract (one-directional, file-based — zero code coupling):**

- DicTeX writes raw dictation data (`audio_segment`, `stt_result`,
  `normalization_result`) to its data folder.
- The Lab reads that folder **read-only** (audio + raw transcripts) and keeps its
  **own** store for corrections, splits, benchmark results, datasets, exports.
- The Lab exports datasets in the existing **test_frozen-compatible** JSONL
  format (`datasetExport.ts`).
- DicTeX never depends on the Lab (the "Open Lab" button just launches it).

## DicTeX after the pivot (consumer)

Keep: mic → faster-whisper → normalizer (dictionary + regex, the product value)
→ clipboard + auto-paste; global hotkey; STT model selector; dictionary/rules
files + open buttons; minimal diagnostics + open data folder/log; raw logging
(`audio_segment`, `stt_result`, `normalization_result`); **one Home view**;
a **collapsible recent-history (copy / copy-raw / play only)**; an **"Open Lab"**
button.

Remove (→ Lab): Benchmark view + all benchmark IPC/modules; the Dataset
enrichment *recording*; dataset export; split membership (train/validation/
test_frozen); typed corrections + correction-kind UI; history actions beyond
copy/play (correct, benchmark, set-split); Vosk provider.

## DicTeX Lab (new, no microphone)

Inputs: paste a transcription from DicTeX, or pick a DicTeX-recorded segment
(read from DicTeX's data folder → audio + raw transcript). Features:

1. **Dataset builder** — choose a reference model, enter the two layers (literal
   + notation) by hand, attach/paste the transcription, export →
   test_frozen-compatible JSONL.
2. **Benchmark** — run STT candidates (faster-whisper/Vosk) over segments/a
   dataset; CER/WER; summary; error analysis; candidate selection.
3. **Monitoring** — candidate summaries/selections over time.

## Phases (each: green typecheck+build, one PR, `main` always shippable)

- **Phase 0 — stabilize now**: remove the in-app two-layer *recording* capture
  from DicTeX (keep the #44 export panel for now). The buggy surface is gone.
- **Phase 1 — monorepo skeleton**: npm workspaces; current app → `apps/dictex`;
  `engine/` → `packages/engine`; create `packages/shared`. No behavior change.
- **Phase 2 — create `apps/lab`**: scaffold the 2nd Electron app; move Benchmark
  + dataset + corrections + splits + Vosk + export into it; read DicTeX's data
  folder + own store.
- **Phase 3 — slim DicTeX**: reduce `main.tsx` to Home (dictation + normalizer +
  model select + Open Lab + collapsible copy/play history); strip benchmark/
  dataset/correction/split IPC from `index.ts`/`preload`; delete now-unused
  modules.
- **Phase 4 — Lab dataset builder + benchmark**: manual two-layer entry + export;
  benchmark from DicTeX's data folder.
- **Phase 5 (later)** — integrate selected/fine-tuned models back into DicTeX.

## Revertability

- The buggy recording (#66 / PR #71, plus PR #73's tweaks) is removed cleanly in
  Phase 0 — it lived in `DatasetView` + two `transcribeAudio` options; the #44
  export panel is separable and stays.
- The broader benchmark/dataset code is interleaved across shared files
  (`main.tsx`, `index.ts`, `preload`, `localEvents`), so Phases 1–3 are an
  **extraction + slim**, not a `git revert` of old PRs — done phase-by-phase with
  a green build at each step.
