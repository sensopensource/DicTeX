# UX / UI design review — DicTeX + DicTeX Lab (issue #84)

> **Revue historique terminée.** La direction courante vit dans
> `docs/roadmap.md`. Les propositions B et F ont reçu leur décision produit et
> sont regroupées dans #96, qui appartient au chemin de l'outil quotidien. La
> règle de langue postérieure confirme que les futurs libellés restent en
> anglais : **Start / Stop**. La proposition A est #95 et reste une maintenance hors
> chemin critique. Les autres propositions restent différées.

A design pass over both renderers: DicTeX Home (`apps/dictex`) and the Lab views
(`apps/lab` — Segments, Benchmark, Dataset). The goal is to keep the two apps
coherent and to close small quality gaps **without drifting from the product
direction**: compact, sober, utility-like, minimal colors, clear state,
diagnostics visible but not noisy — close to OpenCode / OpenWhispr. No
landing-page hero, gradients, decorative typography, SaaS-dashboard feel, or
broad settings pages (`docs/product-decisions.md` → "UI Direction").

Each finding is tagged **[safe]** (implemented in this PR) or **[needs product
call]** (left as a written proposal for a human to greenlight).

---

## Method

- Read both `styles.css` files and both `main.tsx` renderers end to end.
- Inventoried every hardcoded color (33 distinct hexes in DicTeX, 28 in the Lab,
  heavily overlapping) and every duplicated base rule.
