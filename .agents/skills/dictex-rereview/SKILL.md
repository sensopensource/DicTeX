---
name: dictex-rereview
description: Revoir indépendamment une PR DicTeX après correction, depuis le SHA du verdict précédent jusqu'au nouveau HEAD, puis rendre un nouveau verdict et mettre à jour les labels. Utiliser sur `review:recheck` dans une session neuve distincte du Fixer ; rester en lecture seule et ne jamais fusionner.
---

# Revoir une PR après correction

## Entrée

Recevoir un numéro de PR. S'il manque, demander uniquement ce numéro.

## Garde d'entrée

1. Confirmer que la session n'est pas celle du Fixer ni de l'implémenteur.
2. Lire intégralement `AGENTS.md`, `docs/agent-workflow.md` et les documents produit touchés par la PR.
3. Lire la PR, `review:recheck`, le dernier verdict NEEDS IMPROVEMENT, son SHA, la réponse du Fixer, le nouveau HEAD, la CI et les validations manuelles.
4. Vérifier que le niveau de revue actif convient aux labels de la PR ; sinon s'arrêter avec les commandes exactes de relance.

## Nouvelle revue

1. Examiner le diff entre le SHA précédemment jugé et le HEAD.
2. Vérifier chaque B1/B2, les tests, la documentation affectée et les invariants globaux réellement exposés par les corrections.
3. Ne corriger aucun fichier et ne pousser aucun commit.
4. Recharger le HEAD avant le verdict ; recommencer si le SHA a changé.
5. Si tout est résolu, commenter `Verdict — READY` ancré au nouveau SHA, ajouter `review:ready` et retirer `review:recheck`, `review:needs-improvement` et `question`.
6. Sinon commenter `Verdict — NEEDS IMPROVEMENT` avec uniquement les bloquants restants ou nouveaux, ajouter `review:needs-improvement` et retirer `review:ready` et `review:recheck`.

## Point d'arrêt

S'arrêter après le nouveau verdict et donner la commande exacte du merge gate ou du Fixer. Ne jamais fusionner.
