# AGENTS.md

Consignes du dépôt pour les agents qui travaillent sur DicTeX.

Avant toute modification, lire :

- `README.md`
- `docs/roadmap.md` (**source canonique de la priorité courante**)
- `docs/agent-workflow.md` (**rôles, modèles, points d'arrêt et transitions de revue**)
- `CONTRIBUTING.md` (**langue et conventions de contribution**)
- `docs/product-decisions.md`
- `docs/development.md`
- `docs/dataset-and-normalization-design.md` avant de modifier un type de
  correction, une couche du normaliseur ou un champ d'export ;
- `pivot_dictex_lab_split.md` et `pivot_strategique_stt_normalisation.md`
  uniquement pour comprendre les pivots historiques ;
- ce fichier.

## Langue du projet — obligatoire depuis le 10 juillet 2026

Le français est réservé aux artefacts de versionnage et de pilotage : commits,
tickets, demandes de fusion, commentaires de revue et documentation.
L'historique antérieur n'a pas à être traduit.

Le code produit reste en anglais pour l'instant : code source, identifiants,
commentaires techniques, tests, journaux, diagnostics et textes d'interface.
Les API, bibliothèques, champs de schéma, commandes, chemins, sorties d'outils,
étiquettes existantes et syntaxes imposées gardent également leur forme
anglaise. La ligne machine `Depends on: #…` conserve exactement cette forme.
Consulter `CONTRIBUTING.md` pour les exemples et les exceptions.

## Direction actuelle — cahier quotidien et données fiables

La séparation DicTeX / Lab adoptée le 9 juillet 2026 est **terminée**. Elle
reste une décision d'architecture, mais n'est plus la prochaine feuille de
route.
`docs/roadmap.md` est désormais l'unique source canonique de l'ordre des travaux.

Le point de concentration est :

1. utiliser **Typora** comme premier cahier Markdown + LaTeX réel ;
2. utiliser l'interrupteur persistant du normaliseur (#105), puis fiabiliser
   **Start/Stop** (#96) et ajouter un mécanisme explicite de mathématiques
   en bloc ;
3. remplacer le processus STT ponctuel par un processus persistant qui garde un
   seul modèle actif en mémoire ;
4. comparer des variantes courtes de `initial_prompt` sur `validation` (#94),
   puis appliquer le gagnant à la dictée quotidienne ;
5. auditer un chemin complet Typora → correction → Lab → export ;
6. commencer l'usage quotidien, les mesures et la collecte propre ;
7. améliorer les règles avant tout entraînement.

#45 (premier entraînement STT) reste différé. #95 (typographie) est une voie de
maintenance. Les nouveaux chantiers encore sans ticket doivent être découpés en
français avant leur implémentation. Toujours vérifier l'état GitHub en direct :
une photographie de la feuille de route dans un document peut vieillir.

## Contexte produit

DicTeX est une couche locale de dictée pour l'écriture scientifique.

Le produit ressemble à OpenWhispr et n'est pas centré sur le document. Il ne
possède ni cahier, ni fichier LaTeX, ni état d'éditeur. DicTeX écoute,
transcrit, transforme facultativement, insère dans l'application active et
conserve localement ce qui permettra de l'améliorer.

Boucle produit actuelle :

```text
voix -> STT local -> normaliseur déterministe facultatif
-> presse-papiers / application active -> journaux locaux
```

Boucle cible :

```text
voix
-> STT local maintenu en mémoire, avec texte littéral conservé
-> pipeline de normalisation
   -> couche 1 : dictionnaire personnel déterministe
   -> couche 2 : règles regex de verbalisation mathématique
   -> couche 3 : petit modèle seq2seq apprenant seulement le résidu
-> prose Markdown portable + LaTeX canonique
-> cahier externe, Typora en premier
-> correction visible et rapide dans le cahier
-> qualification typée dans DicTeX Lab
-> deux jeux séparés : acoustic pour le STT, math_transform pour le normaliseur
-> entraînement résiduel, puis adaptation acoustique seulement si elle est justifiée
```

## Stratégie de normalisation

Le découplage défini dans `pivot_strategique_stt_normalisation.md` reste valide :

- **Priorité 1 — normalisation texte-vers-texte.** Transformer une sortie STT
  littérale comme « x au carré » en `$x^{2}$` avec un dictionnaire, des règles
  regex, puis un petit modèle seq2seq pour le seul résidu complexe.
- **Priorité 2 — adaptation acoustique ultérieure.** Ne traiter que les erreurs
  réellement liées à la voix ou au micro, à partir de corrections `acoustic`.

La boucle de dictée, les journaux, le dictionnaire et les regex existent dans
DicTeX. Le banc d'essai, les ensembles, les corrections typées et les exports
sont maintenant dans le Lab. L'enregistrement deux-couches de #66 a été retiré.

## Implémentation actuelle

Socle technique :

- Electron desktop app.
- React + TypeScript renderer.
- Python sidecar engine.
- faster-whisper local STT.
- JSONL event logging.
- Local audio segment storage.
- Windows-first auto-paste.
- Global hotkey toggle: `Win+Alt+Space`.

Flux actuel :

```text
bouton manuel ou raccourci
-> MediaRecorder capture l'audio
-> le renderer envoie les octets au processus principal Electron
-> le processus principal enregistre l'audio sous userData
-> il lance le processus Python ponctuel
-> faster-whisper charge le modèle et transcrit
-> Python s'arrête : le modèle est actuellement rechargé à chaque dictée
-> écriture de audio_segment + stt_result dans events.jsonl
-> copie du résultat dans le presse-papiers
-> le chemin raccourci envoie aussi Ctrl+V sous Windows
-> actualisation de l'historique récent
-> réécoute ou copie du texte brut / inséré
```

Flux actuel du banc d'essai dans DicTeX Lab :

```text
segment audio enregistré et sélectionné
-> rejeu avec les candidats STT choisis
-> affichage du texte, de la latence et de l'identité du candidat
-> calcul du CER si une référence corrigée existe
-> ajout d'événements stt_benchmark_result
```

Flux actuel de correction dans DicTeX Lab :

```text
segment DicTeX sélectionné ou texte collé
-> écoute de l'audio lorsqu'il existe
-> saisie de la couche 1 littérale et de la couche 2 en notation
-> ajout d'événements stt_correction typés dans le stockage propre au Lab
-> export séparé des paires acoustic et math_transform
```

Flux actuel de l'historique et de la réécoute :

```text
events.jsonl
-> reconstruction locale des segments par session_id + segment_id
-> affichage des dictées récentes
-> copie du texte brut ou inséré et réécoute dans DicTeX
-> correction et comparaison séparées dans DicTeX Lab
```

Local runtime data path on this machine:

```text
C:\Users\souid\AppData\Roaming\dictex-app\data
```

Important runtime files:

```text
C:\Users\souid\AppData\Roaming\dictex-app\data\events.jsonl
C:\Users\souid\AppData\Roaming\dictex-app\data\audio\
C:\Users\souid\AppData\Roaming\dictex-app\data\normalizer\dictionary.json
C:\Users\souid\AppData\Roaming\dictex-app\data\settings.json
```

## Development Commands

DicTeX is an npm-workspaces monorepo (`apps/dictex`, `packages/engine`,
`packages/shared`). Run npm from the repository root; the root `package.json`
holds the workspaces list and delegates `typecheck` / `build` / `dev` to
`apps/dictex`:

```powershell
scripts\npm.cmd install
scripts\npm.cmd run typecheck
scripts\npm.cmd run build
scripts\npm.cmd run dev
```

There is one root `package-lock.json`; the app has no separate lockfile.

Python venv exists locally at the repository root (not inside a workspace):

```text
C:\Users\souid\DicTeX\.venv
```

The Electron main process resolves the repo root at runtime (four levels up
from the built `apps/dictex/out/main`) and looks for the engine at
`packages/engine/transcribe.py` and Python at `<repoRoot>/.venv`. Keep the venv
at the repo root.

Use pip with truststore on this machine:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements.txt
```

Do not use `strict-ssl=false`.

## Git Workflow

Main repo:

```text
C:\Users\souid\DicTeX
https://github.com/sensopensource/DicTeX
```

Rule:

```text
one agent = one clone = one folder = one branch = one PR
```

Depuis le 10 juillet 2026, le sujet et le corps des commits, le titre et la
description des tickets, ainsi que le titre et la description des demandes de
fusion sont en français. Les noms de branches restent des identifiants ASCII ;
utiliser un slug français sans accent lorsqu'il reste clair.

When told to solve an issue, the implementing agent does not work in the main
checkout. It clones the repo into a fresh sibling folder and works entirely
there. Parallel agents are then isolated by construction: they never share a
working directory and cannot collide.

```text
git clone https://github.com/sensopensource/DicTeX.git ../DicTeX-issue-<N>
cd ../DicTeX-issue-<N>
git checkout -b issue-<N>-<slug>
```

Lire ensuite `README.md`, `docs/roadmap.md`, `CONTRIBUTING.md`,
`docs/agent-workflow.md`, `docs/product-decisions.md`, `docs/development.md`,
`AGENTS.md` et le ticket
attribué. Faire tout le travail dans ce dossier, pousser la branche et ouvrir
une demande de fusion en français ; ne pas fusionner.

La documentation directement affectée évolue dans cette même PR. Un Fixer
pousse ses corrections sur la branche et dans la PR existantes ; il n'ouvre pas
de PR de remplacement. Le protocole complet et les skills invocables vivent
dans `docs/agent-workflow.md`.

## Skills de rôle

Les contrats canoniques versionnés se trouvent dans `.agents/skills/` et sont
invoqués dans Codex avec `$dictex-…`. Les façades Claude Code vivent dans
`.claude/skills/`, s'invoquent avec `/dictex-…` et renvoient vers les mêmes
contrats afin d'éviter toute divergence. Lancer l'outil depuis la racine du
dépôt pour qu'il découvre ces skills.

Les sept rôles sont : orchestration, implémentation, revue, correction de
revue, nouvelle revue, contrôle avant fusion et synchronisation documentaire.
Leur état vivant et leur point d'arrêt sont intégrés ; l'utilisateur ne fournit
que le numéro d'issue/PR et les contraintes exceptionnelles.

## Niveaux de raisonnement des agents

Les tickets portent la capacité nécessaire. L'échelle reste indépendante du
fournisseur ; les identifiants actuels, les commandes de lancement et le
routage de revue sont canoniques dans `docs/agent-workflow.md`.

### Échelle

Quatre niveaux utilisent des labels sans accents :

- `level:faible` — effort faible, changement mécanique ou déjà balisé ;
- `level:moyen` — effort moyen, avec un peu de jugement de conception ou d'UI ;
- `level:eleve` — effort élevé, correction ou intégrité des données critique ;
- `level:tres-eleve` — effort maximal, sémantique centrale ou coût d'erreur
  important.

Le label orthogonal `needs:high-review` n'est pas un cinquième niveau. Il exige
que l'implémenteur signale une revue renforcée et recommande le modèle adapté ;
une session distincte réalise cette revue avant la fusion.

### Attribution d'un niveau

Noter le ticket de 1 à 4 sur cinq axes :

- **A. Complexité cognitive** : 1 = appliquer un motif connu ; 4 = concevoir
  ou évaluer des choix ouverts ;
- **B. Incertitude de la spécification** : 1 = fermée ; 4 = décision produit
  manquante ;
- **C. Rayon d'impact et réversibilité** : 1 = fichier isolé ; 4 = sémantique
  centrale, historique à ajout uniquement ou intégrité des données ;
- **D. Horizon** : 1 = une étape ; 4 = plusieurs modules et étapes ;
- **E. Coût d'une erreur** : 1 = cosmétique ; 4 = corruption de données ou
  invalidation d'une évaluation.

Si **C** ou **E** vaut 4, le niveau est au moins `level:eleve`. Sinon, utiliser
la moyenne arrondie. Un axe critique domine volontairement la moyenne.

### Correspondance modèle et effort

L'effort est le premier levier ; le modèle représente le niveau actuel chez
chaque fournisseur.

| Niveau | Codex | Claude Code | Revue |
| --- | --- | --- | --- |
| `level:faible` | `gpt-5.6-luna`, low/medium | `claude-haiku-4-5-20251001` | Terra high / Sonnet 5 high |
| `level:moyen` | `gpt-5.6-terra`, medium | `claude-sonnet-5`, medium | Terra high / Sonnet 5 high |
| `level:eleve` | `gpt-5.6-terra` high si fermé, sinon `gpt-5.6-sol` high | `claude-opus-4-8`, high | Sol xhigh / Opus 4.8 xhigh |
| `level:tres-eleve` | `gpt-5.6-sol`, xhigh/max | `claude-fable-5`, max ; repli Opus 4.8 max | session séparée, obligatoire |

Notes :

- un agent Codex reste dans la famille OpenAI ; un agent Claude reste dans la
  famille Anthropic ;
- les slugs sans accents garantissent des commandes et URL propres ; leur sens
  affiché reste faible, moyen, élevé et très élevé.

### Protocole d'implémentation

Une session d'implémentation va du contrôle de l'issue à la PR. Le modèle et
l'effort sont fixés au lancement ; la revue et la fusion appartiennent à des
sessions séparées. `$dictex-implement <issue>` dans Codex et
`/dictex-implement <issue>` dans Claude Code exécutent ce protocole :

1. **Isoler l'espace de travail.** Cloner le dépôt dans un dossier frère neuf
   et y créer la branche de l'issue. Ne jamais travailler dans le checkout
   principal.
2. **Contrôler les dépendances.** Lire la ligne `Depends on:`. Pour chaque
   ticket référencé, vérifier qu'il est fermé. Si l'un reste ouvert, s'arrêter,
   signaler `bloqué par #X` et n'écrire aucun code.
3. Lire le ticket et son label `level:*`.
4. Confirmer que le modèle et l'effort actifs conviennent. S'ils sont
   sous-dimensionnés, s'arrêter avant toute écriture avec la commande de relance.
5. Faire le travail, les tests et la documentation affectée, puis ouvrir la PR.
6. Vérifier la présence de `needs:high-review`.
7. S'il est présent, ne pas s'auto-revoir ni changer d'effort en cours de
   session. Signaler dans la PR la revue requise et proposer les modèles Codex
   et Claude définis dans `docs/agent-workflow.md`.
8. Finaliser la PR avec cette recommandation. Ne pas se revoir et ne pas
   fusionner.

Notes de revue :

- l'implémenteur ne change pas son effort en cours de session et ne revoit
  jamais son propre travail ;
- `needs:high-review` oblige à signaler le besoin et le niveau recommandé ; une
  session indépendante effectue la revue ;
- Les états `review:ready`, `review:needs-improvement` et `review:recheck`
  suivent le SHA courant selon `docs/agent-workflow.md`.
- Un humain garde l'approbation et l'action de fusion finales.

## Issue Orchestration

Two distinct roles. The section above governs the **implementer** (one agent,
one issue). This section governs the **orchestrator** (one powerful agent that
plans the next batch of issues) and how dependencies are tracked so parallel
implementer sessions never collide.

There is no GitHub-native blocking. Dependencies live as plain text in the issue
body and are enforced by the implementer's step-0 guard. This keeps everything
provider-neutral (Claude and Codex both read it) and needs no extra tooling.

### Dependency line (source of truth)

Every issue that depends on others carries one machine-parsable line in its body:

```text
Depends on: #38, #39
```

Rules:

- One line, comma-separated issue numbers. Omit the line if there are no hard
  dependencies.
- A dependency means "must be CLOSED before this issue can start", nothing else.
- This replaces prose `## Dependencies` sections. Keep prose context if useful,
  but the `Depends on:` line is what agents parse.
- Only list **hard** dependencies (real ordering). Soft "works better after"
  relationships are notes, not `Depends on:` entries.

### Orchestrator responsibilities

First read the live issue state with `gh` (open/closed issues, labels, and
`Depends on:` lines) — the roadmap snapshot in this file may be stale.

Lorsqu'il doit planifier les N prochains tickets, l'orchestrateur :

1. Rédige chaque ticket en français avec **Objectif / Pourquoi / Périmètre /
   Hors périmètre / Critères d'acceptation**.
2. Scores each with the five-axis rubric and applies the correct `level:*` label
   (plus `needs:high-review` when a higher-tier review is warranted).
3. Adds a `Depends on:` line listing only hard dependencies.
4. Proposes a model per issue from the level table (Claude and OpenAI/Codex
   columns), so any provider can pick it up.
5. Produit un **plan de lancement par vagues** indiquant les tickets qui peuvent
   commencer et ceux qui doivent attendre :

```text
Vague 1 (prêts, en parallèle) : #42 (faible), #38 (élevé)
Vague 2 (après #38)           : #39 (très-élevé)
Vague 3 (après #39)           : #40 (moyen), #41 (moyen)
```

6. Flags **soft conflicts**: issues with no hard dependency that still touch the
   same files/module. These are not `Depends on:` entries; they are a note to
   sequence them, since separate clones still merge-conflict on shared files.

### How a dependency clears

No status label to maintain. When an issue is merged and its GitHub issue is
CLOSED, its dependents become startable automatically: the next implementer's
step-0 guard sees the dependency is CLOSED and proceeds. If launched too early,
the guard stops the agent before any code is written. The `Depends on:` line is
the only thing to keep correct.

## Completed Work

Issue #1 / PR #2:

- Built initial Electron + React app scaffold.
- Added audio capture.
- Added Python sidecar boundary.
- Integrated faster-whisper.
- Added local STT event logging.
- Merged.

Issue #3 / PR #4:

- Added global toggle hotkey.
- Default shortcut: `Win+Alt+Space`.
- Added Windows auto-paste via clipboard + PowerShell SendKeys Ctrl+V.
- Added `docs/product-decisions.md`.
- Merged.

Issue #5 / PR #7:

- Replaced demo/landing UI with compact utility UI.
- Added visible dictation status, hotkey status, STT config, latency, session, segment, audio duration, and paste result.
- Added buttons to open data folder and events log.
- Merged.
- Note: #7 was preferred visually over #6. Preserve the compact dark utility direction unless a later issue explicitly changes it.

Issue #8 / PR #9:

- Added STT benchmark mode.
- Replays the latest stored audio segment through faster-whisper `tiny`, `base`, and `small`.
- Shows transcript + latency.
- Appends `stt_benchmark_result` events.
- Merged.

Issue #10 / PR #36:

- Added GitHub Actions app CI.
- Runs app `npm ci`, `typecheck`, and `build` on PRs and pushes to `main`.
- Added Windows MVP smoke test checklist in `docs/development.md`.
- Merged through integration PR #36.

Issue #21 / PR #36:

- Added shared local JSONL event reader.
- Reconstructs recent segments from append-only events.
- Keeps latest audio lookup distinct from full segment reconstruction.
- Merged through integration PR #36.

Issue #11 / PR #36:

- Added compact recent segment history.
- Shows timestamp, session, segment, transcript, STT model/language, duration, latency, correction state.
- Supports copying historical transcripts.
- Merged through integration PR #36.

Issue #12 / PR #36:

- Added append-only `stt_correction` events.
- Saves keyboard corrections for transcripts without mutating `stt_result`.
- Merged through integration PR #36.

Issue #13 / PR #36:

- Added STT benchmark candidate metadata.
- Current candidate identity includes `stage`, `provider`, `model`, and `variant`.
- Preserves existing STT fields for compatibility.
- Merged through integration PR #36.

Issue #14 / PR #36:

- Added selected-segment STT benchmarking from history.
- Keeps `Benchmark latest` as a convenience.
- Associates benchmark results with selected `session_id` and `segment_id`.
- Merged through integration PR #36.

Issue #22 / PR #36:

- Shows correction state in segment history.
- Displays latest corrected transcript while preserving raw transcript.
- Merged through integration PR #36.

Issue #23 / PR #36:

- Added local audio playback from recent segment history.
- Resolves audio refs through the main process and keeps refs inside Electron userData/data.
- Merged through integration PR #36.

Issue #24 / PR #36:

- Scores STT benchmark outputs against corrected transcripts using CER.
- Scores only the STT stage when an `stt_correction` exists.
- Appends score metadata alongside `stt_benchmark_result`.
- Merged through integration PR #36.

Issue #37 / PR #46:

- Added correction of selected historical segments.
- Merged.

Issue #38:

- Added corrected STT benchmark set membership.
- Append-only split metadata: `train_candidate_pool`, `validation`,
  `test_frozen`, with latest-event-wins derivation.
- Completed.

Issue #42 / PR #51:

- Made faster-whisper STT benchmark candidates configurable via
  `DICTEX_STT_BENCHMARK_MODELS`.
- Merged.

Issue #48 / PR #52:

- Added typed corrections: required `correction_kind`
  (acoustic / math_transform / normalization / rephrasing) on `stt_correction`
  events, mandatory UI selector on both correction paths, untyped legacy
  events surface as null.
- Merged. Pivot Phase 1 done.

Issue #39 / PR #53:

- Benchmarked STT candidates over the corrected benchmark set.
- Merged.

Issue #41 / PR #54:

- Added lightweight STT benchmark error analysis.
- Merged.

Issue #49 / PR #55:

- Added the normalizer pipeline module with the personal dictionary layer
  (layer 1), `normalization_result` events with per-layer state, passthrough
  on missing/invalid dictionary. Pivot Phase 2, layer 1 done.
- Merged.

Issue #40 / PR #56:

- Summarized corrected STT benchmark results by candidate.
- Merged.

GPU STT (no issue, direct docs+engine commit):

- `packages/engine/transcribe.py` makes `cublas64_12.dll` discoverable from the
  `nvidia-cublas-cu12` pip package on Windows, enabling
  `DICTEX_STT_DEVICE=cuda`; setup documented in `docs/development.md`.

Issue #50 / PR #62:

- Added the regex math-verbalization rules layer (layer 2) to the normalizer.
  Pivot Phase 2, layers 1 & 2 now done.
- Merged.

Issue #57 / PR #61:

- Select the active STT model from the UI. Model selector in the controls
  panel (`main.tsx`), listing `tiny`/`base`/`small`/`large-v3-turbo`, persisted
  and applied to the next dictation.
- Merged. The shell refactor #63 keeps it on the Home view.

Issue #43 / PR #60:

- Added STT candidate selection: a new append-only `stt_candidate_selection`
  event (`stage`/`provider`/`model`/`variant`/`selection_reason`), a
  "Select"/"Reselect" action on the existing candidate summary panel (#40),
  and a banner showing the current selection + reason. No new panel needed —
  the summary table already gave the comparison data.
- Merged.

Issue #59 / PR #68:

- Added Vosk (Kaldi-based) as a second local, benchmark-only STT provider,
  behind a minimal provider abstraction in the Python sidecar
  (`packages/engine/providers/`). faster-whisper output stays byte-identical; Vosk
  candidates are optional at runtime (quiet skip if uninstalled) and never
  block dictation or faster-whisper benchmarking.
- Documented in `docs/product-decisions.md` ("Second local STT provider
  (Vosk)") and `docs/development.md`.
- Merged.

Issue #63 / PR #67:

- UI shell: split the single-screen renderer into three task-focused views —
  Home (dictation, controls, diagnostics, collapsible history, correction),
  Benchmark (segment/batch benchmark, summary, error analysis — moved
  unchanged), Dataset (placeholder for #66). Simple `useState` navigation, no
  routing library.
- Merged. Keystone for the UI refactor track.

Issue #64 / PR #69:

- Benchmark view: 1-3 candidate checkbox selector (sourced from
  `getSttBenchmarkModels`) + dataset selector (`test_frozen` default,
  `validation` available); "Run analysis" scopes the batch run (filtered in
  the main process, to avoid wasted transcription work) and the candidate
  summary (filtered client-side) to the checked candidates.
- Covers the intent of #58 without modifying or closing it.
- Merged.

Issue #65 / PR #70:

- Benchmark view: graceful empty states for the candidate summary and
  error-analysis panels (pre-run, and "segments exist but none match the
  checked candidates"), reacting to the #64 candidate/dataset selection.
  `analyzeBatchErrors` semantics untouched.
- Covers the intent of #43's original UI-layout ask (the underlying feature
  itself landed separately via #43/PR #60 above).
- Merged.

Pivot Phase 0 (PR #74, merged to main directly):

- Removed the buggy in-app two-layer audio->text *recording* capture (#66):
  Dataset view reduced to export-only, `transcribeAudio` model/writeClipboard
  options reverted, capture CSS removed (net -402 lines).
- Recorded the DicTeX/Lab split plan in `pivot_dictex_lab_split.md`.
- Done.

Pivot Phase 1 (#75, PR #79, merged): npm-workspaces monorepo — `app/` ->
`apps/dictex`, `engine/` -> `packages/engine`, empty `packages/shared`; the
Electron main `repoRoot` resolves four levels up from the built
`apps/dictex/out/main`. No behavior change. Done.

Pivot Phase 2 (#76, PR #80, merged):

- Scaffolded `apps/lab` (**DicTeX Lab**): electron-vite + React, no microphone/
  hotkey/clipboard/normalizer. Hosts the STT benchmark (segment/batch, candidate
  summary, error analysis, candidate selection), typed corrections,
  benchmark-set splits, and the test_frozen dataset export.
- Factored the shared pure logic into `packages/shared` (populated from the
  empty Phase-1 scaffold): `localEvents` (event schema + append-only
  derivations), `sttScoring` (CER/WER), `benchmarkSummary`, `datasetExport`,
  `sttEngine` (Python sidecar invocation + `getSttBenchmarkModels`),
  `benchmarkTypes` (benchmark IPC types), `errorAnalysis`, and `formatting`.
  `apps/dictex` re-points its imports to `@dictex/shared` (its local copies of
  those modules deleted); its dictation path is otherwise unchanged. The node-
  touching barrel (`.`) is main-process only; `formatting` + `errorAnalysis` are
  browser-safe subpath exports for renderers.
- The Lab reads DicTeX's data folder **read-only** (configurable, default
  `%APPDATA%/dictex-app/data`) and writes only into its OWN store
  (`%APPDATA%/dictex-lab-app/data`). Documented in `docs/development.md` and
  `docs/product-decisions.md`.
- The Lab still coexisted with the same features in `apps/dictex` at this point;
  Phase 3 (#77) removed them from DicTeX. Done.

Pivot Phase 3 (#77, PR #81, merged): slimmed `apps/dictex` to a pure consumer
dictation tool — single Home view (dictation + normalizer + STT model selector +
minimal diagnostics), collapsible history with **Copy / Copy raw / Play only**,
and an **"Open Lab"** launcher (prefers the built Lab, falls back to `dev:lab`,
graceful error). Removed all benchmark/dataset/correction/split IPC + UI and 61
dead CSS blocks (~-3400 LOC; CSS bundle 16.6 -> 9.2 kB). No `packages/shared` or
`packages/engine` deletions. Done.

Roadmap — DicTeX / Lab split (see `pivot_dictex_lab_split.md`). **The pivot is
complete: all four phases (0-4) are merged.** DicTeX is the lean consumer
dictation app; the Lab owns benchmark + dataset building + export. Prior
benchmark/dataset issues are done or folded in (#43/#58 closed; #44 export
relocated to the Lab in Phase 2; #66 recording reverted in Phase 0).

- #75 Phase 1 — monorepo skeleton — **DONE** (PR #79).
- #76 Phase 2 — `apps/lab` + `packages/shared` — **DONE** (PR #80).
- #77 Phase 3 — slim DicTeX + Open Lab — **DONE** (PR #81).
- #78 Phase 4 — Lab manual two-layer dataset builder + benchmark from the data
  folder — **DONE** (PR #82; Opus-max review restricted paste sources to
  math_transform, so no audio-less `acoustic` records reach the STT dataset).

Post-pivot (done):

- #83 Open Lab reliability + post-pivot cleanup — **DONE** (PR #86).
  `openLabApp()` now also requires `apps/lab/out/renderer/index.html` before
  launching the built Lab (a partial build with only `out/main` previously
  launched a blank/frozen window); removed the vestigial `referenceModel`
  field/UI from the Lab dataset builder (dead since the synthetic `stt_result`
  path was removed); swept 17 dead CSS rule blocks from
  `apps/lab/src/renderer/src/styles.css` (Lab CSS bundle 17.00 -> 13.96 kB).

- #84 UX/UI design review + on-direction polish — **DONE** (PR #87). Added the
  shared token layer `packages/shared/src/styles.css` (both renderers import it
  first), one `.panel-header`, consistent focus/hover/disabled, and
  `docs/ux-review.md`. Fixed real drift from #77/#83: classes used in JSX with no
  CSS rule.
- #85 Lab dataset-builder + view-state UX — **DONE** (PR #88). Mirrors
  `planDatasetBuilderSave`'s real errors in the renderer, live "will save X ->
  split" preview, empty/pre-run states across Segments/Benchmark/Dataset. Also
  fixed a guard that left Save enabled for a paste-mode entry with no Layer 2 —
  a request the main process could only reject.

- #89 Lab dataset builder: refresh the segment list + replay segment audio —
  **DONE** (PR #91). Threads `loadSegments` / `playSegmentAudio` into
  `DatasetView`; audio affordances hidden in paste mode.
- #92 Command words: shared sentinel layer — **DONE** (PR #98). One table in
  `packages/shared/src/commands.ts`, consumed by `apps/dictex`'s normalizer
  (`extractCommands` between the dictionary and the regex layer), by insertion
  and event writing (`expandCommands`, a total sentinel eliminator), and by the
  dataset export (`extractCommands` on both layers of a `math_transform` pair,
  never on an `acoustic` one). `npm test` guards the no-sentinel-in-store
  invariant and now runs in CI.

Après le pivot, la priorité courante n'est plus tenue dans cette chronologie de
travaux terminés. Consulter `docs/roadmap.md` et l'état GitHub en direct. #45,
qui planifie le premier entraînement STT, reste différé jusqu'à la comparaison
des variantes de `initial_prompt` (#94), la constitution d'un volume acoustique
minimal et la démonstration d'un résidu réellement acoustique.

Layer-3 input, **decided 2026-07-10** (see `docs/dataset-and-normalization-design.md`
§7): **resolution 1 — layer 3 learns the residual.** The exported training input
is the pipeline's output over Layer 1 (dictionary -> command extraction -> regex),
i.e. what layer 3 actually receives at inference; the target stays the
human-authored Layer 2. Rejected: letting layer 3 replace the regex. The
principle: never make a model learn what a rule does with certainty.

Consequences, tracked as issues:

- #100 move the normalizer into `packages/shared` and replay the pipeline over
  Layer 1 at export — `level:eleve` + `needs:high-review`. Leaving it in
  `apps/dictex` while the export lives in `packages/shared` would recreate the
  train/serve divergence #92 just eliminated for command words. **DONE**
  (PR #103, merged as `9f64cca`).
- #101 the Lab builder prefills Layer 2 from the pipeline output and
  **highlights what the pipeline changed**, because a prefilled field invites
  passive acceptance — `level:moyen`, depends on #100. **DONE**. The prefill
  runs the FULL pipeline (dictionary -> command extraction -> regex — the same
  fold `apps/dictex` serves) over Layer 1, then `restoreCommandWords`
  (`packages/shared/src/commands.ts`) maps the sentinel back to its canonical
  spoken phrase — the exact inverse of `extractCommands` for the sentinel ->
  words direction — so the builder's Layer 2 field only ever holds canonical
  words, never a sentinel or a literal command effect. Chosen over skipping
  command extraction in the prefill: skipping it would run the regex on text
  the real pipeline never gives it. The diff itself is a small word-level LCS
  diff (`packages/shared/src/textDiff.ts`) between Layer 1 and the prefilled
  Layer 2, rendered inline in the dataset builder panel.

The regex layer is not a stopgap the seq2seq makes redundant: its operand is a
single letter or number, so it structurally cannot do composition, scope, or
disambiguation. And the `math_transform` dataset is the *measurement* of the regex
layer before it is fuel for a model — it keeps its value even if layer 3 never
ships.

Deferred UX proposals (from `docs/ux-review.md`, human decisions recorded):

- **Typographic scale (A)** — wanted, but touches nearly every CSS rule in both
  apps, so it is a merge-conflict magnet. Land it alone, never bundled.
- **Idle DicTeX Home (B)** — decision: **hide empty metrics** until they have a
  value, rather than showing eight `-` cells or seeding from config.
- **Libellé du bouton d'enregistrement (F)** — décision : aligner le bouton sur
  le fonctionnement à bascule avec les libellés anglais **Start / Stop** et le
  même état que `Win+Alt+Space`.
- **Footer actions (C)** and **collapsible Lab data-folder panel (E)** — still
  open, no decision.
- **Unified navigation model (D)** — deliberately deferred. Structural, purely
  aesthetic benefit, and the likeliest way to drift a utility UI toward a
  dashboard. Revisit once both apps stop moving.
- **Light theme (G)** — not happening. Both apps are dark-only by design.

Modèles actuels : `level:eleve` → Claude Opus 4.8 high / Codex GPT-5.6-Sol
high lorsque la spécification n'est pas fermée ; `needs:high-review` → Claude
Opus 4.8 xhigh / Codex GPT-5.6-Sol xhigh. Voir `docs/agent-workflow.md` pour la
table complète et le niveau très élevé.

## Product Decisions To Preserve

Do preserve:

- OpenWhispr-like dictation layer.
- Session-first, not document-first.
- `session_id` + `segment_id`, not `document_id`, in the MVP core path.
- Audio + raw STT outputs before correction UX.
- Append-only event history.
- Corrections typed by `correctionKind` (acoustic / math_transform /
  normalization / rephrasing), keeping acoustic and semantic problems separable.
- French-first spoken input.
- Français pour le versionnage et la documentation ; anglais pour le code et
  l'interface (`CONTRIBUTING.md`).
- Windows-first auto-paste, Linux later.
- Compact utility UI direction.
- Benchmarking as an evaluation loop, not just a developer tool.

Do not introduce without an explicit issue:

- document ownership;
- internal rich document editor;
- Tauri migration;
- SQLite migration;
- math parsing;
- LLM provider integrations;
- API key handling;
- fine-tuning;
- cloud sync;
- multi-user backend.

The strategic pivot sanctions the normalization pipeline (dictionary, regex,
small seq2seq) and math rendering as the Priority 1 direction — still land them
through explicit issues, not ad hoc.

**La génération LaTeX est autorisée** depuis le 10 juillet 2026. Le format
canonique du normaliseur est LaTeX, pas Unicode : intégrales, fractions
structurées, sommes bornées et matrices ne sont pas représentables honnêtement
en Unicode. La couche 2 est écrite à la main et ne se régénère pas ; son format
devait donc être figé avant la collecte. KaTeX reste un moteur de rendu, pas un
format ni une couche du pipeline. Voir
`docs/dataset-and-normalization-design.md` §8. #106 et #107 sont terminés ;
`$…$` est implémenté, tandis que `$$…$$` exige un nouveau ticket français et une
extension explicite du contrat. L'analyse mathématique sémantique reste exclue.

## UI Direction

Target feel:

- compact;
- sober;
- utility-like;
- close to OpenCode/OpenWhispr;
- minimal colors;
- clear state;
- diagnostics visible but not noisy.

Avoid:

- landing-page hero;
- gradients;
- big decorative typography;
- generic AI SaaS dashboard feel;
- broad settings pages too early.

La navigation actuelle est séparée par application :

- **DicTeX** conserve une seule vue Home : dictée, normaliseur, modèle STT,
  diagnostic minimal, historique repliable avec copie/réécoute et bouton
  **Open Lab**. Pas de correction, de banc d'essai ou d'ensemble de données dans
  cette application.
- **DicTeX Lab** possède les vues Segments, Benchmark et Dataset, chacune
  limitée à sa tâche.

Ne pas réintroduire dans DicTeX ce que le pivot #75–#78 a extrait. Le caractère
compact, sobre et utilitaire s'applique aux deux applications.

Informations utiles dans DicTeX : état prêt/enregistrement/transcription/
copie/erreur, état du raccourci, modèle et langue STT, session, segment, latence,
durée audio, mode de sortie et historique récent. Les corrections, mesures de
candidats et exports apparaissent uniquement dans le Lab.

## Data Model Notes

Current JSONL event types include:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_mime_type":"audio/webm;codecs=opus","audio_size_bytes":12345}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stt_engine":"faster-whisper","stt_model":"base","stt_language":"fr","stt_output":"...","corrected_transcript":null,"audio_duration_seconds":1.23,"transcription_duration_ms":900}
```

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830}
```

Current benchmark events also include candidate metadata and may include STT scoring metadata:

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830,"score_metric":"cer","score_value":0.12,"score_reference_type":"stt_correction"}
```

Les corrections STT sont des événements séparés et ne doivent jamais réécrire
l'historique :

```json
{"event_type":"stt_correction","created_at":"2026-07-05T00:00:00.000Z","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","raw_transcript":"...","corrected_transcript":"...","correction_method":"keyboard","correction_kind":"acoustic"}
```

Each dictation also appends a normalization record (pivot Phase 2, layer 1).
The raw `stt_result` is left untouched. When the pipeline runs, its output is
inserted and each layer's output is preserved so a wrong insertion is
attributable to a specific layer:

```json
{"event_type":"normalization_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","input_transcript":"dic tex","output_transcript":"DicTeX","passthrough":false,"layers":[{"layer":"personal_dictionary","input":"dic tex","output":"DicTeX","applied":true,"diagnostics":[]}],"diagnostics":[]}
```

Lorsque l'interrupteur #105 est sur Off, le pipeline ne s'exécute pas et
l'événement prend une forme distincte : `disabled: true`, aucun champ
`passthrough`, sortie identique au STT brut, `layers: []` et `diagnostics: []`.
Ne jamais confondre « désactivé » avec un pipeline activé qui n'a rien modifié.

Les corrections restent à ajout uniquement (`append-only`). Le typage est
implémenté :

- `acoustic` : le STT a mal entendu ; produit une cible littérale associée à
  l'audio ;
- `math_transform` : le texte parlé correctement reconnu devient une notation
  canonique, par exemple « x au carré » → `$x^{2}$` ;
- `normalization` : nettoyage indépendant ;
- `rephrasing` : reformulation libre.

L'outil de saisie à deux couches actuel se trouve dans DicTeX Lab (#78). #66, qui
enregistrait directement depuis une ancienne vue Dataset de DicTeX, a été
retiré. Pour un segment réel, le Lab peut écrire deux événements
`stt_correction` chaînés :

1. `correction_kind = "acoustic"` : sortie STT brute → transcription littérale
   correcte, avec le véritable audio ;
2. `correction_kind = "math_transform"` : transcription littérale → notation
   humaine, sans utiliser l'audio comme entrée du transformateur.

Un texte collé sans audio ne peut produire qu'une paire `math_transform`. Un
segment peut porter plusieurs corrections ; l'export doit conserver la dernière
correction de **chaque type**, pas seulement la dernière du segment. Les
ensembles `train_candidate_pool`, `validation` et `test_frozen` sont lus avec ce
type pour construire deux jeux qui restent séparés.

## Benchmark Vision

Do not let the benchmark architecture get stuck as "Whisper base vs Whisper small".

That is only the first useful benchmark because the current implemented layer is STT. The long-term goal is to compare candidates by pipeline stage:

```text
segment audio/transcript
-> STT candidates
-> normalization candidates
-> segment classification candidates
-> math transform candidates
-> correction suggestion candidates
```

Benchmark identity should move toward:

```text
stage + provider + model + variant
```

Examples:

```json
{"stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr"}
```

```json
{"stage":"math_transform","provider":"qwen","model":"qwen2.5-coder","variant":"local"}
```

```json
{"stage":"math_transform","provider":"claude","model":"claude-sonnet","variant":"remote"}
```

Important nuance:

- Whisper/faster-whisper belongs to STT.
- Mistral, Qwen, Claude, OpenAI, or local rules would usually belong to math transform, normalization, or correction suggestion stages.
- Do not compare incompatible stages as if they produce the same artifact.
- Do compare candidates within the same stage for the same segment.

Implement this progressively. Do not build a large generic benchmark framework before the product needs it, but avoid hardcoding assumptions that make future model-vs-model comparisons awkward.

## STT Notes

Default config:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

GPU (CUDA) is supported on this machine via env config (see
`docs/development.md`, "GPU (CUDA) STT"):

```text
DICTEX_STT_MODEL=large-v3-turbo
DICTEX_STT_DEVICE=cuda
DICTEX_STT_COMPUTE_TYPE=float16
```

Requires `nvidia-cublas-cu12` + `nvidia-cudnn-cu12` pip packages;
`packages/engine/transcribe.py` handles the cuBLAS DLL path on Windows.

Current STT benchmark candidates (defaults, configurable via
`DICTEX_STT_BENCHMARK_MODELS` since PR #51):

- faster-whisper/tiny
- faster-whisper/base
- faster-whisper/small

Since PR #68, a second local provider is also available as benchmark
candidates: Vosk (`vosk-model-small-fr-0.22` by default, configurable via
`DICTEX_VOSK_BENCHMARK_MODELS` + `DICTEX_VOSK_MODEL_DIR`), optional at runtime
(quiet skip if uninstalled). See `docs/development.md` -> "Second STT provider
(Vosk)".

These are current candidates, not the final benchmark universe. The model
actually used for dictation on this machine is faster-whisper/large-v3-turbo
on GPU (already selectable for dictation via the Home model selector, #57);
it is not yet in the default *benchmark* candidate list — include it via
`DICTEX_STT_BENCHMARK_MODELS=tiny,base,small,large-v3-turbo` until an issue
adds it by default.

## Prochaines priorités

La liste détaillée et les portes de sortie vivent uniquement dans
`docs/roadmap.md`. Ordre résumé :

1. valider Typora sur une vraie session de brouillon ;
2. #105 étant terminé, livrer #96, puis la sortie explicite en bloc et la
   migration sûre des anciennes règles locales ;
3. maintenir un modèle STT actif dans un processus Python persistant et mesurer
   séparément son chargement et ses requêtes chaudes ;
4. définir deux ou trois variantes courtes de `initial_prompt`, terminer #94 sur
   `validation`, puis brancher le gagnant dans DicTeX ;
5. auditer Typora → correction → Lab → export ;
6. atteindre cent dictées réelles sans perte de données ;
7. améliorer les règles sur les erreurs observées et mesurer le résidu ;
8. envisager le seq2seq, puis l'adaptation acoustique, uniquement après gain
   démontré face à une référence.

#95 ne coupe pas ce chemin critique. #45 doit être réécrit en français lorsque
les conditions acoustiques seront enfin réunies. Ne pas créer de grande
infrastructure générique pour anticiper ces étapes ; garder toute surface de
mesure et d'apprentissage dans le Lab.

## Nuance importante

La perte de données est un échec produit. Toujours préserver l'audio, le texte
STT brut, la sortie de chaque couche, les résultats de mesure et les corrections
humaines. Lorsqu'une fonctionnalité change la génération, conserver assez
d'intermédiaires pour identifier précisément la couche fautive.
