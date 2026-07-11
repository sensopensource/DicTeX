# Contribuer à DicTeX

## Langue du projet

À compter du 10 juillet 2026, les artefacts liés au versionnage et au pilotage
du projet sont rédigés en français :

- messages et descriptions de commits Git ;
- titres, descriptions et commentaires des tickets GitHub ;
- titres, descriptions et revues des demandes de fusion ;
- documentation, notes de décision et notes de version.

L'historique antérieur n'a pas à être traduit rétroactivement. Lorsqu'une
ancienne section anglaise est réécrite en profondeur, sa nouvelle version doit
être en français.

Le produit et le code restent en anglais pour l'instant : code source,
identifiants, commentaires techniques, tests, journaux, diagnostics et textes
visibles dans l'interface. Restent également en anglais les noms d'API et de
bibliothèques, champs de schéma, chemins, commandes, sorties d'outils,
étiquettes existantes et syntaxes imposées. La ligne de dépendance des tickets
conserve notamment sa forme exacte :

```text
Depends on: #105, #96
```

Dans la documentation française, un terme technique anglais peut être conservé
lorsqu'il est plus précis ou correspond exactement au code.

## Avant une modification

Lire au minimum :

- `AGENTS.md` ;
- `docs/roadmap.md` ;
- `docs/agent-workflow.md` ;
- `docs/product-decisions.md` ;
- `docs/development.md` ;
- le ticket concerné, le cas échéant.

La feuille de route donne l'ordre stratégique. L'état GitHub en direct donne
l'état réel des tickets et de leurs dépendances.

## Ticket GitHub

Un nouveau ticket utilise, selon le besoin :

- **Objectif** ;
- **Pourquoi** ;
- **Périmètre** ;
- **Hors périmètre** ;
- **Critères d'acceptation** ;
- **Niveau de raisonnement**.

Ajouter `Depends on:` uniquement pour une dépendance dure, c'est-à-dire un
ticket qui doit être fermé avant de commencer. Une préférence d'ordre ou un
risque de conflit de fichiers est une note, pas une dépendance dure.

## Commits et demandes de fusion

Le sujet d'un commit est court, impératif et en français. Exemples :

```text
Ajouter l'interrupteur du normaliseur
Maintenir le modèle STT en mémoire
Documenter la comparaison des contextes initiaux
```

Une demande de fusion explique le résultat, le périmètre, les validations
effectuées et les risques qui restent. Le code, les tests et la documentation
directement concernée évoluent ensemble. Si aucune documentation ne change, la
PR indique `Documentation non requise : <raison>`.

Lorsqu'une revue demande des corrections, le Fixer pousse dans la branche et
la PR existantes. Il n'ouvre pas de PR de remplacement et une nouvelle session
indépendante revoit ensuite le nouveau SHA.

Le flux d'agents, les points d'arrêt et le routage des modèles sont définis dans
`docs/agent-workflow.md`, sous les invariants d'`AGENTS.md`.
