# Pivot: split DicTeX (consumer) from DicTeX Lab (tooling)

> **Archive historique.** Pivot adopté le 9 juillet 2026 et entièrement terminé
> par les PR #74, #79, #80, #81 et #82. La séparation reste une décision
> d'architecture, mais la priorité actuelle vit dans `docs/roadmap.md`. Les
> nouveaux travaux et leur documentation sont rédigés en français.

Ce pivot a remplacé la capture de données intégrée à DicTeX pour tout ce qui
concerne l'emplacement des corrections, mesures et exports. La stratégie de
normalisation dictionnaire → regex → seq2seq reste inchangée ; seul l'outillage
d'évaluation et d'apprentissage a quitté l'application quotidienne.

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

1. **Outil de saisie** — sélectionner un segment DicTeX ou coller un texte,
   saisir les deux couches, choisir un ensemble et exporter au format JSONL
   compatible avec `test_frozen`. Le champ obsolète `referenceModel` a été
   retiré par #83.
2. **Banc d'essai** — exécuter les candidats STT faster-whisper ou Vosk sur des
   segments, puis calculer CER/WER, résumé, analyse d'erreurs et sélection.
3. **Suivi** — conserver les résumés et sélections de candidats dans le temps.

## Phases — toutes terminées

- **Phase 0 — terminée, PR #74** : retrait de la capture deux-couches intégrée à
  DicTeX.
- **Phase 1 — terminée, #75 / PR #79** : création du monorepo npm et déplacement
  vers `apps/dictex`, `packages/engine` et `packages/shared`.
- **Phase 2 — terminée, #76 / PR #80** : création d'`apps/lab`, déplacement des
  corrections, mesures, ensembles, Vosk et exports, avec stockage propre.
- **Phase 3 — terminée, #77 / PR #81** : réduction de DicTeX à la dictée, au
  normaliseur, au choix du modèle, à l'historique copie/réécoute et à l'ouverture
  du Lab.
- **Phase 4 — terminée, #78 / PR #82** : saisie manuelle des deux couches,
  export et banc d'essai depuis le dossier de données DicTeX.
- **Ancienne phase 5** — remplacée par `docs/roadmap.md` ; aucun modèle n'est
  intégré avant que la boucle quotidienne, les données et les mesures aient
  franchi leurs portes de sortie.

## Revertability

- The buggy recording (#66 / PR #71, plus PR #73's tweaks) is removed cleanly in
  Phase 0 — it lived in `DatasetView` + two `transcribeAudio` options; the #44
  export panel is separable and stays.
- The broader benchmark/dataset code is interleaved across shared files
  (`main.tsx`, `index.ts`, `preload`, `localEvents`), so Phases 1–3 are an
  **extraction + slim**, not a `git revert` of old PRs — done phase-by-phase with
  a green build at each step.
