# Contribuer à DicTeX

## Langue du projet

À compter du 10 juillet 2026, les nouveaux artefacts humains du projet sont
rédigés en français :

- messages et descriptions de commits Git ;
- titres, descriptions et commentaires des tickets GitHub ;
- titres, descriptions et revues des demandes de fusion ;
- documentation et notes de décision ;
- textes visibles dans l'interface ;
- comptes rendus et transmissions entre agents.

L'historique antérieur n'a pas à être traduit rétroactivement. Lorsqu'une
ancienne section anglaise est réécrite en profondeur, sa nouvelle version doit
être en français.

L'anglais reste permis lorsqu'il est nécessaire à la précision ou au
fonctionnement : identifiants de code, noms d'API et de bibliothèques, champs de
schéma, chemins, commandes, sorties d'outils, étiquettes existantes et syntaxe
imposée. La ligne de dépendance des tickets conserve notamment sa forme exacte :

```text
Depends on: #105, #96
```

Un terme technique anglais sans équivalent français clair peut être conservé,
mais le français est préféré dès qu'il reste naturel et précis.

## Avant une modification

Lire au minimum :

- `AGENTS.md` ;
- `docs/roadmap.md` ;
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
concernée évoluent ensemble.

Le flux d'agents et d'isolation des branches est défini dans `AGENTS.md`.
