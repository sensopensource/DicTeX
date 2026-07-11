---
name: dictex-orchestrate
description: Orchestrer la prochaine vague de travail DicTeX à partir de la vision, de la documentation, de l'historique et de l'état GitHub vivant. Utiliser pour challenger une direction, découper ou mettre à jour des tickets, fixer les dépendances, attribuer les niveaux et modèles Codex/Claude, puis produire un plan de lancement sans implémenter.
---

# Orchestrer DicTeX

## Entrée

Recevoir un objectif, une décision à challenger ou un nombre de prochains tickets. Si la direction ou l'autorité produit manque, mener un court dialogue avant toute mutation GitHub.

## Procédure

1. Lire intégralement `AGENTS.md`, `docs/roadmap.md`, `CONTRIBUTING.md`, `docs/product-decisions.md` et `docs/agent-workflow.md`.
2. Vérifier GitHub en direct, `origin/main`, les PR ouvertes et l'historique récent pertinent. Ne jamais prendre le checkout local pour source de vérité.
3. Distinguer les décisions déjà figées, les erreurs de documentation, les idées au parking et les choix qui invalideraient des données futures.
4. Challenger la demande. Ne construire une abstraction que si elle bloque la porte de sortie courante.
5. Réutiliser ou mettre à jour un ticket existant avant d'en créer un nouveau.
6. Rédiger chaque ticket en français avec : Objectif, Pourquoi, Périmètre, Hors périmètre, Critères d'acceptation, Niveau de raisonnement et, si nécessaire, la ligne exacte `Depends on: #…`.
7. Appliquer un label `level:*`, éventuellement `needs:high-review`, et citer les recommandations exactes Codex et Claude définies dans `docs/agent-workflow.md`.
8. Signaler séparément les conflits mous de fichiers ; ne pas les transformer en dépendances dures.
9. Produire des vagues de lancement et, pour chaque ticket prêt, la commande exacte de la prochaine session dans Codex et Claude Code.

## Point d'arrêt

S'arrêter après le rapport d'orchestration et les liens des tickets créés ou modifiés. Ne modifier aucun fichier produit, ne créer aucune branche d'implémentation et ne fusionner rien.
