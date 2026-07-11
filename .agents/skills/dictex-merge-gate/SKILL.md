---
name: dictex-merge-gate
description: Exécuter le contrôle mécanique final d'une PR DicTeX déjà marquée `review:ready` et répondre GO ou NO-GO à partir du SHA, de la CI, des threads, des labels et de la QA. Utiliser juste avant une fusion humaine ; ne modifier aucun fichier, label ou commit et ne jamais fusionner.
---

# Contrôler une PR avant fusion

## Entrée

Recevoir un numéro de PR. S'il manque, demander uniquement ce numéro.

## Contrôle

1. Lire `AGENTS.md` et `docs/agent-workflow.md`.
2. Lire en direct la PR, ses labels, son HEAD, la CI, les revues, les threads et les validations manuelles annoncées.
3. Vérifier toutes les conditions :
   - `review:ready` présent ;
   - aucun `review:needs-improvement`, `review:recheck` ou `question` ;
   - HEAD identique au SHA du dernier verdict READY ;
   - CI obligatoire terminée et verte ;
   - aucun thread bloquant non résolu ;
   - branche à jour avec la base ;
   - revue renforcée explicite si `needs:high-review` ;
   - validation manuelle explicitement terminée lorsqu'elle était obligatoire.
4. Considérer tout nouveau commit, y compris une mise à jour de branche, comme invalidant le verdict READY et exigeant une nouvelle revue.

## Point d'arrêt

Répondre `GO` ou `NO-GO`, suivi d'une checklist factuelle, du SHA et du lien de la PR. Ne rien modifier sur GitHub et ne jamais fusionner : la fusion reste humaine.
