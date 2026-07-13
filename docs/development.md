# Development

> Ce guide décrit l'état réellement implémenté. La direction future vit dans
> `docs/roadmap.md` et la convention de langue dans `CONTRIBUTING.md`. Les
> anciennes sections anglaises sont conservées ; toute nouvelle instruction est
> rédigée en français.

## Sessions agentiques

Le protocole complet vit dans `docs/agent-workflow.md`. Lancer Codex ou Claude
Code depuis la racine du dépôt afin de découvrir respectivement
`.agents/skills/` et `.claude/skills/`. Une invocation telle que
`$dictex-implement 114` ou `/dictex-implement 114` découvre elle-même l'état
GitHub vivant, crée le clone isolé et s'arrête après la PR. L'utilisateur n'a
pas à répéter le point d'arrêt.

## Requirements

- Node.js LTS
- npm
- Python 3.11
- Git

## Repository Layout

DicTeX is an npm-workspaces monorepo. The consumer app, the tooling app, the
Python STT engine, and shared TypeScript live in separate workspaces:

```text
apps/
  dictex/      # the Electron + React consumer dictation app (has a microphone)
  lab/         # DicTeX Lab — Electron + React tooling app (NO microphone):
               # benchmark + dataset export + corrections/splits over DicTeX's
               # data folder, read-only, with its own store
packages/
  engine/      # the Python STT sidecar (faster-whisper + Vosk) — shared
  shared/      # shared TS used by both apps: JSONL event schema + derivations,
               # CER/WER scoring, benchmark summary, dataset export builder,
               # STT engine invocation, benchmark IPC types, error analysis,
               # and presentation helpers
```

npm commands run from the **repository root**. The root `package.json` holds the
workspaces list; root `typecheck` and `build` cover `packages/shared` +
`apps/dictex` + `apps/lab`, while `dev` runs `apps/dictex` (use `dev:dictex` /
`dev:lab` to pick one). So `scripts/npm.cmd run <script>` from the root drives
the monorepo. The Python `.venv` lives at the **repository root** (`.venv/`),
not inside a workspace; each app's Electron main process resolves it relative to
the repo root at runtime (both apps sit at the same depth under `apps/`).

## Windows TLS Note

On this machine, npm cannot verify the npm registry certificate with Node's bundled CA store. Use Node's system CA mode when running npm:

```text
NODE_OPTIONS=--use-system-ca
```

This makes Node/npm use the Windows certificate store instead of disabling SSL verification.

Do not use `strict-ssl=false` for this project.

The same certificate issue can affect pip. Use:

```powershell
python -m pip install --use-feature=truststore -r packages\engine\requirements.txt
```

Windows helper:

```powershell
scripts\npm.cmd <npm arguments>
```

Linux/macOS helper:

```sh
scripts/npm.sh <npm arguments>
```

## Install

Run everything from the repository root.

Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements.txt
scripts\npm.cmd install
```

Linux/macOS:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r packages/engine/requirements.txt
scripts/npm.sh install
```

`npm install` at the root installs every workspace (there is one root
`package-lock.json`; the app has no separate lockfile).

### Migrating an existing checkout to the monorepo

A checkout made before the monorepo move (`app/` → `apps/dictex`, `engine/` →
`packages/engine`) needs a fresh **root** install — dependencies are now hoisted
to a single root `node_modules`, so the app's tools (e.g. `electron-vite`) are
not found until you reinstall. After pulling:

```powershell
scripts\npm.cmd install        # reinstall at the root (hoists all workspaces)
Remove-Item -Recurse -Force .\app   # optional: delete the now-orphaned old app/ (only ignored node_modules/out remain)
```

The `.venv` at the repo root is reused as-is — it is still at the (unchanged)
repository root, so dictation keeps working with no changes.

## Validate

Windows:

```powershell
scripts\npm.cmd run typecheck
scripts\npm.cmd run build
```

Linux/macOS:

```sh
scripts/npm.sh run typecheck
scripts/npm.sh run build
```

These root scripts delegate to `apps/dictex`.

## Manual MVP Smoke Test

Run this checklist on Windows when validating MVP behavior manually. CI does not cover microphone input, global hotkeys, auto-paste, Python STT, or local model availability.

1. Launch the app:

```powershell
scripts\npm.cmd run dev
```

