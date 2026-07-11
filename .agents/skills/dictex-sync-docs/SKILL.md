---
name: dictex-sync-docs
description: Synchroniser la documentation globale de DicTeX après une vague de PR fusionnées, depuis GitHub et `origin/main`, puis publier une PR documentaire isolée en français. Utiliser pour corriger les états, priorités, portes de sortie et liens devenus faux ; ne pas remplacer la documentation fonctionnelle qui doit accompagner chaque PR de code.
---

# Synchroniser la documentation globale

## Entrée

Recevoir une liste de PR/issues fusionnées ou une vague à auditer. Si elle manque, demander uniquement cette portée.

## Garde d'entrée

1. Lire intégralement `AGENTS.md`, `README.md`, `docs/roadmap.md`, `CONTRIBUTING.md`, `docs/product-decisions.md`, `docs/development.md` et `docs/agent-workflow.md`.
2. Vérifier GitHub en direct et `origin/main`. Ne pas documenter comme livré un travail seulement ouvert ou en revue.
3. Si un changement fonctionnel non fusionné manque de documentation, le renvoyer vers sa PR au lieu de le réparer ici.

## Synchronisation

1. Créer un clone frais depuis `origin/main`, une branche documentaire et une seule PR.
2. Corriger uniquement les états devenus faux, l'ordre de la roadmap, les portes de sortie, les décisions durables, les commandes et les liens.
3. Préserver les documents de pivot comme archives historiques ; ne pas réécrire l'histoire pour la faire ressembler à l'état courant.
4. Garder code produit et interface hors périmètre.
5. Vérifier les liens, la cohérence entre documents et le diff.
6. Rédiger documentation, commit et PR en français, pousser et ouvrir la PR.

## Point d'arrêt

S'arrêter après le lien de la PR documentaire, les documents touchés et les vérifications. Donner la commande exacte d'une session neuve de revue. Ne pas fusionner.
