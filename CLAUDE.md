# CLAUDE.md

Les consignes destinées aux agents de ce dépôt se trouvent dans `AGENTS.md`.
Elles s'appliquent intégralement aux sessions Claude Code.

Avant d'agir, lire en priorité :

- `AGENTS.md` pour le protocole de travail et les invariants ;
- `docs/roadmap.md` pour la direction actuelle ;
- `docs/agent-workflow.md` pour les rôles, modèles et points d'arrêt ;
- `CONTRIBUTING.md` pour la convention de langue ;
- `docs/product-decisions.md` pour les décisions produit ;
- le ticket concerné et ses dépendances.

Les anciens pivots expliquent l'histoire du projet, mais ne remplacent pas la
feuille de route actuelle. Le versionnage et la documentation sont en français ;
le code, les commentaires techniques, les tests, les journaux et l'interface
restent en anglais.

Les skills Claude Code du dépôt se trouvent dans `.claude/skills/`. Lancer
Claude Code depuis la racine du dépôt, puis invoquer directement un rôle, par
exemple `/dictex-implement 114` ou `/dictex-review 117`. Ces façades lisent les
contrats canoniques de `.agents/skills/` ; ne pas dupliquer leurs règles ici.
