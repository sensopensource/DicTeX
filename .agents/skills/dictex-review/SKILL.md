---
name: dictex-review
description: Effectuer une revue indépendante et en lecture seule d'une PR DicTeX, ancrée à un SHA, puis commenter un verdict READY, NEEDS IMPROVEMENT ou question et mettre à jour les labels de revue. Utiliser dans une session neuve qui n'a pas implémenté ni corrigé la PR ; ne jamais modifier les fichiers ou fusionner.
---

# Revoir une PR DicTeX

## Entrée

Recevoir un numéro de PR. S'il manque, demander uniquement ce numéro.

## Garde d'entrée

1. Confirmer que la session n'a ni implémenté ni corrigé cette PR. Sinon exiger une session neuve.
2. Lire intégralement `AGENTS.md`, `docs/roadmap.md`, `CONTRIBUTING.md`, `docs/product-decisions.md`, `docs/development.md` et `docs/agent-workflow.md`.
3. Lire en direct la PR, l'issue liée, les labels, le diff complet, les commits, les tests, la CI et les validations manuelles annoncées.
4. Relever le SHA de tête. Si `needs:high-review` ou un niveau très élevé exige un modèle supérieur à celui de la session, s'arrêter avant le verdict avec les commandes exactes de relance.

## Revue

1. Vérifier les critères d'acceptation, les invariants produit et de données, les régressions, la sécurité, les tests et la documentation affectée — ou la justification explicite de son absence.
2. Ne corriger aucun fichier, ne pousser aucun commit et ne fusionner rien.
3. Recharger le SHA juste avant de publier. S'il a changé, recommencer l'examen du nouveau SHA avant tout verdict.
4. Publier un commentaire français ancré au SHA :
   - `Verdict — READY` : résumé court, preuves et risque résiduel ;
   - `Verdict — NEEDS IMPROVEMENT` : bloquants numérotés B1/B2, risque concret, comportement attendu, plan d'implémentation net et tests de nouvelle revue ;
   - `Verdict — QUESTION` : décision produit manquante, options et conséquences sans choisir.
5. Maintenir un seul état cohérent :
   - READY : ajouter `review:ready`, retirer `review:needs-improvement`, `review:recheck` et `question` ;
   - NEEDS IMPROVEMENT : ajouter `review:needs-improvement`, retirer `review:ready` et `review:recheck` ;
   - QUESTION : ajouter `question`, retirer `review:ready` et `review:recheck`.

## Point d'arrêt

S'arrêter après le commentaire et les labels. Donner la commande exacte du rôle suivant : merge gate, Fixer ou arbitrage humain. Ne jamais fusionner.