- Cross-checked every `className` in the JSX against the CSS to find classes that
  were used but unstyled (drift introduced by the #77/#83 slimming).

## Shell du Lab : Corpus, Experiments et Results (#136)

Le shell du Lab est désormais organisé selon trois tâches stables, sans modifier
les événements, les corrections, les splits ni les exports :

- **Corpus** rassemble les segments DicTeX, leurs corrections, le choix du
  split, le builder manuel à deux couches et l’export Dataset ;
- **Experiments** contient la sélection des candidats STT, le split évalué et
  le lancement des benchmarks ;
- **Results** sert à choisir un run, en lire le statut et les résumés, consulter
  l’analyse d’erreurs, sélectionner un candidat et exporter un run pour un LLM.

La navigation reste locale en React, compacte et sans bibliothèque de routage.
Les actions et états existants sont conservés : le changement porte uniquement
sur leur regroupement visible, afin de préparer le benchmark du normaliseur sans
figer le Lab dans le seul vocabulaire STT.

## Séparer le lancement de son résultat (#138)

#136 avait regroupé les panneaux ; #138 sépare enfin les deux temps qu'ils
mélangeaient. Un protocole se **prépare** ; un run est **figé**. Tant que les
deux vivaient dans la même page, l'utilisateur devait deviner quels panneaux
décrivaient ce qu'il allait lancer et lesquels décrivaient ce qui avait déjà été
mesuré — et cette page ne pouvait pas accueillir proprement une seconde étape
expérimentale.

- **`Experiments` n'est plus qu'un formulaire de lancement**, en cinq étapes
  ordonnées : étape, dataset, candidats, protocole, lancement. Le protocole est
  annoncé avant l'exécution — entrée `audio`, cible `Layer 1 (acoustic)`,
  transformation `audio -> Layer 1`, split, membres évaluables, identité complète
  des candidats — parce qu'une expérience qui n'annonce pas ce qu'elle mesure
  n'est pas relisible ensuite.
- **Une étape non exécutable est annoncée, jamais offerte.** Normaliseur et bout
  en bout apparaissent désactivés avec leur raison : un contrôle qui ne fait rien
  est un mensonge que l'utilisateur ne découvre qu'après avoir cliqué.
- **`Results` est la lecture d'un run et rien d'autre.** Il ne porte aucun
  contrôle de lancement, et tout ce qu'il affiche — snapshot, candidats, sorties,
  erreurs, résumé, export — est dérivé des seuls événements de ce run.
- **Un lancement réussi devient son résultat** : le run créé est sélectionné et
  la vue suit, au lieu de laisser l'utilisateur retrouver son propre run dans une
  liste.
- **Le rejeu ad hoc disparaît.** `Benchmark latest` produisait des résultats sans
  run, donc sans snapshot ni référence explicable, qui ressortaient ensuite comme
  de faux résultats « legacy ». Une mesure appartient désormais toujours à un run.

Le risque réel de cette vue n'est pas un mauvais clic mais un clic **périmé** :
deux sélections en vol, la plus lente qui atterrit en dernier, et un run affiché
contre le snapshot d'un autre. La sélection est donc une petite machine à états
pure (`resultsSelection.ts`) : choisir un run efface immédiatement les données du
précédent, et une réponse qui ne répond plus à la sélection courante est ignorée.

---

## Findings and what was done

### 1. No shared visual layer — the two apps were drifting **[safe]**

Roughly 200 lines of **byte-identical** CSS were copy-pasted across the two apps
(reset, `.panel`, `.nav-*`, `.status-pill`, `.secondary-*`, `textarea`, `.error`,
`.notice`, `.empty-state`, the whole history-row block, …). Colors were literal
hexes in both files, so any tweak had to be mirrored by hand or the apps would
diverge.

**Done:** added `packages/shared/src/styles.css` — a single source of truth with
design tokens (surfaces, borders, text tiers, state accents, focus ring, radius,
spacing, font, motion) plus the genuinely shared base/component rules. Both
renderers import it before their own stylesheet. Each app stylesheet now holds
**only** what is unique to that app and references `var(--…)` tokens instead of
raw hex. Net result: −208 lines, one place to change a shade.

```
packages/shared/src/styles.css   tokens + reset + panels + headers + nav +
                                  status pills + buttons + inputs + history +
                                  error/notice/empty
apps/dictex/.../styles.css        record button, shortcut/model rows,
                                  diagnostics grid, history toggle, last
                                  transcript, footer
apps/lab/.../styles.css           correction panel, benchmark/batch/summary/
                                  error-analysis, dataset export
```

### 2. Inconsistent panel headers **[safe]**

The same "title + subtitle on the left, action on the right" header was written
four different ways: `.history-header` (DicTeX), and `.history-header` /
`.correction-header` / `.benchmark-header` (Lab) — four rule blocks, identical
output.

**Done:** unified them into one shared `.panel-header` used by every view in both
apps, including the responsive column-stack on narrow widths.

```
┌ panel-header ─────────────────────────────────┐
│  Title                              [ Action ] │
│  subtitle / path (muted, ellipsised)           │
└────────────────────────────────────────────────┘
```

### 3. Style drift from the post-pivot slim — unstyled elements **[safe]**

The #77/#83 slimming left several classes referenced in JSX but with **no CSS
rule**, so they rendered wrong:

- **DicTeX** `.last-transcript-panel` and `.footer-panel` had no padding → content
  sat flush against the panel border; `.transcript` `<pre>` was completely
  unstyled → no wrapping, default margins, overflow.
- **Lab** `.summary-panel` and `.error-analysis-panel` are `panel`-only (no
  padded companion class) → the candidate-summary table and error-analysis cards
  sat flush against their borders; `.benchmark-models` (the read-only data-folder
  path and the "Models: …" line) was unstyled.

**Done:** added the missing rules (padded panels; a proper read-only
`.transcript` block that wraps and scrolls; a muted `.benchmark-models`
metadata line).

### 4. Focus / hover / disabled were inconsistent **[safe]**

- No `:focus-visible` styling anywhere → keyboard focus was nearly invisible.
- Disabled states disagreed: `.record-button:disabled` used `cursor: default;
  opacity: 0.7`, while `.secondary-button:disabled` used `cursor: not-allowed;
  opacity: 0.45`, and `.nav-button` had no disabled/active/focus handling at all.
- Selects had no hover; only buttons did.

**Done:**
- A shared keyboard-only `:focus-visible` ring (sober desaturated blue), plus a
  calm border-highlight on focus for text inputs/selects (mouse users don't get
  `:focus-visible` on click).
- `:hover` / `:active` / `:disabled` now consistent across `.nav-button`,
  `.secondary-button`, `.secondary-select`, `.record-button`
  (`cursor: not-allowed` + a single disabled opacity), with subtle
  background/border transitions.

### 5. Empty states were bare text **[safe]**

`.empty-state` was a lone muted paragraph — easy to miss in a dense panel.

**Done:** `.empty-state` is now a quiet dashed inset (centered, muted) — a clear
"nothing here yet" affordance that stays sober and non-decorative. Copy is
unchanged.

### 6. Dead CSS **[safe]**

Removed rules no longer referenced by any JSX: DicTeX `.transcript-panel` (the
last-transcript panel was renamed during the slim) and `.normalized-preview*`
(the inline normalized-preview block was removed).

---

## Proposals — need a product call (NOT implemented)

These are on-direction ideas but involve layout/interaction/wording judgment, so
they are left for the human to greenlight rather than shipped in a "safe" pass.

### A. Formalize a typographic scale

Font sizes are still a scattered set of one-offs (0.62 → 1.15rem). Colors,
spacing, and radius are now tokens; type is not. Proposal: add
`--text-xs … --text-lg` tokens and map the existing sizes onto ~5 steps. Low
risk but touches nearly every rule, so it wants a deliberate green light.

### B. Idle DicTeX Home is mostly placeholder

Before the first dictation, the 4×2 diagnostics grid is eight `-` cells and the
last-transcript panel says "Waiting for dictation…". It reads emptier than it
needs to.

```
current (idle)                    proposal (idle)
┌ Engine  Model  Lang  Latency ┐  ┌ Ready — press Win+Alt+Space or Hold ┐
│  -       -      -      -      │  │ Engine faster-whisper · Model base  │
│ Session Segment Audio Output │  │ (diagnostics fill in after first run)│
│  -       -      -      -      │  └──────────────────────────────────────┘
```

Options: dim/collapse empty metrics until first use, or seed engine/model/lang
from config (already known) so only the run-specific cells show `-`. This changes
what Home shows at rest → product call.

### C. Footer actions on Home

The footer is four equal-weight buttons (data folder / events log / dictionary /
rules). Fine, but as more shortcuts appear it will sprawl. Proposal: a compact
labelled toolbar, or promote dictionary/rules (edited often) and tuck
folder/log behind a single "Open data…". Needs a call on which are primary.

### D. Unify the navigation model across apps

DicTeX Home has one big "Open Lab" button; the Lab's Segments view has a 2-up
"Benchmark / Dataset" nav grid and each sub-view has its own back control. The
patterns are close but not identical. A single shared nav convention (e.g. a
consistent back affordance + entry grid) would make the two apps feel like one
product. Structural → product call.

### E. Lab data-folder panel could collapse once configured

On the Segments view the read-only data-folder panel (path + choose/apply/reset/
open) is a large always-expanded block, even though it is a set-once concern.
Proposal: collapse it to a one-line summary with an "edit" affordance after it is
valid. Changes information hierarchy → product call.

### F. Record-button interaction wording

The record button reads "Hold to dictate / Release to transcribe" (push-to-hold),
while the documented primary path is the `Win+Alt+Space` **toggle**. Worth a
product look at whether the on-screen affordance and the hotkey should present
the same mental model. Not a CSS change.

### G. Light theme — explicitly deferred

Both apps are dark-only by design (product-decisions "UI Direction"). A light
theme is out of the current direction and should only happen behind its own
issue. Noted here so it isn't mistaken for an oversight.

---

## Out of scope (untouched here)

- The Open Lab launcher / dead-code cleanup — that was #83.
- The dataset-builder **functional** flow — that is #85, sequenced after this PR
  and rebased on top. This PR only renamed the builder's header wrapper class to
  the shared `.panel-header`; it changed no builder logic, fields, or data.
