# AGENTS.md

Consignes du dépôt pour les agents qui travaillent sur DicTeX.

Ce fichier est le noyau systématiquement chargé par chaque session d'agent :
il ne garde que les invariants qui n'ont pas déjà un emplacement canonique.
Les détails vivent dans les références ci-dessous et ne sont consultés qu'à la
demande, selon la tâche en cours.

## Lecture prioritaire

- `README.md` — vue d'ensemble et principes.
- `docs/roadmap.md` (**source canonique de l'ordre des travaux et des portes
  de sortie**).
- `docs/agent-workflow.md` (**rôles, modèles, points d'arrêt, niveaux de
  raisonnement et dépendances entre issues**).
- `CONTRIBUTING.md` (**langue et conventions de contribution**).
- `docs/product-decisions.md` — décisions produit durables.
- `docs/development.md` — état réellement implémenté, commandes, schémas
  d'événements.
- `docs/vision.md`, `docs/architecture.md`, `docs/mvp.md` et
  `docs/correction-loop.md` — vision, architecture, périmètre MVP et boucle de
  correction, à jour et en français.
- `docs/principes-des-conventions.md` et `docs/questions-de-conventions.md`
  avant de créer ou modifier des exemples de couche 1 / couche 2, une
  verbalisation canonique ou une commande de dictée ;
- `docs/dataset-and-normalization-design.md` avant de modifier un type de
  correction, une couche du normaliseur ou un champ d'export ;
- `docs/completed-work.md` — historique des issues fermées ; référence
  ponctuelle, pas une lecture obligatoire par défaut ;
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

## Direction actuelle

`docs/roadmap.md` est l'unique source canonique de l'ordre des travaux ; ce
fichier ne recopie plus l'étape courante pour éviter qu'elle ne s'y périme.
Toujours vérifier l'état GitHub en direct (issues, labels, PR) avant d'agir :
une photographie locale peut avoir vieilli.

## Contexte produit

DicTeX est une couche locale de dictée pour l'écriture scientifique, pas un
éditeur de documents. Le problème, la forme du produit et les principes sont
détaillés dans `docs/vision.md` ; le flux actuel et cible, la frontière
DicTeX/Lab et le modèle de données sont détaillés dans `docs/architecture.md`.
Ne pas les dupliquer ici.

## Git Workflow

Main repo:

```text
C:\Users\souid\DicTeX
https://github.com/sensopensource/DicTeX
```

Invariant :

```text
one agent = one clone = one folder = one branch = one PR
```

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
`AGENTS.md` et le ticket attribué. Faire tout le travail dans ce dossier,
pousser la branche et ouvrir une demande de fusion en français ; ne pas
fusionner.

Depuis le 10 juillet 2026, le sujet et le corps des commits, le titre et la
description des tickets et des demandes de fusion sont en français. Les noms
de branches restent des identifiants ASCII ; utiliser un slug français sans
accent lorsqu'il reste clair.

La documentation directement affectée évolue dans cette même PR. Un Fixer
pousse ses corrections sur la branche et dans la PR existantes ; il n'ouvre
pas de PR de remplacement. Le protocole complet et les skills invocables
vivent dans `docs/agent-workflow.md`.

## Skills de rôle

Les contrats canoniques versionnés se trouvent dans `.agents/skills/` et sont
invoqués dans Codex avec `$dictex-…`. Les façades Claude Code vivent dans
`.claude/skills/`, s'invoquent avec `/dictex-…` et renvoient vers les mêmes
contrats afin d'éviter toute divergence. Lancer l'outil depuis la racine du
dépôt pour qu'il découvre ces skills.

Les sept rôles sont : orchestration, implémentation, revue, correction de
revue, nouvelle revue, contrôle avant fusion et synchronisation documentaire.
Leur état vivant et leur point d'arrêt sont intégrés ; l'utilisateur ne
fournit que le numéro d'issue/PR et les contraintes exceptionnelles. Le
routage des modèles par niveau, la grille de notation à cinq axes et le
mécanisme de dépendances entre issues (ligne `Depends on:`) sont canoniques
dans `docs/agent-workflow.md` — ne pas les dupliquer ici.

## Nuance importante

La perte de données est un échec produit. Toujours préserver l'audio, le texte
STT brut, la sortie de chaque couche, les résultats de mesure et les
corrections humaines. Lorsqu'une fonctionnalité change la génération, conserver
assez d'intermédiaires pour identifier précisément la couche fautive.
