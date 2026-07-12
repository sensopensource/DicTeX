# DicTeX

DicTeX est un outil local de dictée scientifique, d'abord conçu pour une voix,
un micro et un usage personnel en français.

Il transcrit la parole, conserve l'audio et le texte littéral, applique
facultativement des règles déterministes, puis insère un brouillon mêlant prose
Markdown et mathématiques LaTeX dans l'application active.

## Boucle produit actuelle

```text
voix
-> STT local avec faster-whisper
-> conservation de l'audio et du texte brut
-> normaliseur : dictionnaire personnel, commandes, règles regex
-> texte et mathématiques LaTeX en ligne
-> presse-papiers et collage dans l'application active
```

Le normaliseur produit du LaTeX canonique délimité par `$…$`. Le texte brut et
les sorties intermédiaires restent conservés afin qu'une erreur puisse être
attribuée à la bonne couche.

## Deux applications, un dépôt

Le dépôt est un monorepo npm contenant deux applications Electron :

- **`apps/dictex`** : l'outil quotidien avec microphone, raccourci global,
  transcription, normalisation, historique et collage ;
- **`apps/lab`** : le **DicTeX Lab**, sans microphone, destiné à l'écoute des
  segments, aux corrections typées, aux ensembles d'évaluation, aux mesures et
  aux exports de données.

Les composants partagés se trouvent dans :

- **`packages/engine`** : moteur STT Python ;
- **`packages/shared`** : schémas d'événements, normaliseur, mesures et exports
  TypeScript.

Le Lab lit le dossier de données de DicTeX sans l'écrire et conserve ses propres
corrections, mesures et exports dans son dossier local.

## Direction actuelle

DicTeX reste une couche de dictée : il ne possède pas les documents et ne
devient pas un éditeur complet. **Typora** est le premier cahier de brouillon
réel retenu, avec Zettlr comme solution de repli si une friction concrète
apparaît.

Le chemin immédiat est :

```text
Typora
-> Start/Stop et normaliseur fiables
-> modèle STT maintenu en mémoire
-> comparaison de contextes initiaux STT
-> test complet de correction dans le Lab
-> usage quotidien et collecte propre
-> amélioration des règles
-> entraînement seulement après mesure du résidu
```

La [feuille de route](docs/roadmap.md) est la source canonique pour l'ordre des
travaux et leurs portes de sortie.

## État du projet

Déjà disponible :

- transcription locale faster-whisper, dont l'exécution CUDA sur la machine de
  développement ;
- sélection du modèle STT ;
- raccourci global `Win+Alt+Space` et collage automatique sous Windows ;
- stockage local à ajout uniquement (`append-only`) de l'audio, du texte brut
  et de la normalisation ;
- dictionnaire personnel, mots de commande et règles mathématiques regex ;
- interrupteur persistant du normaliseur, avec sortie STT brute lorsqu'il est
  désactivé ;
- convention LaTeX canonique et canonicalisation avant mesure ou export ;
- historique de dictées avec copie et réécoute ;
- Lab séparé pour les corrections, les comparaisons et les exports ;
- passage d'un `initial_prompt` nommé à faster-whisper pour les expériences.

Prochaines étapes :

- Start/Stop cohérent entre l'interface et le raccourci (#96) ;
- mécanisme explicite pour les mathématiques en bloc `$$…$$` ;
- processus STT persistant afin de ne plus recharger le modèle à chaque dictée ;
- comparaison des variantes de contexte initial sur `validation` (#94) ;
- validation d'un chemin complet de correction et d'export.

## Principes

- local par défaut ;
- entrée vocale française en premier ;
- prose Markdown et mathématiques LaTeX portables ;
- modèle de données centré sur les sessions et les segments, pas sur les
  documents ;
- événements à ajout uniquement et aucune perte d'intermédiaire ;
- correction acoustique séparée de la transformation mathématique ;
- règles déterministes avant modèle appris ;
- `validation` pour les décisions, `test_frozen` une seule fois à la fin ;
- aucun entraînement intégré avant d'avoir battu une référence dans le Lab.

## Développement

Depuis la racine du dépôt, sous Windows :

```powershell
scripts\npm.cmd install
scripts\npm.cmd run typecheck
scripts\npm.cmd test
scripts\npm.cmd run build
scripts\npm.cmd run dev
```

Consulter le [guide de développement](docs/development.md) pour le Lab, Python,
CUDA, les variables d'environnement et les vérifications manuelles.

Le [workflow agentique](docs/agent-workflow.md) définit les rôles séparés
orchestration → implémentation → revue → correction → nouvelle revue → contrôle
avant fusion. Les skills versionnés sont compatibles avec Codex
(`$dictex-…`) et Claude Code (`/dictex-…`).

## Documentation

- [Feuille de route](docs/roadmap.md)
- [Vision](docs/vision.md)
- [Décisions produit](docs/product-decisions.md)
- [Architecture](docs/architecture.md)
- [Conception des données et du normaliseur](docs/dataset-and-normalization-design.md)
- [Questions de conventions ouvertes](docs/questions-de-conventions.md)
- [Boucle de correction](docs/correction-loop.md)
- [Périmètre MVP](docs/mvp.md)
- [Développement](docs/development.md)
- [Workflow agentique Codex et Claude Code](docs/agent-workflow.md)
- [Contribuer et convention de langue](CONTRIBUTING.md)

Les documents de pivot restent disponibles comme historique :
`pivot_dictex_lab_split.md` et `pivot_strategique_stt_normalisation.md`.

## Langue

Depuis le 10 juillet 2026, les commits, tickets, demandes de fusion, revues et
documents sont rédigés en français. Le code source, les commentaires techniques,
les tests, les journaux et l'interface restent en anglais pour l'instant. Les
détails sont définis dans [CONTRIBUTING.md](CONTRIBUTING.md).
