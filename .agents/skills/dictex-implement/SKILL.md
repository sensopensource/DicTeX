---
name: dictex-implement
description: Implémenter une issue DicTeX de bout en bout dans un clone et une branche isolés, avec tests, documentation concernée, commit, push et PR en français. Utiliser lorsqu'un numéro d'issue prêt est fourni ; ne pas utiliser pour corriger une revue existante, revoir sa propre PR ou fusionner.
---

# Implémenter une issue DicTeX

## Entrée

Recevoir un numéro d'issue. S'il manque, demander uniquement ce numéro. Les contraintes exceptionnelles peuvent accompagner l'invocation ; le protocole et le point d'arrêt restent implicites.

## Garde d'entrée

1. Lire l'issue et son état GitHub vivant, ses labels, sa ligne `Depends on:` et les PR qui la référencent.
2. Si une dépendance est ouverte, si une décision produit manque ou si une PR d'implémentation existe déjà, s'arrêter avant toute écriture et indiquer le rôle suivant approprié.
3. Lire intégralement `AGENTS.md`, `README.md`, `docs/roadmap.md`, `CONTRIBUTING.md`, `docs/product-decisions.md`, `docs/development.md` et `docs/agent-workflow.md`.
4. Comparer le label `level:*` au modèle et à l'effort actifs. S'ils sont insuffisants, s'arrêter avant toute écriture avec les commandes exactes de relance Codex et Claude.

## Implémentation

1. Partir de `origin/main` et travailler dans un clone frère neuf, une branche `issue-<N>-<slug>` et une seule PR. Ne jamais modifier le checkout principal.
2. Respecter strictement le périmètre et les critères d'acceptation. Garer toute idée nouvelle.
3. Conserver le code, les tests, les commentaires techniques, les journaux et l'interface en anglais. Rédiger documentation, commit et PR en français.
4. Ajouter les tests proportionnés au risque et exécuter les vérifications pertinentes définies dans `docs/development.md`.
5. Mettre à jour dans cette même PR toute documentation directement affectée. Sinon inscrire dans la PR `Documentation non requise : <raison>`.
6. Vérifier le diff, préserver les changements non liés, committer, pousser et ouvrir la PR liée à l'issue.
7. Suivre la CI. Corriger dans la même PR les échecs causés par l'implémentation ; signaler clairement toute validation manuelle ou indisponibilité externe restante.
8. Si `needs:high-review` est présent, recommander le reviewer Codex et Claude exact sans effectuer la revue.

## Point d'arrêt

S'arrêter après avoir fourni le lien de la PR, son SHA, les tests, l'état de la CI, l'état documentaire et la commande exacte d'une session neuve `$dictex-review` ou `/dictex-review`. Ne pas s'auto-évaluer et ne pas fusionner.
