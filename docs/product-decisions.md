# Product Decisions

This document captures the product and implementation context that future agents should preserve when working on DicTeX.

> **Direction actuelle :** `docs/roadmap.md` est la source canonique de l'ordre
> des travaux. Ce document conserve les décisions durables ; les sections
> anglaises antérieures restent comme historique. Toute nouvelle décision est
> rédigée en français conformément à `CONTRIBUTING.md`.

## Décisions de la boucle quotidienne — 10 juillet 2026

- **Cahier externe :** Typora est le premier environnement réel. Zettlr est le
  repli si une friction concrète apparaît. DicTeX ne possède toujours pas les
  documents.
- **Format :** prose Markdown et LaTeX canonique. `$…$` est implémenté pour les
  mathématiques en ligne ; un mécanisme explicite `$$…$$` est la prochaine
  extension du contrat. Le rendu appartient au cahier, pas au normaliseur.
- **Contrôle :** le normaliseur est activable manuellement et son état persiste
  (#105). Aucun changement automatique selon l'application cible pour l'instant.
- **Interaction :** les libellés anglais Start/Stop doivent partager le même
  état entre le bouton et `Win+Alt+Space` (#96).
- **Latence :** DicTeX doit garder un seul modèle STT actif dans un processus
  Python persistant. Le chargement initial et la transcription chaude sont deux
  mesures distinctes.
- **Contexte STT :** le `initial_prompt` de faster-whisper est choisi par une
  comparaison sur `validation` (#94), jamais par intuition ni sur
  `test_frozen`.
- **Correction :** la correction visible reste d'abord dans le cahier ; le Lab
  qualifie ensuite les exemples en couches acoustique et mathématique.
- **Apprentissage :** règles d'abord, petit modèle sur le résidu ensuite,
  adaptation acoustique en dernier et seulement si le résidu le justifie.
- **Langue du projet :** commits, tickets, demandes de fusion, revues et
  documents en français ; code, commentaires techniques, tests, journaux et
  interface en anglais pour l'instant.

## DicTeX / Lab split (monorepo)

DicTeX est séparé en deux applications Electron dans un même monorepo npm
(voir `pivot_dictex_lab_split.md` et la « Direction actuelle » d'`AGENTS.md`) :

- **`apps/dictex`** — the consumer dictation tool (voice → STT → normalizer →
  insert). Has the microphone, hotkey, clipboard/paste, and normalizer.
- **`apps/lab`** — **DicTeX Lab**, the ML tooling app (pivot Phase 2, #76). No
  microphone: it hosts the STT benchmark (segment/batch, summary, error
  analysis, candidate selection), typed corrections, benchmark-set split
  membership, the Vosk provider, and the dataset export.

Data contract (one-directional, file-based, zero code coupling): the Lab reads
DicTeX's local data folder **read-only** (audio + `stt_result` /
`normalization_result` events) and keeps its **own** store for everything it
writes — corrections, splits, benchmark results, candidate selections, dataset
exports, and its own settings — under its own Electron `userData`
(`%APPDATA%/dictex-lab-app/data`), never DicTeX's `%APPDATA%/dictex-app/data`.
The DicTeX data folder path is configurable in the Lab (default
`%APPDATA%/dictex-app/data`). Both apps import all derivation/scoring/export
logic from `packages/shared` so the two apps cannot diverge; DicTeX never
depends on the Lab.

Phase 2 (#76) added the Lab and factored the shared logic. Phase 3 (#77) then
**removed** the benchmark/dataset/correction/split features from `apps/dictex`,
leaving it a pure consumer dictation tool (single Home view, collapsible
Copy/Copy-raw/Play history, and an "Open Lab" launcher). DicTeX Lab is now the
**sole** tooling surface for benchmark, typed corrections, splits, and dataset
export; DicTeX only writes raw dictation data (`audio_segment`, `stt_result`,
`normalization_result`) that the Lab reads. **All four pivot phases (0-4) are
merged** — DicTeX is the lean consumer app and the Lab owns benchmark + dataset
building + export.

## Product Shape

DicTeX is an OpenWhispr-like dictation layer for mathematical writing.

It is not document-first. In the MVP, DicTeX should not own, manage, or edit full documents. It listens, transcribes, transforms later, and inserts output into the currently active application.

Current product loop:

```text
voix
-> STT local
-> normaliseur déterministe facultatif
-> presse-papiers / application active
-> événements locaux
-> correction visible dans un cahier externe
-> qualification typée et évaluation dans DicTeX Lab
```

Future product loop:

```text
voix
-> STT local maintenu en mémoire
-> texte littéral conservé
-> règles déterministes
-> modèle résiduel texte-vers-LaTeX
-> Markdown + LaTeX dans un cahier externe
-> correction rapide + données typées dans le Lab
-> règles, puis modèles seulement après mesure
```

## Current MVP Reality

The implementation currently uses:

- Electron + React + TypeScript for the desktop app.
- Python sidecar for the local STT engine.
- faster-whisper as the local STT engine.
- JSONL event logging for local data capture.
- Windows-first auto-paste.

Do not migrate to Tauri, SQLite, or a document editor unless there is a specific issue for that migration.

## Data Model Decisions

The MVP is session-first, not document-first.

Use:

```text
session_id
segment_id
audio_ref
stt_result
```

Do not introduce `document_id` into the MVP core path. DicTeX outputs into external apps, so it usually does not know or own the target document.

Each dictation should preserve the audio -> STT output link:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm"}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_output":"...","corrected_transcript":null}
```

This is important even before correction UI exists, because these records are the basis for later STT evaluation and fine-tuning.

## Correction Strategy

Correction is a first-class product concept, but not all correction layers should be implemented immediately.

Keep these layers separate:

- STT correction: audio + raw STT output + corrected transcript.
- Math parsing correction: spoken text + predicted LaTeX + corrected LaTeX.
- Output correction: final inserted text corrected by the user.

Do not collapse all corrections into a single final-output edit, or future training data will be ambiguous.

Store `corrected_transcript: null` in `stt_result` for compatibility, but write human transcript corrections as separate `stt_correction` events. Do not mutate older `stt_result` records.

### Dataset enrichment recording — removed (DicTeX/Lab split)

The in-app two-layer audio→text *recording* capture (issue #66) has been
**removed** from DicTeX. Per the current pivot (see
`pivot_dictex_lab_split.md`), dataset building and benchmarking move to a
separate **DicTeX Lab** app, and DicTeX stays a lean consumer dictation tool.
The Lab has no microphone: it consumes DicTeX's real transcriptions and reads
DicTeX's local data folder. The Dataset view in DicTeX now only exposes the
local dataset **export** (#44) of already-captured corrections, until the Lab
takes that over too.

The two-layer separability principle itself is preserved — it just lives in the
Lab now: acoustic pairs (audio → literal-correct transcript) and math_transform
pairs (literal text → normalized notation) stay separable by encoding the
pipeline stage in which field is filled, still as chained append-only
`stt_correction` events.

### Lab manual two-layer dataset builder (issue #78)

The Lab's `Dataset` view re-implements the manual builder (no microphone):
choose the input (paste a transcription, or pick a DicTeX-recorded segment),
type Layer 1 (literal) and optionally Layer 2 (notation), pick a benchmark-set
split, and save. See `docs/development.md` → "Dataset builder" for the full
data flow. Decisions:

- **An empty layer is skipped, never blended.** Saving never collapses the
  acoustic and math_transform transforms into one record; which correction
  event(s) get written is determined purely by which layer is filled
  (Layer 2 present → math_transform, which always requires Layer 1 since Layer 1
  is its input). A wrong/blended format here would corrupt both datasets (see
  AGENTS.md level-scoring: axis E = 4).
- **An `acoustic` pair requires real audio (a picked segment) — never a paste.**
  A paste source has no audio, so it can only write a math_transform
  (text → text) pair; an acoustic pair (audio → literal) is only written for a
  picked DicTeX segment. This keeps audio-less `acoustic` records — which are
  unusable for STT fine-tuning — out of the acoustic dataset (Opus-max review of
  #78 / PR #82).
- **A pasted (no-audio) entry still needs a string `audioRef` internally.**
  `@dictex/shared`'s `getSttBenchmarkSetSegments` (and therefore
  `buildSttDatasetExport`, reused unmodified) requires a string `audioRef` to
  place a segment into a benchmark-set split; `null` is filtered out there.
  Rather than fork that shared derivation, the Lab uses an internal, local
  convention (`NO_AUDIO_REF = ""`, documented in
  `apps/lab/src/main/datasetBuilder.ts`) for text-only entries, and its own
  `serializeDatasetRecord` maps it back to a genuine `audio_ref: null,
  audio_path: null` in the exported JSONL — the export never claims a fake
  audio file exists for a math_transform-only entry.
- **A picked-segment entry always keeps its real identity and audio.** No
  synthetic ids, no re-resolving: the segment's own `sessionId`/`segmentId`/
  `audioRef` (already read read-only from DicTeX's data folder) are reused
  as-is, so a chained acoustic + math_transform save lands on the same
  segment DicTeX recorded.
- **Export format is untouched.** The builder only produces `stt_correction`
  / `stt_benchmark_set_membership` events in the Lab's own store; export still
  goes through the existing, unmodified `buildSttDatasetExport` /
  `serializeDatasetRecord` path, so builder-made entries are
  test_frozen-compatible by construction, not by a parallel code path.

## UI Direction

The UI should feel like a compact utility app, not a landing page, dashboard, or marketing site.

Preferred direction:

- sober;
- compact;
- functional;
- information-dense but not cluttered;
- close to tools like OpenCode/OpenWhispr;
- minimal colors;
- clear status and diagnostics.

Avoid:

- large hero sections;
- gradient-heavy marketing screens;
- decorative animations;
- generic AI SaaS layouts;
- document-editor complexity in the MVP.

Useful visible information:

- current status: ready, recording, transcribing, pasted, error;
- global shortcut;
- STT engine/model/language;
- last session and segment;
- transcription duration;
- paste result;
- recent segment history;
- correction state;
- benchmark results;
- data folder / events log access.

## Shortcut And Insertion Decisions

Default global shortcut:

```text
Win+Alt+Space
```

It is a toggle:

```text
press once -> start recording
press again -> stop, transcribe, paste
```

Global push-to-talk is intentionally deferred because global key release handling is less reliable cross-platform.

Windows auto-paste is implemented first. Linux auto-paste should be a separate issue. On unsupported platforms, copying to clipboard is acceptable.

## STT Decisions

Default STT configuration:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

Le français est la première langue parlée cible. Depuis le 10 juillet 2026, le
versionnage et la documentation du projet sont rédigés en français. Le code et
l'interface restent en anglais (`CONTRIBUTING.md`).

Future model comparison should be based on actual stored segments, not assumptions. Useful candidates:

- tiny;
- base;
- small.

Fine-tuning should not happen before enough clean local correction data exists.

## Benchmark Candidates

Benchmarking is stage-aware. A benchmark candidate is identified by:

```text
stage + provider + model + variant
```

Current implemented candidates are STT candidates, for example:

```json
{"stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr"}
```

Future candidates may belong to other stages, such as normalization, segment classification, math transform, or correction suggestion. They can include local STT engines, local LLMs, remote LLMs, or rule-based transforms, but candidates should only be compared within the same stage for the same segment.

Do not treat a Whisper STT transcript and a Claude or Qwen math-transform output as the same kind of benchmark artifact. They may share benchmark metadata, but their stage defines what output is being evaluated.

### Second local STT provider (Vosk)

The STT benchmark universe must not stay "Whisper base vs Whisper small". To make
it genuinely multi-provider, a second local STT engine was added as a
benchmark-only candidate behind a small provider abstraction in the Python
sidecar (`packages/engine/providers/`): `faster-whisper` is the first provider,
**Vosk** the second.

Why Vosk:

- Different engine family (Kaldi/DNN-HMM), not another Whisper flavour, so the
  benchmark compares real alternatives instead of variants of one model.
- Fully local and offline; pip-installable wheel on Windows with no compilation.
- French acoustic models are available (e.g. `vosk-model-small-fr-0.22`), and it
  is CPU-friendly and lightweight.

Rejected alternatives:

- **whisper.cpp** — still Whisper (same family), and the Windows path needs a
  compiled binary / build toolchain, contrary to the pip-only local setup.
- **Moonshine** — English-only today; the product is French-first.
- **NeMo / other large toolkits** — heavy dependency footprint and not
  CPU-lightweight, disproportionate for a benchmark-only candidate.

Constraints kept:

- Benchmark-only. `faster-whisper` remains the dictation engine; switching the
  dictation engine would be its own issue, justified by the candidate selection
  report.
- Optional at runtime. If the `vosk` package or the local model files are
  absent, the Vosk candidate is skipped with a quiet diagnostic; dictation and
  faster-whisper benchmarking are never blocked.
- Candidate identity is unchanged: `stage="stt"`, `provider="vosk"`,
  `model=<vosk model name>`, `variant="cpu-<language>"` (Vosk is CPU-only, so no
  compute-type dimension). Vosk expects 16 kHz mono PCM and does not decode
  compressed audio, so the sidecar decodes stored segments with PyAV (already a
  faster-whisper dependency) — no new decode dependency.

Setup and env vars are documented in `docs/development.md`
("Second STT provider (Vosk)").

## Corrected dataset export

The Dataset view can export the corrected STT dataset to local JSONL files, in
preparation for Phase 3 normalizer training and Phase 4 STT acoustic
fine-tuning. It only reads the append-only event log and writes new files under
`data/exports/stt-dataset-<timestamp>/`; it never rewrites event history and
never uploads anything.

Decisions:

- The fine-tuning target is `audio -> corrected_transcript` (the human
  reference), not `model transcript -> corrected_transcript`. Model transcripts
  stay useful for benchmarking/error analysis, but the acoustic target is the
  human transcript.
- Records are partitioned by benchmark split (`train_candidate_pool`,
  `validation`, `test_frozen` — frozen test always in its own files) **and** by
  `correction_kind`. Files are named `<split>.<correction_kind>.jsonl`, so the
  acoustic (STT) dataset and the math_transform (normalizer) dataset land in
  distinct files and stay separable.
- L'export lit **toutes** les corrections d'un segment et conserve la dernière
  de **chaque type**, pas uniquement la dernière correction globale. L'outil de
  saisie actuel du Lab (#78) peut produire une chaîne `acoustic` +
  `math_transform` ; réduire le segment à un seul événement supprimerait
  silencieusement la paire acoustique. Dans un même type, la correction la plus
  récente remplace toujours la précédente.
- Untyped legacy corrections (no `correction_kind`) cannot be routed into a
  kind-partitioned dataset, so they are skipped and their count is reported in
  the manifest and UI rather than dropped silently.
- Each record is traceable to its source events: `session_id`, `segment_id`,
  `audio_ref`, resolved absolute `audio_path`, `raw_transcript` and
  `corrected_transcript` (the transform's input/target), `original_stt_output`
  (the raw STT even when a chained correction's own raw text is a later literal
  transcript), `language`, `correction_kind`, `correction_created_at`, and the
  selected base candidate metadata. A `manifest.json` records per-split /
  per-kind counts and the selection. Export proceeds even when no base candidate
  has been selected yet (`selected_candidate` is then null and the UI notes it).

## Décisions sur la notation et l'analyse mathématique

Depuis le 10 juillet 2026, le format canonique du normaliseur est LaTeX, pas
Unicode. Unicode ne peut pas représenter honnêtement intégrales, fractions
structurées, sommes bornées ou matrices. La cible humaine de couche 2 ne se
régénère pas ; le format devait donc être fixé avant la collecte. KaTeX rend du
LaTeX mais n'est ni un format ni une couche du pipeline. L'interrupteur Home
(#105) permet de désactiver le normaliseur dans une application qui ne rend pas
LaTeX. #106 et #107 sont terminés ; voir
`docs/dataset-and-normalization-design.md` §8.

Cette décision concerne la génération de notation. La construction d'un arbre
sémantique à partir de mathématiques parlées ne fait toujours pas partie de la
boucle de travail.

L'analyse mathématique reste au parking. Ne pas l'ajouter tant que la boucle
Typora, le modèle STT persistant, la correction Lab et cent dictées fiables
n'ont pas montré qu'elle bloque réellement le flux. Si elle devient justifiée,
commencer avec une portée étroite :

- variables ;
- arithmétique ;
- fractions ;
- puissances ;
- racines ;
- indices ;
- parenthèses ;
- équations simples.

L'ambiguïté est normale. Une éventuelle interface devra permettre de choisir ou
de corriger facilement la portée de l'analyse.

## Agent Handoff Guidance

When handing a task to another agent, tell it to read at least:

- `README.md`
- `docs/roadmap.md`
- `CONTRIBUTING.md`
- `docs/product-decisions.md`
- `docs/development.md`
- the GitHub issue it is implementing

Le ticket, les commits et la demande de fusion sont rédigés en français. Le
code, ses commentaires, ses tests et les textes d'interface restent en anglais.

Good tasks for another agent:

- tightly scoped UI improvements;
- diagnostics display;
- settings fields;
- tests/build fixes;
- documentation updates;
- isolated bug fixes.

Risky tasks without human review:

- changing the data model;
- introducing document ownership;
- replacing Electron/Tauri stack;
- adding math parsing too early;
- changing correction semantics;
- changing privacy/storage defaults.

If an implementation conflicts with this document, update the document in the same PR and explain the product reason.

