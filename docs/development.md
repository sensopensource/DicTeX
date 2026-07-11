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

`apps/lab` is the separate **DicTeX Lab** app (pivot Phase 2, see
`pivot_dictex_lab_split.md`). It has **no microphone, no hotkey, no
clipboard/paste, and no normalizer**: it is where the ML tooling lives —
STT benchmark (segment/batch, candidate summary, error analysis, candidate
selection), typed corrections, benchmark-set split membership, and the
test_frozen-compatible dataset export. It reuses `packages/engine`
(faster-whisper + Vosk) for STT and `packages/shared` for all derivation /
scoring / export logic, so DicTeX and the Lab cannot diverge.

Run it (from the repository root):

```powershell
scripts\npm.cmd run dev:lab
```

```sh
scripts/npm.sh run dev:lab
```

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
and to the Benchmark view's set runner. A **paste**-sourced entry has no real
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
3. `Correct` a segment (choose a correction kind), then set its split to
   `Test frozen`; confirm both land only in the Lab's events log
   (`Open Lab events log`) and DicTeX's `events.jsonl` is untouched.
4. In `Benchmark`, click `Benchmark latest` (needs the venv or
   `DICTEX_PYTHON`); confirm `tiny`/`base`/`small` transcripts + latency
   appear. Confirm the split selector opens on `Validation` (the default).
   Switch it to `Test frozen`, run `Run analysis`, `Summarize by candidate`,
   and `Select` a candidate.
4bis. Set `DICTEX_STT_PROMPT_VARIANTS` (see "Comparer les variantes de
   contexte dans le Lab" above), restart the Lab, and confirm the same
   faster-whisper model now shows a baseline row and one row per variant in
   the checkbox catalog, and that the split selector is back on `Validation`
   by default. Check the baseline plus two variants of the same model (3
   candidates), run `Run analysis`, then `Summarize by candidate`; confirm
   the summary table shows three distinct rows for that one model (not
   merged into one) and that unchecking a variant removes only that row on
   the next summarize.
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
7. Back in `Benchmark`, with `Test frozen` selected, click `Run analysis`
   (needs the venv or `DICTEX_PYTHON`); confirm the segment built in step 5
   appears in the batch outcomes and candidate summary alongside any other
   `Test frozen` segments.
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

Le Benchmark du Lab compare directement la baseline sans prompt et les
variantes de `initial_prompt` configurées, sur les mêmes segments audio.

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

Dans la vue Benchmark, le panneau « Benchmark set » présente ce catalogue
groupé par fournisseur puis par modèle, avec des cases à cocher libellées
« baseline » ou par le nom de la variante — jamais par la chaîne technique de
variant (par ex. `cpu-int8-fr+prompt-v3-fr-math`). Le panneau « Candidate
summary » filtre désormais par identité complète de candidat, donc deux
variantes du même modèle apparaissent comme deux lignes distinctes au lieu
d'être fusionnées. Le sélecteur de split de la vue Benchmark — partagé avec le
flux général hérité de #64, une seule variable d'état pilotant `Run analysis`
et `Summarize by candidate` pour les deux usages — ouvre désormais par défaut
sur `validation` ; `test_frozen` demeure sélectionnable explicitement mais
n'est jamais implicite (voir « Discipline d'évaluation » dans
`docs/roadmap.md`).

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

The STT benchmark actions reuse stored audio segments and append one result per tested model:

```json
{"event_type":"stt_benchmark_result","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr","candidate":{"stage":"stt","provider":"faster-whisper","model":"small","variant":"cpu-int8-fr"},"stt_engine":"faster-whisper","stt_model":"small","stt_language":"fr","transcript":"...","audio_duration_seconds":2.4,"transcription_duration_ms":1830,"score_metric":"cer","score_value":0.12,"score_reference_type":"stt_correction"}
```

STT corrections are append-only events linked to the original segment:

```json
{"event_type":"stt_correction","created_at":"2026-07-05T00:00:00.000Z","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm","raw_transcript":"...","corrected_transcript":"...","correction_method":"keyboard"}
```

The important MVP decision is to preserve the audio -> raw STT -> correction -> benchmark score relationship without rewriting earlier events.

## STT Candidate Summary

The `Candidate summary` panel aggregates `stt_benchmark_result` events for a
chosen benchmark set split (`Test frozen` or `Validation`) by candidate
identity (`stage` + `provider` + `model` + `variant`). It is read-only: it
never appends events, it only reads and summarizes what `Run set benchmark`
already logged.

Per candidate it reports:

- **segments**: how many split segments have a logged result for that
  candidate;
- **mean/median CER**: Character Error Rate, the edit distance between the
  candidate transcript and the corrected transcript divided by the corrected
  transcript's length. `0%` is a perfect match; higher is worse. CER is
  case-insensitive and ignores leading/trailing whitespace, but is otherwise
  literal, so it does not know that two spellings mean the same thing;
- **mean/median WER**: Word Error Rate, the same edit-distance idea but over
  whitespace-separated words instead of characters. WER is coarser than CER
  (one wrong letter in a word counts as a whole wrong word) and is more in
  line with how a human would judge a transcript at a glance;
- **mean latency**: average `transcription_duration_ms` across that
  candidate's logged results, so a lower-CER candidate that is much slower is
  still visible, not hidden behind the score;
- **missing**: split segments with no logged result for that candidate. A run
  that crashed mid-flight never appended an `stt_benchmark_result` event, so a
  failed attempt and a segment that was never benchmarked look the same here;
  re-run the set benchmark to fill gaps.

Only the STT stage is scored today; the summary is STT-only by construction
because it groups by `stage`, so a future `math_transform` or `normalization`
candidate would summarize separately once that stage starts scoring results.

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
