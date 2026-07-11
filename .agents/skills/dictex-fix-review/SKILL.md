---
name: dictex-fix-review
description: Corriger les bloquants d'une revue DicTeX sur la branche et dans la PR existantes, avec tests, documentation affectée, push et demande de nouvelle revue. Utiliser lorsqu'une PR porte `review:needs-improvement` ; ne pas ouvrir une PR de remplacement, s'auto-revoir ou fusionner.
---

# Corriger une revue DicTeX

## Entrée

Recevoir un numéro de PR. S'il manque, demander uniquement ce numéro.

## Garde d'entrée

1. Lire intégralement `AGENTS.md`, `CONTRIBUTING.md`, `docs/development.md` et `docs/agent-workflow.md`, puis la PR, l'issue et le dernier verdict NEEDS IMPROVEMENT.
2. Vérifier `review:needs-improvement`, le SHA examiné et le SHA actuel. Si des commits non couverts ont rendu la revue ambiguë, s'arrêter et demander une nouvelle revue avant de corriger.
3. Vérifier que le modèle et l'effort actifs conviennent au niveau de l'issue.

## Correction

1. Créer un clone frais et extraire la branche distante de la PR existante. Ne créer ni nouvelle branche fonctionnelle ni nouvelle PR.
2. Corriger uniquement B1/B2 et leurs conséquences nécessaires. Éviter tout refactoring ou ajout hors périmètre.
3. Ajouter les tests demandés et exécuter les contrôles pertinents.
4. Si les corrections modifient le comportement, le contrat ou la roadmap, resynchroniser les documents affectés dans la même PR. Ne produire aucun changement documentaire artificiel.
5. Vérifier le diff, committer et pousser en français sur la branche de la PR.
6. Attendre la CI ou signaler précisément ce qui reste indisponible.
7. Commenter la correspondance `B1 → commit / test / documentation`, retirer `review:needs-improvement` et `review:ready`, puis ajouter `review:recheck`.

## Point d'arrêt

S'arrêter après le push, le commentaire et `review:recheck`. Donner la commande exacte d'une session neuve `$dictex-rereview` ou `/dictex-rereview`. Ne pas déclarer sa propre correction valide et ne pas fusionner.