2. Confirm the app opens to the compact utility UI and shows the global shortcut status.
3. Hold `Hold to dictate`, speak a short French phrase, then release.
4. Confirm the transcript appears in `Last transcript` and the diagnostics show session id, segment id, model, language, latency, and audio duration when available.
5. Confirm the transcript is copied to the clipboard.
6. Press `Win+Alt+Space`, speak a short phrase, then press `Win+Alt+Space` again.
7. Confirm Windows auto-paste inserts the transcript into the previously active text field, or that the UI reports clipboard-only behavior if paste fails.
8. Confirm the recent segment history refreshes; on an older segment use **Copy** (inserted/normalized text) and **Copy raw** (raw STT output).
9. Play a recent segment from history and confirm local audio playback works.
10. Click `Open data folder` and confirm the stored audio file exists under `data/audio/session_.../`.
11. Click `Open events log` and confirm `audio_segment`, `stt_result`, and `normalization_result` events were appended. (DicTeX no longer writes corrections or benchmark events — those live in DicTeX Lab.)
12. Click `Open dictionary`, add an entry like `{"from":"dic tex","to":"DicTeX"}`, save the file, then dictate a phrase containing "dic tex". Confirm the clipboard/pasted text and the `Inserted (normalized)` line show `DicTeX`, the `Last transcript (raw)` textarea still shows the raw STT output, and a `normalization_result` event was appended while `stt_result.stt_output` kept the raw transcript. Break the JSON on purpose and confirm the next dictation still inserts the raw text with a quiet `Normalizer:` diagnostic instead of failing.
13. Without touching `rules.json`, dictate "deux plus trois" spoken as digits (e.g. "2 plus 3") and confirm the inserted text shows `$2 + 3$` (canonical LaTeX wrapped in `$…$`, #107) from the shipped default rules alone. Then dictate an ordinary sentence containing "plus" or "moins" outside a math context (e.g. "je suis de plus en plus fatigué") and confirm it is inserted unchanged. Click `Open rules`, break the JSON on purpose, and confirm the next dictation inserts the (still dictionary-normalized) text unchanged by regex rules with a quiet `Normalizer:` diagnostic instead of failing.
14. Placer l'interrupteur `Normalizer` sur **Off**, dicter « retour à la ligne x au carré », puis vérifier que le texte copié ou inséré est identique octet par octet à `Last transcript` : les mots de commande restent littéraux et aucun LaTeX n'est produit. Vérifier que le nouvel événement `normalization_result` contient `disabled: true`, aucun champ `passthrough` et des `layers` vides. Redémarrer DicTeX, confirmer que l'état Off persiste, puis repasser sur On et vérifier que règles et commandes s'appliquent à nouveau.
15. Dans le sélecteur `STT model`, choisir un autre modèle. Vérifier le diagnostic `Model`, dicter une phrase et confirmer que l'événement `stt_result` contient le modèle choisi. Redémarrer l'application et vérifier la persistance dans `data/settings.json`. Corrompre ce fichier et confirmer que DicTeX redémarre avec la variable d'environnement ou `base`, et avec le normaliseur activé.
16. Cliquer sur **Open Lab**. Avec un Lab construit (`scripts\npm.cmd run build`), vérifier son ouverture ; sans construction, vérifier que DicTeX affiche une erreur explicite sans planter.
17. Worker STT persistant et observabilité (#115/#116). Au lancement, vérifier
    que Home passe de `Preparing` à `Ready` sans bloquer la fenêtre. Dicter deux
    fois avec le même modèle : les deux `stt_result` doivent porter le même
    `stt_worker_generation`, le second `stt_ready_wait_ms` doit être `0`, et
    `stt_inference_duration_ms` doit être distinct de la latence globale
    `transcription_duration_ms`. Confirmer un unique `stt_engine_ready` avec
    des durées finies pour cette génération. Changer de modèle puis dicter :
    Home passe par `Restarting`, une nouvelle génération et un nouvel
    `stt_engine_ready` apparaissent. Arrêter le worker de force pendant une
    dictée et confirmer `Restarting`, puis `Ready` avec une autre génération
    (ou `Error` après l'échec terminal). Basculer `Normalizer` On puis Off
    entre deux dictées et confirmer que le worker ne redémarre pas.

Benchmark, typed corrections, benchmark-set splits, candidate selection, Vosk, and the test_frozen dataset export are **no longer in DicTeX** (Pivot Phase 3) — they now live in DicTeX Lab and are verified there (see "DicTeX Lab" below).

## Run

Windows:

```powershell
scripts\npm.cmd run dev
```

Linux/macOS:

```sh
scripts/npm.sh run dev
```

The app uses a Python sidecar with faster-whisper for local transcription.

## DicTeX Lab (tooling app)

`apps/lab` est l'application séparée **DicTeX Lab** (pivot phase 2, voir
`pivot_dictex_lab_split.md`). Elle n'a **ni microphone, ni raccourci global, ni
presse-papiers/collage** : elle héberge les outils de mesure et de données —
benchmarks STT et Normalizer, corrections typées, appartenance aux splits et
export compatible avec `test_frozen`. Elle réutilise `packages/engine`
(faster-whisper + Vosk) pour le STT et le normaliseur déterministe de
`packages/shared` pour le stage textuel ; les dérivations, scores et exports
partagés empêchent DicTeX et le Lab de diverger.

Run it (from the repository root):

```powershell
scripts\npm.cmd run dev:lab
```

```sh
scripts/npm.sh run dev:lab
```

### Lancer une expérience et lire son résultat (issue #138)

Le Lab sépare strictement le protocole à lancer du run déjà figé :

- **`Experiments` est un formulaire de lancement.** Cinq étapes ordonnées —
  étape expérimentale, dataset/split, candidats, protocole, lancement — et rien
  d'autre : aucun résumé, aucun résultat historique. `STT` et `Normalizer` sont
  exécutables ; le bout en bout reste annoncé désactivé avec sa raison plutôt
  que doté d'un contrôle sans effet. Le protocole annonce avant tout lancement
  l'entrée, la cible et la transformation propres au stage (`audio -> Layer 1`
  ou `Layer 1 -> Normalizer -> Layer 2`), le split, le nombre de membres
  évaluables et l'identité complète de chaque candidat, ainsi
  que le fait que le snapshot est **figé automatiquement au lancement** — il n'y
  a aucune action manuelle de création de snapshot.
- **`Results` est la lecture d'un run immuable.** La liste des runs du split
  parcouru, puis le détail du run choisi : statut, snapshot figé, candidats
  lancés, résumé par candidat, sorties de chaque candidat pour chaque membre,
  erreurs et provenance. La sélection du candidat de base et `Export for LLM`
  restent propres aux runs STT ; un run Normalizer expose l'exact match, les
  diffs et les traces. Aucun contrôle de lancement n'y figure.
- **Un lancement réussi devient son résultat** : le run créé est immédiatement
  sélectionné et la vue bascule sur `Results`.

Le nombre de membres évaluables annoncé avant le lancement provient de la même
fonction qui fige le snapshot au démarrage : `buildSttBenchmarkRunSnapshot`
pour STT, `buildMathTransformBenchmarkRunSnapshot` pour Normalizer. Le détail
d'un run STT reste construit par `buildSttBenchmarkRunDetail`; celui d'un run
Normalizer vient de la projection stage-aware commune. Dans les deux cas,
l'appartenance courante à un split et les corrections actuelles ne sont jamais
relues. Le split de `Results` est un filtre de lecture, distinct de celui du
protocole.

Depuis #138, **un résultat STT n'existe qu'à l'intérieur d'un run**. Le rejeu
ad hoc (`Benchmark latest` / benchmark d'un segment) est retiré : il écrivait des
`stt_benchmark_result` sans `run_id`, donc sans snapshot ni référence explicable,
qui réapparaissaient ensuite comme de faux résultats « legacy ». Les anciens
résultats sans `run_id` restent lisibles sous `Legacy (pre-run results)` ; aucun
événement n'est réécrit.

### DicTeX data folder (read-only source) + the Lab's own store

The Lab reads DicTeX's local data folder — `audio/` + `events.jsonl`
(`audio_segment` / `stt_result` / `normalization_result`) — **read-only**.
It never writes into DicTeX's folder. Everything the Lab produces
(corrections, splits, benchmark results, candidate selections, dataset
exports, and its own settings) goes into the **Lab's own** store under its
own Electron `userData` (`%APPDATA%/dictex-lab-app/data`), a separate folder
from DicTeX's `%APPDATA%/dictex-app/data`.

The DicTeX data folder path is configurable in the Lab's Segments view:

- default: `%APPDATA%/dictex-app/data`;
- override via `Choose folder…` (native picker) or by pasting an absolute
  path + `Apply`;
- `Reset to default` clears the override.

The choice is persisted in the Lab's own `settings.json`
(`{"dictexDataFolder": "..."}`); a missing/malformed file degrades to the
default with a quiet diagnostic. When the Lab benchmarks a segment, it reads
that segment's audio from the configured source folder and appends the
`stt_benchmark_result` to its **own** event log. When combining state for a
segment, the Lab concatenates DicTeX's read-only events (first) with its own
events (second), so latest-event-wins derivations see the Lab's corrections/
splits layered on top of DicTeX's raw dictation records.

### Dataset builder (manual two-layer entries, issue #78)

The `Dataset` view's **Build a dataset entry** panel is the Lab's manual,
no-microphone replacement for the old in-app recording (#66, removed in
Phase 0): you run DicTeX in the background yourself, then feed the Lab its
real transcription by hand. Two independent inputs:

- **Paste a transcription** — free-text raw STT transcript, no audio. Mints a
  synthetic identity (`lab_manual_<timestamp>` / `entry_<random>`).
- **Pick a DicTeX segment** — chooses one of the (read-only) segments listed
  in the Segments view; the real `sessionId`/`segmentId`/`audioRef` and raw
  transcript are reused as-is.

Then two layers:

- **Layer 1 (literal, verbal)** — always typed by hand, e.g.
  `x au carré plus deux`. Never prefilled from a script: it must match what
  was actually said (see "Layer 2 prefill" below, and §5 of
  `docs/dataset-and-normalization-design.md`).
- **Layer 2 (normalized notation, LaTeX/KaTeX-compatible)** — e.g. `x^2 + 2`;
  the field stays disabled until Layer 1 is filled, and is **prefilled** from
  the pipeline once Layer 1 has content (issue #101, see below) — always
  editable, and whatever is left in the field at `Save entry` time is what
  gets saved.

Clicking `Save entry` writes chained `stt_correction` events into the Lab's
**own** store (never DicTeX's folder), same principle as the removed #66
recorder (see AGENTS.md "Two-layer dataset enrichment"): an **empty layer is
skipped**, so the two datasets stay separable purely by which layer was
filled —

- a **picked segment** (real audio) + Layer 1 writes an `acoustic` correction
  (`raw_transcript` = the segment's raw STT, `corrected_transcript` = Layer 1);
  a **paste** source has no audio, so it never writes `acoustic`;
- Layer 1 + Layer 2 writes a `math_transform` correction (`raw_transcript` =
  Layer 1, `corrected_transcript` = Layer 2) — Layer 2 can never be saved
  without Layer 1, since Layer 1 is its input;
- both can be written together (chained on the same segment identity), giving
  one record in each dataset once exported.

The entry is also marked into the chosen benchmark-set split (train pool /
validation / test frozen) so it is immediately visible to `buildSttDatasetExport`
and to the run launched from `Experiments`. A **paste**-sourced entry has no real
audio: internally it is still assigned a string `audioRef` (not `null`) so the
shared `getSttBenchmarkSetSegments` derivation picks it up, but the Lab's own
`serializeDatasetRecord` maps that back to `audio_ref: null, audio_path: null`
in the exported JSONL — the export never claims a fake audio file exists for a
text-only, math_transform-only entry. A **picked-segment** entry always keeps
its real `audio_ref`/`audio_path`, resolved against the configured (read-only)
DicTeX data folder.

### Layer 2 prefill + diff (issue #101)

Once Layer 1 has content, the Lab prefills Layer 2 by running the FULL
normalizer pipeline (dictionary -> command extraction -> regex, the SAME fold
`apps/dictex` serves at inference and the export replays, #100) over Layer 1,
reading the SOURCE folder's dictionary/rules read-only (a main-process call —
the renderer cannot touch `node:fs` — behind the
`dataset-builder:prefill-layer2` IPC channel). Command extraction turns a
spoken command into a sentinel; before the result ever reaches the renderer,
`restoreCommandWords` (`packages/shared/src/commands.ts`) maps it back to its
canonical spoken phrase, so the field never holds a sentinel or a literal
command effect (the storage rule, design doc §4) — only canonical words, in
both layers.

Example (from the design doc): Layer 1 `retour à la ligne x au carré plus
deux` prefills Layer 2 with `retour à la ligne $x^{2}$ plus deux` — the regex
recognizes "au carré" (a real operand on both sides) and emits canonical LaTeX
wrapped in `$…$` (#107), but not "plus deux" (spelled out, not a digit/letter
operand), so the human fixes three words instead of typing the whole line.

What changed is always shown, inline, as a compact word-level diff between
Layer 1 and the prefill (`packages/shared/src/textDiff.ts`) — a prefilled
field invites passive acceptance, and a subtly wrong regex output accepted
without looking would teach layer 3 that error, or enter `validation` as
ground truth. The prefill is only ever a starting point: further edits to
Layer 2 are never overwritten by a later prefill unless the field still holds
an earlier, untouched auto-prefill (or is empty); `Save entry` writes exactly
whatever is left in the field, same as before this issue.

### Manual Lab smoke test

1. `scripts\npm.cmd run dev:lab`, confirm the window opens to the Segments
   view and the data-folder line shows `%APPDATA%/dictex-app/data (default)`
   with a `data folder ok` pill when DicTeX has recorded at least once.
2. Confirm DicTeX segments recorded by `apps/dictex` appear in the list
   (read from the source folder), and `Play` plays their audio.
3. Sélectionner un segment dans `Corpus`. Le type d'une correction n'est plus
   choisi librement : il découle du bouton cliqué. `Edit Layer 1` écrit
   toujours une correction `acoustic` dont le `raw_transcript` est la sortie STT
   brute ; `Edit Layer 2` écrit toujours une correction `math_transform` dont le
   `raw_transcript` est la dernière couche 1 (le bouton reste désactivé tant
   qu'aucune couche 1 n'existe, la couche 1 étant l'entrée de la couche 2).
   Vérifier dans `Open Lab events log` que l'événement `stt_correction` écrit
   porte bien cette paire `correction_kind` / `raw_transcript`, et qu'aucune
   paire incohérente — un `acoustic` dont le `raw_transcript` serait déjà une
   couche 1, ou un `math_transform` chaîné sur le STT brut — n'est atteignable
   depuis cette vue (`DEC-COUCHE1-001`, `docs/product-decisions.md`). Affecter
   ensuite le split `Test frozen` ; confirmer que la correction et le split
   n'atterrissent que dans le journal du Lab et que `events.jsonl` de DicTeX
   reste intact.
4. Lancement et résultat séparés (issue #138). Dans `Experiments`, parcourir le
   flux en cinq étapes : étape, dataset, candidats, protocole, lancement.
   Confirmer que `STT` et `Normalizer` sont lançables, que le bout en bout reste
   affiché désactivé avec sa raison, et qu'aucun résumé ni résultat
   historique n'apparaît dans ce formulaire. Vérifier que le protocole annonce
   `audio -> Layer 1`, l'entrée `audio`, la cible `Layer 1 (acoustic)`, le split
   choisi (`Validation` par défaut), le nombre de membres évaluables et
   l'identité complète de chaque candidat, et qu'il indique que le snapshot est
   figé automatiquement au lancement — aucune action manuelle de création de
   snapshot n'existe. Cliquer sur `Run experiment` (nécessite le venv ou
   `DICTEX_PYTHON`) : la progression s'affiche pendant l'exécution, puis le Lab
   bascule sur `Results` avec le run tout juste créé déjà sélectionné. Dans
   `Results`, vérifier le statut, le snapshot, les candidats lancés, le résumé,
   les sorties par segment, les erreurs et `Export for LLM` — et qu'aucun
   contrôle de lancement n'y figure. Lancer un second run, puis revenir au
   premier depuis le sélecteur : confirmer qu'il affiche exclusivement son
   propre snapshot, ses propres sorties et ses propres scores. Sélectionner
   enfin `Legacy (pre-run results)` et confirmer qu'il ne montre que les
   résultats sans `run_id`.
4bis. Progressive candidate selector (issue #126). In `Candidates`, confirm
   there is a compact list of the 1-3 currently-selected candidates (each with
   its model, runtime variant and prompt), with `Replace` and `Remove`
   actions, and an `Add a candidate` button — no flat grid of checkboxes.
   Click `Add a candidate` (or `Replace`): the `Model` control opens a
   vertically-bounded, scrollable list grouped by provider, built only from the
   real catalog; choosing a model closes that list. Two controls then appear —
   `Runtime` and `Prompt` — side by side on a wide window and stacked on a
   narrow one; each collapses once a value is chosen. Choosing a prompt closes
   its list and shows the full prompt text read-only below; the `baseline`
   choice shows "Baseline — no initial_prompt." instead of fake text. Confirm
   the controls only ever offer identities that exist in the catalog (a single
   runtime stays the only runtime value), and that `Add candidate`/`Replace
   candidate` enforces the 1-3 limit (the last remaining candidate cannot be
   removed; an already-selected identity cannot be added twice).
4ter. Set `DICTEX_STT_PROMPT_VARIANTS` (see "Comparer les variantes de
   contexte dans le Lab" above), restart the Lab, and confirm the same
   faster-whisper model now offers a `baseline` prompt plus one prompt per
   variant in the `Prompt` control (labelled by display name, never a hash),
   and that the split selector is back on `Validation` by default. Build three
   candidates from one model — baseline plus two variants — click
   `Run experiment`; in `Results`, confirm the summary table of that run shows
   three distinct rows for that one model (not merged into one) and stays inside
   its panel (it scrolls horizontally rather than widening the page). For a Vosk
   candidate, confirm the `Prompt` control is replaced by "No prompt — this
   provider has no initial_prompt." with no fake baseline text.
4quater. Secondary prompt creation (issues #121/#126). With a faster-whisper
   model chosen, click `New prompt` beside the `Prompt` control; confirm the
   creation form is hidden until then. Click `Cancel` and confirm it collapses
   with no event written. Reopen it, create a variant (e.g. id
   `prompt-lab-fr-math`, display name `Lab math (FR)`, a short prompt text);
   confirm the form collapses and the new variant is immediately available in
   the current candidate's `Prompt` control, labelled by its display name.
   Restart the Lab and confirm it is still selectable — persistence across
   restart. Try creating it again with the same id; confirm it is rejected, the
   typed values and error stay visible, and the original definition is
   unchanged. Try an empty id, an id with a space, an empty display name, and an
   empty prompt text; confirm each is rejected. Confirm there is no edit/delete
   affordance anywhere.
4quinquies. Overflow validation (issues #126 et #138). Resize the Lab window to
   roughly 320 px, 560 px and 760 px wide, with a deliberately long model name, a
   long candidate identity and a long prompt text present. Confirm at each width
   the page never gains a horizontal scrollbar, in `Experiments` (the five steps,
   the stage choices, the protocol summary, the candidate identities, the live
   progress) as well as in `Results` (the run header, the snapshot members, the
   per-candidate outputs and the dense summary table): every child stays within
   the `app-shell`, choice lists scroll vertically inside their bounded height,
   and the summary table scrolls inside its own panel (regression check for B1 of
   #126: each content panel's grid column is `minmax(0, 1fr)`, so a nowrap table
   can no longer inflate the column and spill the panel's other children past its
   border). Check the empty states too: `Experiments` with no evaluable member in
   the split, and `Results` with no run yet. Confirm the whole selector is usable
   by keyboard with a visible focus ring and that expanded/collapsed controls are
   announced (aria-expanded / listbox roles).
4sexies. Run tracking + acoustic snapshot (issues #122 et #138). With at least
   one corrected `Validation` segment, click `Run experiment`; confirm the Lab
   moves to `Results` with the new run already selected in the run list
   (`date · N seg · done/failed`). Launch a second run: confirm a second, distinct
   run appears and that switching the selector between the two shows each run's
   own snapshot, outputs and numbers (they are never merged).
   Then, in `Corpus`, re-correct one of the run's segments with a deliberately
   different Layer 1; go back to `Results`, re-select the earlier run, and confirm
   its snapshot reference and its CER/WER are unchanged (the snapshot is frozen).
   Assign a paste-sourced (no-audio) `math_transform`-only entry to `Validation`,
   launch a run, and confirm it is NOT counted in the evaluable member count
   announced before the launch, nor in the run's snapshot, and never appears as a
   failed segment. Confirm `Open Lab events log` shows one
   `stt_benchmark_run_started` (with the snapshot + `dataset_kind:"acoustic"`),
   the per-candidate `stt_benchmark_result` events carrying that `run_id`, and a
   terminal `stt_benchmark_run_finished`. Finally select `Legacy (pre-run
   results)` and confirm it only ever shows results with no `run_id`.
4septies. Export LLM d'un run (issue #123). Sélectionner un run terminé dans
   `Results`, cliquer sur `Export for LLM` dans son détail, puis vérifier que le
   résumé affiche le nombre de segments, de candidats et de sorties manquantes.
   Ouvrir le dossier avec `Open export folder` et confirmer qu'il contient
   exactement `manifest.json`, `dataset.acoustic.jsonl` et `outputs.jsonl`.
   Vérifier dans le manifeste le `run_id`, le snapshot, les identités complètes
   des candidats et le texte complet de chaque prompt, puis rapprocher une
   ligne du dataset et une ligne de sorties par `session_id + segment_id`.
   Re-corriger ensuite le segment ou le déplacer hors de `validation`, réexporter
   le même run et confirmer que sa référence et ses scores ne changent pas.
   Enfin, exporter deux fois rapidement et confirmer que deux dossiers distincts
   sont conservés, sans fichier audio copié et sans modification des journaux.
5. In `Dataset`, use **Build a dataset entry**: paste a transcription (no
   segment) and type a Layer 1 literal transcript containing a rule the
   shipped default regex recognizes plus a word it does not (e.g.
   `x au carré plus deux`); confirm Layer 2 prefills shortly after with the
   pipeline's output (e.g. `$x^{2}$ plus deux`) and that a compact diff appears
   showing "au carré" struck through and "$x^{2}$" highlighted as added, with
   "plus deux" unmarked. Edit Layer 2 by hand and confirm your edit is kept
   (not overwritten) even if you then tweak Layer 1 again. Clear Layer 1 and
   confirm the prefill/diff disappear.
   Then: pick a DicTeX segment, type a Layer 1 literal transcript, leave
   Layer 2 empty, choose `Test frozen`, and click `Save entry`; confirm the
   notice reports an `acoustic` save only.
   Paste a transcription (no segment), leave the raw text empty, fill Layer 1
   and Layer 2, and save; confirm the notice reports a `math_transform` save
   only, with a freshly minted `lab_manual_…` identity. Pick another segment,
   fill both layers, and save; confirm the notice reports both `acoustic` and
   `math_transform` for that segment's real identity.
6. Click `Export dataset`; confirm the `<split>.acoustic.jsonl` /
   `<split>.math_transform.jsonl` files from step 5 contain one record each
   per filled layer, that the acoustic-only record has a real, resolved
   `audio_path` under DicTeX's data folder, and that the math_transform-only
   (pasted) record has `audio_ref: null` and `audio_path: null`. Confirm
   DicTeX's `events.jsonl` is still unchanged.
7. Back in `Experiments`, with `Test frozen` selected, confirm the announced
   evaluable member count now includes the segment built in step 5, then click
   `Run experiment` (needs the venv or `DICTEX_PYTHON`); in `Results`, confirm
   that segment appears in the run's snapshot, outputs and candidate summary
   alongside any other `Test frozen` segment.
8. Point the data folder at a different directory (or reset it) and confirm
   the segment list refreshes from the new source.

## Global Dictation Hotkey

DicTeX registers this global toggle shortcut:

```text
Win+Alt+Space
```

Behavior:

```text
press once -> start recording
press again -> stop recording, transcribe, copy, paste
```

On Windows, global hotkey dictation pastes into the active application after copying the transcript to the clipboard. On other platforms, the transcript is copied to the clipboard and auto-paste is skipped for now.

The manual `Hold to dictate` button still records and copies to clipboard without auto-pasting.

The UI also exposes diagnostics shortcuts:

- `Open data folder`
- `Open events log`

## STT Engine

The local engine uses `faster-whisper`.

### Durée de vie : worker persistant (dictée) et chemin ponctuel (Lab)

La dictée quotidienne de DicTeX utilise le worker faster-whisper persistant
(`packages/engine/worker.py`, protocole NDJSON de #114) au lieu de relancer un
processus par dictée. Le processus principal Electron gère sa durée de vie via
`apps/dictex/src/main/sttWorkerClient.ts` (client NDJSON d'une génération) et
`sttWorkerManager.ts` (cycle de vie) :

- préchauffage asynchrone après l'ouverture de la fenêtre ; une dictée terminée
  avant l'état prêt attend le worker au lieu de perdre son audio ;
- un seul worker et un seul modèle actifs à la fois : changer de modèle (ou de
  périphérique / type de calcul) arrête proprement l'ancien worker avant d'en
  démarrer un nouveau, pour ne jamais garder deux modèles en mémoire vidéo ;
- requêtes séquentielles corrélées par identifiant, chacune portant l'audio, la
  langue et un `initial_prompt` éventuel ; le worker rejette une requête visant
  un autre modèle plutôt que de le recharger en silence ;
- reprise bornée : si le worker meurt pendant une requête, le processus
  principal redémarre une seule fois et rejoue une seule fois la requête depuis
  l'audio déjà stocké ; après un second échec l'erreur remonte et l'audio ainsi
  que `audio_segment` restent disponibles pour une reprise manuelle ;
- à la fermeture, arrêt demandé au worker puis terminaison forcée après un délai
  borné ;
- jamais de bascule silencieuse vers une boucle de processus ponctuels.

Le worker ne renvoie que la transcription STT brute ; `prepareNormalization`
s'exécute ensuite dans le processus principal (On applique le pipeline, Off garde
la sortie brute octet par octet). **Le réglage du normaliseur ne redémarre jamais
le worker** : seuls le modèle, le périphérique ou le type de calcul le font. Le
modèle n'est donc chargé qu'une fois par configuration et par session
d'application ; les dictées suivantes ne paient plus ce chargement.

**DicTeX Lab conserve le chemin ponctuel** `transcribeWithPython` /
`transcribe.py` : il compare des modèles différents et n'a pas besoin d'un modèle
maintenu en mémoire. Ne pas généraliser le worker persistant au Lab.

Home expose l'état du worker sous les libellés `Preparing`, `Ready`, `Busy`,
`Restarting` et `Error`, ainsi que le temps de préparation de la génération
courante et la dernière inférence chaude lorsqu'ils existent. Ces notifications
Electron ne bloquent ni l'ouverture de la fenêtre ni l'enregistrement audio.

Chaque génération effectivement prête ajoute un `stt_engine_ready` append-only
avec son identifiant, son moteur/modèle/configuration, `worker_startup_ms`
(lancement Electron jusqu'au message `ready`) et `model_load_ms` (mesure du
worker autour du chargement). Chaque `stt_result` ajoute
`stt_worker_generation`, `stt_ready_wait_ms` et
`stt_inference_duration_ms`. `transcription_duration_ms` conserve sa
sémantique historique : durée perçue entre la soumission de la transcription et
son résultat, attente de disponibilité comprise. Les lecteurs historiques
ignorent `stt_engine_ready` et les champs additionnels.

Defaults:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

Override example (from the repository root):

```powershell
$env:DICTEX_STT_MODEL="small"
$env:DICTEX_STT_LANGUAGE="fr"
scripts\npm.cmd run dev
```

### Selecting the STT model from the UI

The active STT model can also be chosen at runtime from the compact selector in
the controls panel (models: `tiny`, `base`, `small`, `large-v3-turbo`, plus any
`DICTEX_STT_BENCHMARK_MODELS` entries). The choice applies to subsequent
dictations; in-flight transcriptions are unaffected.

The selection is persisted in a small local settings file under the Electron
`userData` data directory:

```text
data/settings.json
```

```json
{"sttModel":"large-v3-turbo","normalizerEnabled":true}
```

It is a minimal flat JSON object. Model precedence is:

```text
saved UI choice (settings.json) > DICTEX_STT_MODEL env var > built-in default (base)
```

A missing or malformed `settings.json` never crashes the app or blocks
dictation: it degrades to the env var / default with a quiet console
diagnostic. `stt_result` events keep recording the model actually used per
segment.

### Interrupteur du normaliseur

La vue Home expose un interrupteur anglais `Normalizer` On/Off. Son booléen
`normalizerEnabled` est enregistré dans `data/settings.json` et s'applique à la
dictée suivante. Un champ absent — notamment dans un ancien fichier antérieur à
#105 — vaut `true` afin de préserver le comportement historique.

Sur On, le pipeline dictionnaire → extraction des commandes → regex s'exécute.
Sur Off, DicTeX n'appelle jamais `normalizeTranscript` : le presse-papiers et le
collage automatique reçoivent la sortie STT brute octet par octet, et les mots
de commande restent littéraux. DicTeX ajoute tout de même un événement
`normalization_result` portant `disabled: true`, sans `passthrough`, avec des
`layers` et `diagnostics` vides. `passthrough` reste réservé à un pipeline activé
qui s'est exécuté sans modifier son entrée.

L'interrupteur est désactivé pendant l'enregistrement et la transcription afin
qu'un segment ne change pas de politique en cours de traitement. Le Lab n'est
pas concerné : son outil de saisie et son export rejouent toujours explicitement
le normaliseur.

### GPU (CUDA) STT

To run STT on an NVIDIA GPU instead of CPU (from the repository root):

```powershell
$env:DICTEX_STT_MODEL="large-v3-turbo"
$env:DICTEX_STT_DEVICE="cuda"
$env:DICTEX_STT_COMPUTE_TYPE="float16"
scripts\npm.cmd run dev
```

The Windows `ctranslate2` CUDA wheel bundles cuDNN but not cuBLAS. If the
machine has no system-wide CUDA Toolkit install, `cublas64_12.dll` will be
missing and transcription fails with
`RuntimeError: Library cublas64_12.dll is not found or cannot be loaded`.
Install it via pip instead of the full CUDA Toolkit:

```powershell
.\.venv\Scripts\python.exe -m pip install --use-feature=truststore nvidia-cublas-cu12 nvidia-cudnn-cu12
```

`packages/engine/transcribe.py` prepends that package's `bin` directory to
`PATH` at startup on Windows, so no manual `PATH` changes are needed after
installing it.

On Windows, if Python is not available through `py -3.11`, set:

```powershell
$env:DICTEX_PYTHON="C:\Users\souid\DicTeX\.venv\Scripts\python.exe"
```

In development, the Electron app automatically uses the repository `.venv` Python when it exists.

### Second STT provider (Vosk)

The Python sidecar has a small provider abstraction (`packages/engine/providers/`):
`faster-whisper` is the dictation engine and default benchmark provider; **Vosk**
is a second, benchmark-only provider (a different, Kaldi-based engine family —
see `docs/product-decisions.md`). Vosk is fully optional: without it installed,
dictation and faster-whisper benchmarking are unchanged, and the Vosk candidate
is skipped with a quiet diagnostic.

To enable Vosk benchmark candidates:

1. Install the optional dependency:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install --use-feature=truststore -r packages\engine\requirements-vosk.txt
   ```

2. Download a French Vosk model (e.g. `vosk-model-small-fr-0.22` from
   <https://alphacephei.com/vosk/models>), unzip it, and point
   `DICTEX_VOSK_MODEL_DIR` at the directory that holds the model folder:

   ```powershell
   $env:DICTEX_VOSK_MODEL_DIR="C:\path\to\vosk-models"
   # so C:\path\to\vosk-models\vosk-model-small-fr-0.22\ exists
   ```

Relevant env vars:

```text
DICTEX_STT_PROVIDER          selects the sidecar provider (default faster-whisper)
DICTEX_VOSK_MODEL_DIR        base directory holding unpacked Vosk model folders
DICTEX_VOSK_BENCHMARK_MODELS comma-separated Vosk model names to benchmark
                             (default vosk-model-small-fr-0.22; empty disables)
```

Model resolution is local-only and never downloads: the sidecar uses `model` as
a path if it exists, else `DICTEX_VOSK_MODEL_DIR/<model>`, else the candidate is
reported unavailable. Vosk needs 16 kHz mono PCM and does not decode compressed
audio, so the sidecar decodes stored segments with PyAV (already installed by
faster-whisper) — no extra decode dependency.

### Variantes de contexte initial STT (`initial_prompt` de faster-whisper)

`initial_prompt` fournit un contexte initial au décodeur faster-whisper ; ce
n'est pas un « system prompt » de LLM. Le mécanisme est implémenté par #93 et
s'intègre à l'identité `{stage, provider, model, variant}` sans changer le
schéma. Sans variante demandée, la transcription suit exactement le chemin
historique. Une variante n'est appliquée que lorsqu'elle est nommée
explicitement.

Le texte doit rester court et orienté vocabulaire/contexte. Il peut améliorer
les noms et termes scientifiques, mais aussi biaiser la sortie : #94 doit donc
comparer l'absence de contexte et plusieurs variantes sur les mêmes audios de
`validation` avant de choisir la valeur de la dictée quotidienne.

1. Define named variants as a JSON object mapping variant name -> prompt text,
   via `DICTEX_STT_PROMPT_VARIANTS`:

   ```powershell
   $env:DICTEX_STT_PROMPT_VARIANTS = '{"prompt-v3-fr-math":"Dictée mathématique en français : x carré, intégrale, dérivée, équation."}'
   ```

   This is JSON, not a comma-separated list like `DICTEX_STT_BENCHMARK_MODELS`,
   because prompt text may itself contain commas. Missing or malformed JSON
   quietly yields no variants rather than crashing the sidecar. Authoring the
   prompt text itself is a product decision, out of scope for #93 — the
   example above is illustrative only.

2. Request one variant per sidecar invocation via `DICTEX_STT_PROMPT_VARIANT`
   (singular — the variant *name*, not the text):

   ```powershell
   $env:DICTEX_STT_PROMPT_VARIANT = "prompt-v3-fr-math"
   ```

   On the TypeScript side, set `SttConfig.promptVariant` to the variant name
   before calling `transcribeWithPython` (`packages/shared/src/sttEngine.ts`);
   it sets `DICTEX_STT_PROMPT_VARIANT` on the sidecar's environment only when
   present, leaving the env shape (and therefore the sidecar's output) for an
   unset `promptVariant` completely unchanged. `getSttPromptVariants()` parses
   `DICTEX_STT_PROMPT_VARIANTS` on the TS side (e.g. to list variant names in a
   future benchmark UI — see #94), mirroring `getSttBenchmarkModels()`'s style.

   The resulting benchmark candidate `variant` **appends** the prompt name to the
   runtime identity — `cuda-float16-fr+prompt-v3-fr-math` — rather than replacing
   it. The runtime and the prompt are independent dimensions, and
   `benchmarkSummary` keys a candidate on `stage/provider/model/variant`: a
   variant collapsed to the prompt name alone would give the same identity to the
   same prompt run on `cpu-int8` and on `cuda-float16`, averaging their CER into
   one row. With no prompt requested the string is unchanged (`cpu-int8-fr`), so
   no historical result changes identity.

Relevant env vars:

```text
DICTEX_STT_PROMPT_VARIANT   name of the prompt variant to apply this run (unset = no prompt, unchanged today)
DICTEX_STT_PROMPT_VARIANTS  JSON object mapping variant name -> prompt text (unset = {}, no variants defined)
```

Requesting a prompt variant on a provider other than `faster-whisper` (i.e.
Vosk, which has no prompt concept) is a hard, loud failure: the sidecar exits
non-zero with a descriptive stderr message, never a silent no-op. Requesting an
undefined variant name is likewise a loud failure, so a typo in the variant
name can never be mistaken for "prompt applied".

### Comparer les variantes de contexte dans le Lab (issue #94)

Une expérience du Lab compare directement la baseline sans prompt et les
variantes de `initial_prompt` configurées, sur les mêmes segments audio.

#### Expérience de validation du 12–13 juillet 2026

Deux runs terminés, sans échec, ont utilisé le même snapshot de 27 segments de
`validation` avec `large-v3-turbo` sur `cuda:float16` :

- `run_20260712224742095_9rg1sv0m` : baseline sans prompt, `prompt-lexique-v1`
  et une référence CPU ;
- `run_20260712232416876_p804k6qh` : `prompt-lexique-v1`,
  `conventions-litterales-v1` et `conventions-litterales-v2`.

Les deux variantes littérales illustrent la cible de `DEC-COUCHE1-001` par de
petites phrases complètes plutôt que par une simple liste de termes :

```text
conventions-litterales-v1
Dictée mathématique en français, transcrite littéralement en mots. theta plus trois. Le sinus de theta est égal à trois. x au carré plus trois. Le sinus de x au carré. Les nombres restent écrits en lettres et les expressions mathématiques restent verbalisées.

conventions-litterales-v2
Dictée mathématique en français. Le sinus de theta est égal à trois. Calculons x au carré plus trois. Le sinus de x au carré est positif. Theta est compris entre zéro et trois.
```

Résultats du second run :

| Variante | CER acoustique moyen | médiane | CER strict moyen | WER moyen | latence moyenne |
| --- | ---: | ---: | ---: | ---: | ---: |
| `prompt-lexique-v1` | 12,01 % | 8,00 % | 14,78 % | 26,56 % | 3,99 s |
| `conventions-litterales-v1` | 9,03 % | 3,33 % | 12,74 % | 27,23 % | 3,98 s |
| `conventions-litterales-v2` | **8,57 %** | **2,90 %** | **12,16 %** | **26,26 %** | 3,99 s |

`conventions-litterales-v2` est le gagnant **provisoire** : face au lexique sur
le même run, il améliore 13 segments, en laisse 13 à égalité et en dégrade un.
Les exemples montrent surtout un meilleur maintien des nombres en lettres. Le
snapshot ne contient encore qu'un cas ciblé pour `theta` et peu de cas capables
de départager `sinus` ou `au carré` ; ces sous-conventions exigent donc une
collecte ciblée avant de fixer un seuil de conformité.

La porte de sortie de #94 n'est pas encore franchie. La baseline sans prompt
n'était pas incluse dans le second run, v1 et v2 restent trop proches pour être
départagées solidement, et le prompt gagnant n'est pas encore appliqué à la
dictée quotidienne. Le prochain run de décision doit réunir dans **un même
run** la baseline, `conventions-litterales-v2` et au plus une variante courte
ajoutant les cas encore faibles (`rho`, `angle`), sur un snapshot enrichi.

Le catalogue de candidats est construit dans le processus principal du Lab
(`apps/lab/src/main/candidateCatalog.ts`, jamais codé en dur dans le
renderer) : pour chaque modèle faster-whisper de
`DICTEX_STT_BENCHMARK_MODELS`, une candidature baseline (sans prompt) plus une
candidature par entrée de `DICTEX_STT_PROMPT_VARIANTS` ; pour chaque modèle
Vosk de `DICTEX_VOSK_BENCHMARK_MODELS`, une seule candidature baseline, Vosk
n'ayant aucune notion de prompt. L'identité complète
`{stage, provider, model, variant}` de chaque candidat voyage jusqu'au
renderer ; le contrat IPC `benchmark:run-set-stt` prend 1 à 3 identités
complètes (`candidates`), plus jamais une simple liste de noms de modèle, afin
que deux variantes du même modèle puissent être cochées et exécutées
ensemble. Le processus principal revalide toujours la sélection reçue contre
son propre catalogue avant de lancer quoi que ce soit.

Dans la vue `Experiments`, l'étape « Candidates » présente ce catalogue via un
sélecteur progressif (issue #126, voir « Sélecteur progressif de candidats »
ci-dessous), et non une grille plate de cases à cocher. Chaque libellé reste
« baseline » ou le nom d'affichage de la variante — jamais la chaîne technique
de variant (par ex. `cpu-int8-fr+prompt-v3-fr-math`). Le résumé par candidat,
dans `Results`, filtre par identité complète de candidat : deux variantes du
même modèle apparaissent comme deux lignes distinctes au lieu d'être fusionnées.
Le split évalué est choisi à l'étape « Dataset » et ouvre par défaut sur
`validation` ; `test_frozen` demeure sélectionnable explicitement mais n'est
jamais implicite (voir « Discipline d'évaluation » dans `docs/roadmap.md`).
Depuis #138, le split de `Results` est un filtre de lecture distinct : parcourir
les runs d'un autre split ne modifie jamais le protocole prêt à être lancé.

### Plusieurs runtimes par modèle dans le benchmark (issue #131)

Le catalogue peut proposer plusieurs runtimes faster-whisper pour un même
modèle, afin de comparer explicitement CPU/GPU et types de calcul dans un même
run, sans redémarrer le Lab. La variable `DICTEX_STT_BENCHMARK_RUNTIMES` est une
liste séparée par des virgules de couples `device:compute_type` :

```powershell
$env:DICTEX_STT_BENCHMARK_RUNTIMES = "cpu:int8,cpu:int16,cuda:float16,cuda:int8_float16"
```

`parseSttBenchmarkRuntimes` (`apps/lab/src/main/candidateCatalog.ts`) normalise
les espaces, déduplique les couples exacts et **rejette bruyamment** une entrée
mal formée avec un diagnostic actionnable — un couple sans `:`, un device ou un
type de calcul vide, ou `auto`/`default` (un candidat reproductible doit
annoncer un type de calcul explicite, jamais laisser CTranslate2 en choisir un
derrière son identité). Une entrée invalide fait échouer la construction du
catalogue au lieu d'être ignorée ou devinée.

Lorsque la variable est **absente ou vide**, le comportement historique à un
seul runtime est reproduit exactement à partir de `DICTEX_STT_DEVICE` et
`DICTEX_STT_COMPUTE_TYPE` (défauts `cpu` / `int8`), sans changer l'identité d'un
candidat existant. La langue reste une dimension globale unique
(`DICTEX_STT_LANGUAGE`), partagée par tous les runtimes.

`buildSttBenchmarkCandidateCatalog` construit le produit cartésien
`modèle × runtime × (baseline + variantes de prompt)` : chaque runtime devient
un jeu de candidats distinct par modèle, portant son runtime structuré
(`{device, computeType, language}`) et une identité `variant` distincte via
`buildSttVariantId`. L'exécution construit le `SttConfig` du sidecar depuis ce
runtime structuré (`buildSttConfigForCandidate`), jamais en reparcourant la
chaîne `variant` ni en reprenant un runtime global : un candidat affiché
`cuda-float16-fr` s'exécute réellement sur cuda/float16. Le sélecteur progressif
de #126 fait apparaître automatiquement chaque runtime configuré comme un choix
séparé et cliquable, sans fabriquer de combinaison côté renderer. Vosk reste un
fournisseur CPU sans dimension de type de calcul : il n'est **pas** multiplié
par les runtimes et conserve son identité `cpu-<langue>` et son absence de
prompt.

Combinaisons de départ recommandées :

- `cpu:int8` — référence CPU portable et par défaut ;
- `cpu:int16` — expérimental, seulement sur un CPU Intel adapté (jeu
  d'instructions récent) ; sinon CTranslate2 peut le convertir implicitement ;
- `cuda:float16` — référence GPU sur la machine de développement (voir
  « GPU (CUDA) STT ») ;
- `cuda:int8_float16` — quantification mixte INT8/FP16 sur GPU.

Limites matérielles à garder en tête : un runtime configuré n'est pas garanti
utilisable par tous les modèles ni sur toute machine ; le Lab ne détecte pas
CUDA et ne sonde pas la VRAM, il exécute exactement la liste configurée.
CTranslate2 peut **convertir implicitement** un type de calcul non supporté vers
un autre (par ex. `cuda:int16` ou `cpu:float16`), ce qui rendrait l'identité du
candidat trompeuse ; c'est pourquoi ces valeurs ne sont pas recommandées et
pourquoi `auto`/`default` sont refusés. Un couple demandé mais non exécutable
sur la machine provoque une erreur dure de faster-whisper : le segment entier
du run est marqué en échec, et des résultats partiels peuvent subsister pour
les candidats déjà exécutés avant la panne. Vérifier chaque runtime sur la
machine avant de l'inclure dans un run.

Variables pertinentes :

```text
DICTEX_STT_BENCHMARK_RUNTIMES  liste "device:compute_type" séparée par des virgules
                               (absente/vide = runtime unique DICTEX_STT_DEVICE/COMPUTE_TYPE)
```

### Sélecteur progressif de candidats (issue #126)

La sélection des candidats — l'étape « Candidates » du flux de lancement
d'`Experiments` depuis #138 — est recomposée pour rester compacte et contenue
dans la fenêtre (`CandidateSelector`, `apps/lab/src/renderer/src/main.tsx`). Le renderer ne fabrique jamais une
combinaison absente du catalogue : il ne fait que grouper et décomposer les
`SttBenchmarkCandidateOption` réelles reçues de
`diagnostics:get-stt-benchmark-candidates`.

- une liste compacte affiche les 1 à 3 candidats retenus (modèle, variante de
  runtime, prompt) avec `Replace` et `Remove` ; le dernier candidat ne peut pas
  être retiré, une identité déjà retenue ne peut pas être ajoutée deux fois ;
- « ajouter ou remplacer » choisit d'abord un modèle dans une liste bornée et
  défilable, groupée par fournisseur ; choisir un modèle referme cette liste ;
- apparaissent ensuite deux contrôles séparés — variante de runtime et prompt —
  côte à côte quand la largeur le permet, empilés sinon ; chacun se replie dès
  qu'une valeur est choisie. S'il n'existe qu'une variante de runtime, elle est
  préchoisie et reste la seule valeur ;
- le texte complet du prompt choisi s'affiche en lecture seule sous les
  contrôles ; la baseline sans prompt est présentée comme telle, sans faux
  texte ;
- un fournisseur sans `initial_prompt` (Vosk) masque entièrement le choix de
  prompt au lieu d'inventer une baseline faster-whisper ;
- l'option secondaire `New prompt`, placée près du choix de prompt, révèle à la
  demande le formulaire de création de #121 (voir ci-dessous) ; `Cancel` le
  replie sans écriture.

Pour l'accessibilité et la robustesse de mise en page : listes de choix bornées
en hauteur avec défilement vertical, tableau dense « Candidate summary » contenu
dans son panneau par un défilement horizontal local, focus clavier visible et
états développés/repliés annoncés (`aria-expanded`, rôles `listbox`/`option`).
Le lancement du benchmark, la limite de trois candidats, le défaut `validation`,
les scores et les résumés sont inchangés.

### Variantes immuables créées dans le Lab (issue #121)

Avant #121, une variante de `initial_prompt` ne pouvait être définie que par la
variable d'environnement `DICTEX_STT_PROMPT_VARIANTS` au lancement du Lab. La
vue `Experiments` permet désormais de créer une variante directement dans
l'interface : un identifiant (`id`), un nom affiché et le texte complet du
prompt. Depuis #126, ce n'est plus un panneau permanent mais l'action
secondaire `New prompt`, placée près du choix de prompt du sélecteur de
candidats et révélée à la demande (voir « Sélecteur progressif de candidats »).
Seul faster-whisper est concerné — Vosk n'a toujours aucune notion de prompt et
n'affiche jamais cette action.

Ces définitions sont **strictement immuables** : elles sont écrites une seule
fois dans le journal propre du Lab sous forme d'événements à ajout uniquement
`stt_prompt_variant_defined` (`variant_name`, `display_name`, `prompt_text`,
`created_at`), et aucune action ni canal IPC ne permet de les modifier ou de
les supprimer. Un identifiant vide, invalide (seuls lettres, chiffres, `.`,
`_` et `-` sont acceptés) ou déjà utilisé — par une définition locale **ou**
par une variante externe `DICTEX_STT_PROMPT_VARIANTS` — est refusé sans
jamais remplacer silencieusement une définition existante
(`apps/lab/src/main/promptVariants.ts`). Une ancienne ligne de journal
invalide (champ manquant ou vide) est ignorée sans bloquer le chargement des
définitions valides restantes (`getSttPromptVariantDefinitions`,
`packages/shared/src/localEvents.ts`).

Les variantes locales et externes restent listées ensemble comme choix de
prompt d'un candidat, chacune libellée par son nom d'affichage — jamais un
identifiant technique ou un hash. Une variante locale dont l'identifiant
entrerait en collision avec une variante externe apparue *après* sa création
(l'environnement du Lab a changé) est masquée (`shadowedByExternal`) : la
définition externe garde toujours l'identité du candidat, la locale est
simplement exclue du catalogue plutôt que de produire une moyenne silencieuse
entre deux prompts différents. `listPromptVariants`
(`apps/lab/src/main/promptVariants.ts`) expose toujours cette distinction
d'origine et le drapeau de masquage pour un futur usage, même si l'ancien
panneau de liste permanent a été retiré par #126.

Chaque variante créée alimente directement le catalogue de candidats de #94
(`buildSttBenchmarkCandidateCatalog`) : elle apparaît comme un choix de prompt
supplémentaire sous chaque modèle faster-whisper configuré, au même titre
qu'une variante externe, et peut être sélectionnée à l'étape « Candidates »
comme n'importe quel autre candidat. Comme le worker/sidecar ne connaît les
variantes externes que par `DICTEX_STT_PROMPT_VARIANTS`, une variante locale
n'y figurant pas, son texte de prompt est transmis explicitement pour cet
appel via `SttConfig.promptText` puis fusionné dans la table
`DICTEX_STT_PROMPT_VARIANTS` de l'environnement du seul processus enfant
lancé (`mergeLocalPromptVariantIntoEnvTable`,
`packages/shared/src/sttEngine.ts`) ; une variante externe (sans
`promptText`) laisse cette table héritée totalement inchangée, donc le chemin
existant reste identique.

**Verifying the no-prompt path is unchanged.** Because #93's hard requirement
is "no prompt configured ⇒ byte-identical output", verify it against a real,
previously-recorded audio segment before relying on any prompt-variant
benchmark result:

1. Pick a stored segment's `audio_ref` under the DicTeX data folder (see
   "Local STT Data" below) that was already transcribed with faster-whisper.
2. Re-run it through the sidecar directly, without setting
   `DICTEX_STT_PROMPT_VARIANT`:

   ```powershell
   .\.venv\Scripts\python.exe packages\engine\transcribe.py "C:\path\to\data\audio\session_...\seg_0001.webm"
   ```

3. Compare the printed `transcript` (and the rest of the JSON) against the
   segment's existing `stt_result` / `stt_benchmark_result` event in
   `events.jsonl`. They must match exactly — the same as before #93 existed,
   since `initial_prompt` is only added to the faster-whisper call when a
   prompt variant is actually resolved.

## Local STT Data

The app stores local STT data under Electron's `userData` directory:

```text
data/
  events.jsonl
  audio/
    session_<timestamp>/
      seg_0001.webm
  normalizer/
    dictionary.json
    rules.json
  exports/
    stt-dataset-<timestamp>/
      manifest.json
      <split>.<correction_kind>.jsonl
    stt-benchmark-run-<timestamp>/
      manifest.json
      dataset.acoustic.jsonl
      outputs.jsonl
```

The `exports/` folder holds generated dataset snapshots (see "Corrected Dataset
Export"); it is written from, never rewritten into, the event log.

Chaque dictée écrit au moins deux événements, et chaque génération prête ajoute
un événement d'observabilité distinct :

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_mime_type":"audio/webm;codecs=opus","audio_size_bytes":25412}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_language":"fr","stt_output":"...","corrected_transcript":null}
```

```json
{"event_type":"stt_engine_ready","worker_generation":"generation_...","stt_engine":"faster-whisper","stt_model":"base","stt_device":"cpu","stt_compute_type":"int8","worker_startup_ms":4200,"model_load_ms":3900}
```

The STT benchmark set run (issue #122) is a tracked, append-only experiment. It
writes a run-start event fixing the acoustic snapshot and the launched
candidates, then one result per (segment, candidate) carrying the run's
`run_id`, then a terminal run-finished event:

```json
{"event_type":"stt_benchmark_run_started","run_id":"run_20260712T100000000Z_ab12cd34","created_at":"2026-07-12T10:00:00.000Z","stage":"stt","dataset_kind":"acoustic","split":"validation","candidates":[{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","prompt_variant":null}],"snapshot":[{"session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","reference_transcript":"x au carré","correction_created_at":"2026-07-09T00:00:00.000Z"}]}
```

```json
{"event_type":"stt_benchmark_result","run_id":"run_20260712T100000000Z_ab12cd34","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830,"score_metric":"cer","score_value":0.12,"score_reference_type":"stt_correction"}
```

```json
{"event_type":"stt_benchmark_run_finished","run_id":"run_20260712T100000000Z_ab12cd34","created_at":"2026-07-12T10:05:00.000Z","done":1,"failed":0,"failures":[]}
```

The `dataset_kind` is always `acoustic`: the snapshot excludes any no-audio
`math_transform`-only entry, so an STT run never scores an audio-less record. A
legacy `stt_benchmark_result` recorded before #122 carries no `run_id`; it stays
readable and is reported as legacy, never attached to a modern run. See
`docs/dataset-and-normalization-design.md` §9.

Le lancement refuse aussi dans le processus principal un snapshot sans segment
audio évaluable, avant tout événement `stt_benchmark_run_started` : le preview
du renderer est asynchrone et ne suffit donc pas comme garde d'intégrité. Un
segment n'est compté `done` que lorsqu'au moins un candidat a produit une sortie
enregistrée ; si tous les candidats sont indisponibles, le terminal le consigne
comme `failed`. Un ancien run terminé qui annonce `done` sans aucune sortie est
préservé mais affiché « completed without output », distinct de `missing` qui
signifie bien qu'aucune exécution n'a été enregistrée. L'export LLM conserve la
même distinction et ne compte pas cet état de compatibilité parmi les sorties
manquantes.

### Contrat stage-aware pour les futurs benchmarks (issue #139)

Le writer STT reste volontairement inchangé : il continue d'écrire uniquement
`stt_benchmark_run_started`, `stt_benchmark_result` et
`stt_benchmark_run_finished`. Aucun double-write et aucune migration de journal
ne sont autorisés. Les nouveaux stages utilisent les événements génériques
`benchmark_run_started`, `benchmark_result` et `benchmark_run_finished`, dont
les types, validations et projections pures vivent dans
`packages/shared/src/benchmarkContract.ts`.

Le contrat est une union discriminée, pas un objet rempli de champs optionnels :

```text
stage stt            + dataset_kind acoustic
  snapshot           = audio_ref + référence Layer 1 + date acoustique
  result             = transcript STT + métadonnées STT typées

stage math_transform + dataset_kind math_transform
  snapshot           = Layer 1 textuelle + cible Layer 2 + date math_transform
  result             = sortie textuelle + durée + traces de couches typées
```

`end_to_end` appartient à `BenchmarkRunStage` comme nom réservé, mais n'apparaît
dans aucune union d'événement implémentée. Une tentative de l'écrire échoue donc
à la compilation et à la validation d'exécution au lieu de créer un snapshot
incomplet.

Le helper `buildMathTransformBenchmarkRunSnapshot(events, split)` sélectionne la
dernière correction `math_transform` de chaque membre et copie **sa propre**
paire : `raw_transcript` → couche 1, `corrected_transcript` → couche 2. Il ne
relit pas la dernière correction acoustique pour fabriquer l'entrée ; une
correction acoustique postérieure ne peut donc pas changer la paire. Un membre
textuel peut porter `audio_ref: ""` dans les événements de corpus et reste
évaluable : l'audio n'entre pas dans ce stage.

Le terminal stage-aware compte des tentatives candidat × membre et ses failures
portent aussi l'identité candidat complète. La projection applique ces règles :

- premier `benchmark_run_started` valide d'un `run_id` faisant foi, à travers
  les deux familles de starts ;
- premier `benchmark_result` valide par candidat × membre faisant foi dans la
  nouvelle famille ;
- premier terminal valide faisant foi ;
- résultat d'un autre run, stage, candidat ou membre ignoré ;
- résultat après le terminal ignoré ;
- `done` si une sortie existe, `failed` si le terminal porte une failure pour
  le slot, `missing` sinon.

`validateBenchmarkRunStartedEvent`, `validateBenchmarkResultEvent` et
`validateBenchmarkRunFinishedEvent` contrôlent chaque forme. La validation
croisée `validateStageAwareBenchmarkEvents` signale doublons, orphelins,
stages incohérents et références à un candidat ou membre absent sans modifier le
journal.

Pour `Results`, `getBenchmarkRunProjections(events, split)` renvoie un modèle
commun en adaptant séparément :

1. les runs STT modernes de la famille `stt_benchmark_*` (`stt_tracked`) ;
2. les nouveaux runs `benchmark_*` (`stage_aware`) ;
3. les résultats STT sans `run_id` dans un seau virtuel explicite
   (`stt_legacy`).

La collision accidentelle d'un `run_id` entre familles ne fusionne jamais les
résultats : le premier start possède l'identifiant. L'adaptateur STT conserve en
plus `completed_without_output`, état historique de #138. Les fonctions
`buildSttBenchmarkRunDetail`, `summarizeSttBenchmarkRun` et
`buildSttBenchmarkRunExport` restent inchangées ; le résumé et l'export LLM STT
gardent donc leur compatibilité historique et leur schéma 3.

#139 n'ajoutait ni lancement Normalizer, ni contrôle renderer, ni nouveau format
d'export. Le premier writer `math_transform` et son affichage sont désormais
implémentés par #140 selon la procédure ci-dessous.

### Référence du normaliseur déterministe (issue #140)

Dans `Experiments`, l'étape visible `Normalizer` correspond au stage interne
`math_transform`. Choisir un split affiche le nombre exact de paires évaluables :
pour chaque membre, `buildMathTransformBenchmarkRunSnapshot` prend la dernière
correction `math_transform` et copie sa propre couche 1, sa couche 2 et sa date.
L'audio n'est ni requis ni relu.

La prévisualisation charge une instance du normaliseur partagé depuis le dossier
source en lecture seule. Elle annonce un seul candidat, affiché sous le nom
`Current deterministic pipeline`, dont l'identité est :

```text
stage    = math_transform
provider = dictex
model    = deterministic-pipeline
variant  = dictionary-sha256:<64 hex>;rules-sha256:<64 hex>
```

Les deux empreintes couvrent les sources complètes effectivement chargées par
cette instance ; en l'absence de fichier, elles couvrent la configuration par
défaut réellement appliquée. Le lancement recharge une seule instance, recalcule
son identité et la compare à celle annoncée. Un changement entre prévisualisation
et clic provoque un refus avant `benchmark_run_started`, jamais un run dont la
provenance mentirait.

Le run écrit dans le journal propre au Lab :

1. un `benchmark_run_started` avec le snapshot textuel et le candidat figés ;
2. un `benchmark_result` par paire, produit par
   `createTranscriptNormalizer` — dictionnaire → extraction des commandes →
   règles regex — avec sortie finale, durée et traces ordonnées ;
3. un `benchmark_run_finished` dont les compteurs portent sur les tentatives
   candidat × membre.

Avant l'écriture d'un résultat, `restoreCommandWords` est appliqué à la sortie
et à chaque entrée/sortie de trace. Une paire source contenant déjà une
sentinelle PUA est refusée : le journal du benchmark ne peut donc en écrire
aucune. `Results` canonicalise sortie et cible avec `canonicalizeLatex`, affiche
l'exact match, le nombre exact de réussites sur le total, le diff de chaque
membre et ses traces. Aucune équivalence sémantique n'est ajoutée : une prose
inchangée peut réussir, tandis qu'une portée différente reste un échec visible.

Procédure de référence :

1. qualifier plusieurs paires `math_transform` dans `Corpus` et les placer dans
   `Validation` ; inclure au moins une prose inchangée, une règle couverte et un
   cas de portée non couvert ;
2. ouvrir `Experiments`, choisir `Normalizer` puis `Validation`, contrôler le
   nombre de paires et les deux SHA-256 complets ;
3. lancer le run et vérifier le basculement vers `Results` ;
4. contrôler `Layer 1 -> Normalizer -> Layer 2`, le résumé réussites/total, les
   diffs et les traces de couches ;
5. recorriger ensuite un membre dans `Corpus`, rouvrir le run précédent et
   confirmer que son snapshot, son score et son détail n'ont pas changé ;
6. ouvrir le journal du Lab et confirmer l'absence de caractères PUA dans les
   trois familles d'événements du run.

Depuis #130, la référence d'un benchmark STT est exclusivement la dernière
correction `acoustic` disponible au démarrage. Une correction
`math_transform`, `normalization` ou `rephrasing` plus récente n'est jamais un
repli. Le benchmark ponctuel applique directement cette règle ; le benchmark
par lot fige le texte et la date dans son snapshot, puis les résultats, le
résumé et l'export LLM réutilisent cette référence sans relire la correction
courante. En l'absence de correction acoustique, les champs de référence et les
scores restent `null`.

Les runs créés avant #130 peuvent avoir figé par erreur une autre couche, en
particulier une cible LaTeX `math_transform`. Ils restent append-only et ne sont
ni modifiés ni réparés rétroactivement : les relancer pour obtenir une mesure
acoustique valide avant toute comparaison ou sélection de candidat.

### Export local d'un run pour analyse par un LLM

Un run STT **terminé** peut être exporté depuis son détail dans `Results` avec
`Export for LLM`. Cette action n'appelle aucun service distant : elle lit le
run et ses résultats dans le journal propre au Lab, puis crée un nouveau dossier
horodaté sous `data/exports/`. Une collision de timestamp ajoute un suffixe au
nouveau dossier ; aucun export antérieur n'est écrasé. Le dossier contient
exactement trois fichiers :

- `manifest.json` : version du schéma (`3` depuis la correction de revue de
  #138 ; `2` avait ajouté les deux CER dans #134), dates, `run_id`, stage,
  split, statut, référence au snapshot, description distincte des deux CER et du
  WER, identités complètes des candidats et définitions des prompts (`id`, nom
  affiché, texte complet) une seule fois ;
- `dataset.acoustic.jsonl` : une ligne par membre du snapshot figé, avec
  `session_id`, `segment_id`, `audio_ref`, `audio_path`, transcription de
  référence et date de correction utilisées au démarrage du run ;
- `outputs.jsonl` : une ligne par même couple `session_id + segment_id`, avec
  tous les candidats du run. Chaque sortie porte `done`, `failed`, `missing` ou
  `completed_without_output` pour un ancien terminal contradictoire, le
  transcript et la latence lorsqu'ils existent, ainsi que `strict_cer`,
  `acoustic_cer` (#134) et `wer` lorsque le snapshot possède une référence.

Les noms de fichiers du manifeste sont relatifs : le paquet peut donc être
déplacé avec son dossier. `audio_path` reste une provenance absolue de la source
locale ; aucun audio n'est recopié. L'export ne relit jamais l'appartenance ou la
correction courante de `validation` : il utilise exclusivement le snapshot du
`stt_benchmark_run_started` et les résultats portant son `run_id`.

Depuis #123, le run-start conserve aussi une liste `prompt_definitions` avec le
nom affiché et le texte complet de chaque prompt effectivement lancé, une seule
fois par identifiant. Cela fige aussi une variante provenant de
`DICTEX_STT_PROMPT_VARIANTS` si l'environnement change après le run. Pour un run
#122 plus ancien, l'export résout encore la référence immuable disponible dans le
Lab ou l'environnement ; il refuse explicitement l'export si cette définition
n'est plus disponible plutôt que d'inventer un texte.

Depuis #134, l'export porte **deux** projections CER de la même paire
transcript/référence figée, plus le WER :

- `strict_cer` : le score textuel strict historique. Casse et espaces de bord
  sont normalisés, le sous-ensemble LaTeX connu est canonicalisé, mais la
  ponctuation de phrase est comptée : il mesure la fidélité exacte de la sortie.
- `acoustic_cer` : la **même** normalisation stricte, puis les seuls signes de
  ponctuation de phrase `.` `,` `;` `:` `!` `?` `…` remplacés par un séparateur
  et les espaces réduits, avant le même calcul. Il ignore uniquement la
  ponctuation de phrase, jamais les apostrophes, traits d'union, chiffres,
  lettres grecques, symboles mathématiques, parenthèses ou délimiteurs `$`.
  C'est la métrique mise en avant pour comparer baseline et variantes de
  `initial_prompt`, car un candidat qui entend les mots sans reproduire les
  virgules ne doit pas être artificiellement classé moins bon.

Aucun des deux CER n'établit d'équivalence sémantique entre chiffres et mots,
noms de lettres grecques et symboles, ou expressions mathématiques ; seul
`acoustic_cer` ignore en plus la ponctuation de phrase. Le WER découpe sur les
espaces avec la même normalisation stricte. Ces limites sont recopiées dans
chaque manifeste. Les deux CER sont dérivés à la lecture depuis le transcript et
la référence figée : aucun événement historique n'est réécrit, et un run
antérieur reste lisible tant que son snapshot porte une référence.

STT corrections are append-only events linked to the original segment:

```json
{"event_type":"stt_correction","created_at":"2026-07-05T00:00:00.000Z","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","raw_transcript":"...","corrected_transcript":"...","correction_method":"keyboard"}
```

The important MVP decision is to preserve the audio -> raw STT -> correction -> benchmark score relationship without rewriting earlier events.

## STT Candidate Summary

The `Candidate summary` panel aggregates `stt_benchmark_result` events by
candidate identity (`stage` + `provider` + `model` + `variant`). It is
read-only: it never appends events, it only reads and summarizes what a run
already logged.

Since issue #122 the summary is scoped to **one tracked run**, not to the whole
split: the `Results` run selector lists each run of the browsed split (newest
first, `date · N seg · done/failed`), and a launch from `Experiments` selects the
run it just created (issue #138). The numbers come from that run's frozen snapshot and its own
`run_id`-tagged results, so two runs of the same split stay separate and a later
re-correction or membership change never moves a historical run's numbers. A
final `Legacy (pre-run results)` option summarizes any pre-#122 results (no
`run_id`), clearly flagged as legacy.

Per candidate it reports:

- **segments**: how many of the run's snapshot segments have a logged result for
  that candidate;
- **mean/median acoustic CER** (highlighted, issue #134): the Character Error
  Rate with sentence punctuation (`. , ; : ! ? …`) neutralized before scoring,
  so a candidate that heard the words but not the commas is not penalized. This
  is the primary metric for comparing candidates and `initial_prompt` variants;
- **mean/median strict CER**: Character Error Rate, the edit distance between the
  candidate transcript and the corrected transcript divided by the corrected
  transcript's length. `0%` is a perfect match; higher is worse. Strict CER is
  case-insensitive and ignores leading/trailing whitespace, but is otherwise
  literal — it counts sentence punctuation and does not know that two spellings
  mean the same thing. Both CERs are derived from the frozen snapshot reference,
  so historical runs get the acoustic value without any event rewrite;
- **mean/median WER**: Word Error Rate, the same edit-distance idea but over
  whitespace-separated words instead of characters. WER is coarser than CER
  (one wrong letter in a word counts as a whole wrong word) and is more in
  line with how a human would judge a transcript at a glance;
- **mean latency**: average `transcription_duration_ms` across that
  candidate's logged results, so a lower-CER candidate that is much slower is
  still visible, not hidden behind the score;
- **missing**: run snapshot segments with no logged result for that candidate.
  In this table alone a failed attempt and a segment that was never benchmarked
  look the same; the run-finished event's `failures` list is what separates the
  two (a snapshot segment absent from both results and `failures` was not
  executed — e.g. a partial stop). Re-run the set benchmark to fill gaps.

Le résumé STT reste STT-only par construction. Le stage `math_transform` possède
depuis #140 son propre résumé d'exact match canonique dans `Results` ; les deux
stages ne sont jamais agrégés dans la même table.

## STT Candidate Selection

The `Candidate summary` panel also lets the user mark which STT candidate is
the currently selected base model, so that choice does not have to live only
in memory or in `DICTEX_STT_MODEL`. Selection is manual: choosing the
highest-quality candidate blindly can be wrong if it is much slower, so the
panel keeps mean latency visible next to CER/WER when picking one.

Enter a reason and click `Select` (or `Reselect`) on a candidate's row in the
summary table. This appends an `stt_candidate_selection` event; it never
overwrites or removes prior selections, so the full selection history stays in
`events.jsonl`. The panel reads the latest such event (latest-event-wins, same
rule as every other append-only marker in this file) to show which candidate
is currently selected.

```json
{"event_type":"stt_candidate_selection","created_at":"2026-07-08T00:00:00.000Z","stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr","selection_reason":"best quality/latency tradeoff on test_frozen"}
```

This is a manual record for the user's own reference; it does not change
`DICTEX_STT_MODEL` or any other runtime config, and DicTeX does not act on it
automatically.

## Normalization Pipeline

Lorsque l'interrupteur `Normalizer` est sur On, DicTeX exécute avant la copie ou
le collage un pipeline texte-vers-texte ordonné : dictionnaire personnel
(couche 1), extraction des commandes, puis règles regex de verbalisation
mathématique (couche 2). La couche 3 seq2seq viendra plus tard sans modifier
cette interface.

The personal dictionary is a user-editable JSON file. Empty by default; a
missing or invalid file degrades to passthrough (byte-identical output) with a
quiet diagnostic, never a crash or a blocked dictation. Use the `Open
dictionary` button to create/open it.

```text
data/normalizer/dictionary.json
```

```json
{"version":1,"entries":[{"from":"dic tex","to":"DicTeX"}]}
```

Entries are literal, case-sensitive substring replacements applied in file
order. Malformed individual entries are skipped (with a diagnostic) while valid
entries still apply.

The regex rules layer runs after the dictionary. Unlike the dictionary, it
ships a small default set of conservative French math-verbalization rules that
applies out of the box, even before the rules file exists. Use the `Open
rules` button to create/open it; the seeded file contains the shipped
defaults, editable in place.

```text
data/normalizer/rules.json
```

```json
{"version":1,"rules":[{"pattern":"...","replacement":"$$$<p1>^{2}$$","flags":"i"}]}
```

Each rule's `pattern` is a Unicode-aware JS regex source (always matched with
forced `g`/`u` flags, plus any `flags` given); `replacement` may reference
capture groups (`$1`, `$2`, ... or `$<name>` for named groups), and a literal
`$` is written as `$$` (needed to emit the delimiters below). Rules apply in
file order. Every default rule requires a real operand (a run of digits, or a
single Unicode letter standing for a variable) on both sides of the keyword,
and rejects a match where that operand is glued to a surrounding letter/digit
— this is what keeps prose like "de plus en plus" or "je suis moins fatigué"
untouched, since "plus"/"moins" only convert between two such operands.

**The rules emit canonical LaTeX, not Unicode** (issue #107, following the
LaTeX decision in `docs/dataset-and-normalization-design.md` §8): inline maths
is wrapped in `$…$` (the same delimiter convention `canonicalizeLatex` and
DicTeX Lab use), prose stays bare. The default set covers: "x au carré" ->
`$x^{2}$`, "x au cube" -> `$x^{3}$`, "x puissance n" -> `$x^{n}$`, "racine
(carrée) de x" -> `$\sqrt{x}$`, "x égal(e) y" -> `$x = y$`, "plus grand/petit
que" -> `$x > y$`/`$x < y$`, "plus"/"moins"/"fois" -> `$x + y$`/`$x - y$`/`$x
\times y$`, and "divisé par" -> `$\frac{x}{y}$`. Each rule's output is already
a fixed point of `canonicalizeLatex` (`packages/shared/src/latex.ts`), so
scoring/export never treat it as needing repair.

A regex cannot group or scope, so "au carré"/"au cube"/"puissance"/"racine
(carrée) de"/"divisé par" — the rules that introduce a NEW brace around their
operand — stay restricted to a single bare digit run or letter on every
operand, exactly as before: `\frac{a}{b}` needs both operands unambiguous, so
"a divisé par b plus un" cannot compose "b plus un" into one denominator
("un" spelled out is not a single-token operand). The remaining rules ("x
égale y", "plus/petit que", "plus", "moins", "fois") never add a new brace, so
they MAY also accept an already-`$…$`-wrapped fragment as an operand — this is
what keeps the chaining property alive under LaTeX: "x au carré plus y" first
becomes "$x^{2}$ plus y" (the bracing "au carré" rule, bare operand "x"), then
"plus" matches the whole wrapped fragment "$x^{2}$" as its left operand and
merges it with "y" into one span, "$x^{2} + y$". Adopting LaTeX therefore
*grows* what the rules cannot reach (grouping/scoping stays out of reach by
design) — that residual is exactly what normalizer layer 3 is for (§7).

A malformed rules file (bad JSON or shape) disables the whole layer with a
passthrough and a quiet diagnostic; a malformed individual rule (e.g. invalid
regex) is skipped the same way individual dictionary entries are.

**Migration d'un `rules.json` antérieur à #107 :** ce fichier est modifiable par
l'utilisateur et DicTeX ne le réécrit jamais. Une ancienne installation continue
donc à produire ses règles Unicode. Avant les essais quotidiens, fermer DicTeX,
copier le fichier sous un nom horodaté, puis renommer l'original et laisser
DicTeX créer les nouvelles règles LaTeX au prochain démarrage. Vérifier ensuite
les éventuelles règles personnelles et les reporter volontairement. Ne jamais
supprimer l'unique copie ni mélanger silencieusement les deux conventions.

The raw `stt_result` event is left untouched. Each dictation appends a separate
append-only `normalization_result` event recording the input, the final output,
and every layer's output, so a wrong insertion can be attributed to a specific
layer:

```json
{"event_type":"normalization_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","input_transcript":"x au carré","output_transcript":"$x^{2}$","passthrough":false,"layers":[{"layer":"personal_dictionary","input":"x au carré","output":"x au carré","applied":false,"diagnostics":[]},{"layer":"regex_rules","input":"x au carré","output":"$x^{2}$","applied":true,"diagnostics":[]}],"diagnostics":[]}
```

History shows the raw transcript; the normalized inserted text is shown
distinctly when it differs.

## Corrected Dataset Export

The `Dataset` view exports the corrected STT dataset to local JSONL files for
later Phase 3 normalizer training and Phase 4 STT acoustic fine-tuning. Click
`Export dataset`; nothing is uploaded and the event log is never rewritten. Each
export goes to its own timestamped folder so prior exports are never clobbered:

```text
data/exports/stt-dataset-<timestamp>/
  manifest.json
  test_frozen.acoustic.jsonl
  test_frozen.math_transform.jsonl
  validation.acoustic.jsonl
  ...
```

Files are named `<split>.<correction_kind>.jsonl`. Only segments that have a
benchmark-set membership (`train_candidate_pool` / `validation` / `test_frozen`)
**and** at least one typed correction produce records; frozen test lands in its
own files. The exporter reads every correction event of a segment and keeps the
latest of **each** `correction_kind` (not just the single latest event), so a
segment enriched with chained `acoustic` + `math_transform` corrections yields
one record in each dataset — the acoustic (STT) and math_transform (normalizer)
datasets stay separable. Untyped legacy corrections cannot be routed by kind, so
they are skipped and counted in the manifest and UI rather than dropped
silently.

Each JSONL record is traceable back to its source events:

```json
{"split":"test_frozen","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","audio_path":"C:\\Users\\...\\data\\audio\\session_...\\seg_0001.webm","language":"fr","correction_kind":"acoustic","raw_transcript":"x au carre","corrected_transcript":"x au carré","original_stt_output":"x au carre","stt_engine":"faster-whisper","stt_model":"base","correction_method":"keyboard","correction_created_at":"2026-07-09T00:00:00.000Z","selected_candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"selection_reason":"best tradeoff"}
```

`raw_transcript` / `corrected_transcript` are the transform's input and target
(for `acoustic`, audio -> literal transcript; for `math_transform`, literal text
-> notation). `original_stt_output` preserves the raw STT output even when a
chained correction's own `raw_transcript` is a later literal transcript. The
selected base candidate is the latest `stt_candidate_selection`; export still
proceeds when none has been recorded (`selected_candidate` is null and the UI
notes it). `manifest.json` records per-split / per-kind counts, the total, the
skipped-untyped count, and the selection.
